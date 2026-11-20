import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getTyrantUserDirectory } from "./profiles";
import { resolveProjectProfile } from "./profiles";
import { ensureDshPlugin, type DshPluginResult } from "./dsh-runtime";
import { loadInstallState } from "./install-state";
import { installProjectAdapters, VerifiedPinnedSkillBundle, type ProjectAdapterHost } from "../adapters/project-setup";

const OWNER = "thienty1207";
const REPOSITORY = "Tyranitar";
const API_URL = `https://api.github.com/repos/${OWNER}/${REPOSITORY}/releases/latest`;
const RELEASE_ASSET = (version: string) => `tyrant-engine-${version}-windows-x64.zip`;
const RELEASE_RECEIPT = ".tyrant-release.json";
const MAX_RELEASE_BYTES = 256 * 1024 * 1024;

export type SelectedReleaseAsset = { version: string; url: string; sha256: string };
export type ProjectUpdateResult = { project_root: string; status: "updated" | "already_current" | "skipped"; reason?: string };
export type UpdateResult = {
  status: "updated" | "updated_with_gaps" | "up_to_date";
  previous_version: string;
  version: string;
  dsh_plugin?: DshPluginResult;
  projects?: ProjectUpdateResult[];
};

export type ReleaseUpdateOptions = {
  currentVersion?: string;
  currentRoot?: string;
  stateDirectory?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  fetch?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
  installArchive?: (asset: SelectedReleaseAsset, bytes: Uint8Array, stateDirectory: string) => Promise<string>;
  activateVersion?: (version: string, versionRoot: string, stateDirectory: string) => Promise<void>;
  refreshDsh?: (versionRoot: string, env: Record<string, string | undefined>) => Promise<DshPluginResult>;
  refreshProjects?: (versionRoot: string, stateDirectory: string) => Promise<ProjectUpdateResult[]>;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mapProjectsBounded<T, R>(items: readonly T[], mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  }));
  return results;
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

export function selectWindowsReleaseAsset(value: unknown): SelectedReleaseAsset {
  if (!record(value) || value.draft === true) throw new Error("release_not_published");
  if (value.prerelease === true) throw new Error("release_prerelease_unsupported");
  const match = typeof value.tag_name === "string" ? /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(value.tag_name) : null;
  if (!match || !validVersion(match[1])) throw new Error("release_tag_invalid");
  const version = match[1];
  if (!Array.isArray(value.assets)) throw new Error("release_asset_missing");
  const asset = value.assets.find((candidate) => record(candidate) && candidate.name === RELEASE_ASSET(version));
  if (!record(asset)) throw new Error("release_asset_missing");
  if (asset.state !== "uploaded") throw new Error("release_asset_unavailable");
  const digest = typeof asset.digest === "string" ? /^sha256:([a-f0-9]{64})$/i.exec(asset.digest) : null;
  if (!digest) throw new Error("release_digest_missing");
  if (typeof asset.browser_download_url !== "string") throw new Error("release_asset_url_untrusted");
  let url: URL;
  try { url = new URL(asset.browser_download_url); } catch { throw new Error("release_asset_url_untrusted"); }
  const expectedPrefix = `/${OWNER}/${REPOSITORY}/releases/download/v${version}/`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith(expectedPrefix)
    || url.pathname.slice(expectedPrefix.length) !== RELEASE_ASSET(version) || url.username || url.password) {
    throw new Error("release_asset_url_untrusted");
  }
  return { version, url: url.toString(), sha256: digest[1]!.toLowerCase() };
}

export function verifyReleaseDigest(bytes: Uint8Array, value: string): boolean {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(value);
  if (!match) throw new Error("release_digest_invalid");
  const actual = createHash("sha256").update(bytes).digest();
  return timingSafeEqual(actual, Buffer.from(match[1]!, "hex"));
}

export function isSafeArchiveEntry(value: string): boolean {
  if (!value || value.includes("\0")) return false;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.startsWith("//")) return false;
  return normalized.split("/").every((part) => part !== ".." && part !== ".");
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

function packageRoot(): string {
  const configured = process.env.TYRANT_ROOT?.trim();
  return configured ? resolve(configured) : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

async function readInstalledVersion(root: string): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown;
    if (record(manifest) && manifest.name === "tyrant-engine" && validVersion(manifest.version)) return manifest.version;
  } catch {
    // Keep package metadata failures bounded and credential-free.
  }
  throw new Error("installed_package_invalid");
}

function insideDirectory(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function verifyReleaseReceipt(root: string, asset: SelectedReleaseAsset): Promise<void> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(root, RELEASE_RECEIPT), "utf8")) as unknown; }
  catch { throw new Error("release_version_receipt_invalid"); }
  if (!record(value) || value.schema_version !== 1 || value.version !== asset.version
    || value.asset_name !== RELEASE_ASSET(asset.version) || value.sha256 !== asset.sha256) {
    throw new Error("release_version_receipt_invalid");
  }
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function stringEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function runPowerShell(script: string, env: Record<string, string | undefined>): Promise<string> {
  const child = Bun.spawn([
    "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script),
  ], { env: stringEnvironment(env), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error("release_archive_operation_failed");
  return stdout.trim();
}

async function listArchiveEntries(archivePath: string, env: Record<string, string | undefined>): Promise<string[]> {
  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$archive = [System.IO.Compression.ZipFile]::OpenRead($env:TYRANT_RELEASE_ARCHIVE)",
    "try { $names = @($archive.Entries | ForEach-Object { $_.FullName }); ConvertTo-Json -InputObject $names -Compress } finally { $archive.Dispose() }",
  ].join("; ");
  const output = await runPowerShell(script, { ...env, TYRANT_RELEASE_ARCHIVE: archivePath });
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error("release_archive_invalid"); }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error("release_archive_invalid");
  return value as string[];
}

async function extractArchive(archivePath: string, destination: string, env: Record<string, string | undefined>): Promise<void> {
  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$source = [System.IO.Path]::GetFullPath($env:TYRANT_RELEASE_ARCHIVE)",
    "$destination = [System.IO.Path]::GetFullPath($env:TYRANT_RELEASE_STAGE)",
    "[System.IO.Compression.ZipFile]::ExtractToDirectory($source, $destination)",
  ].join("; ");
  await runPowerShell(script, { ...env, TYRANT_RELEASE_ARCHIVE: archivePath, TYRANT_RELEASE_STAGE: destination });
}

async function installDependencies(directory: string, env: Record<string, string | undefined>): Promise<void> {
  const command = env.TYRANT_BUN_PATH?.trim() || Bun.which("bun");
  if (!command) throw new Error("bun_not_detected");
  const child = Bun.spawn([command, "install", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: directory,
    env: stringEnvironment(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [exitCode] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error("release_dependency_install_failed");
}

async function installArchive(
  asset: SelectedReleaseAsset,
  bytes: Uint8Array,
  stateDirectory: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const versionsDirectory = join(stateDirectory, "versions");
  const versionRoot = join(versionsDirectory, asset.version);
  await mkdir(versionsDirectory, { recursive: true });
  let existingVersion;
  try { existingVersion = await lstat(versionRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existingVersion) {
    if (!existingVersion.isDirectory() || existingVersion.isSymbolicLink()) throw new Error("release_version_path_conflict");
    if (await readInstalledVersion(versionRoot) !== asset.version) throw new Error("release_version_path_conflict");
    await verifyReleaseReceipt(versionRoot, asset);
    return versionRoot;
  }

  const temporaryRoot = join(stateDirectory, "staging", `${asset.version}-${crypto.randomUUID()}`);
  const archivePath = join(temporaryRoot, "release.zip");
  const extractedRoot = join(temporaryRoot, "package");
  await mkdir(extractedRoot, { recursive: true });
  try {
    await writeFile(archivePath, bytes, { flag: "wx" });
    const entries = await listArchiveEntries(archivePath, env);
    if (!entries.length || entries.some((entry) => !isSafeArchiveEntry(entry))) throw new Error("release_archive_path_invalid");
    await extractArchive(archivePath, extractedRoot, env);
    if (await readInstalledVersion(extractedRoot) !== asset.version) throw new Error("release_package_version_mismatch");
    await installDependencies(extractedRoot, env);
    await writeFile(join(extractedRoot, RELEASE_RECEIPT), `${JSON.stringify({ schema_version: 1, version: asset.version, asset_name: RELEASE_ASSET(asset.version), sha256: asset.sha256 }, null, 2)}\n`, { flag: "wx" });
    await rename(extractedRoot, versionRoot);
    return versionRoot;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function activateVersion(versionRoot: string, stateDirectory: string): Promise<void> {
  const currentFile = join(stateDirectory, "current.txt");
  const temporaryFile = `${currentFile}.${crypto.randomUUID()}.tmp`;
  const backupFile = `${currentFile}.${crypto.randomUUID()}.bak`;
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(temporaryFile, `${resolve(versionRoot)}\n`, { flag: "wx" });
  let movedOldPointer = false;
  try {
    try {
      const info = await lstat(currentFile);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("release_active_pointer_invalid");
      const previousRoot = resolve((await readFile(currentFile, "utf8")).trim());
      if (!insideDirectory(join(stateDirectory, "versions"), previousRoot)) throw new Error("release_active_pointer_invalid");
      await readInstalledVersion(previousRoot);
      await rename(currentFile, backupFile);
      movedOldPointer = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(temporaryFile, currentFile);
    await rm(backupFile, { force: true });
  } catch {
    await rm(currentFile, { force: true }).catch(() => undefined);
    if (movedOldPointer) await rename(backupFile, currentFile).catch(() => undefined);
    await rm(temporaryFile, { force: true }).catch(() => undefined);
    throw new Error("release_activation_failed");
  }
}

async function refreshDsh(versionRoot: string, stateDirectory: string, env: Record<string, string | undefined>): Promise<DshPluginResult> {
  const state = await loadInstallState({ stateDirectory, env });
  return ensureDshPlugin({ tyrantRoot: versionRoot, profile: env.TYRANT_DSH_PROFILE?.trim() || state.dsh_profile, env });
}

async function refreshRegisteredProjects(
  versionRoot: string,
  stateDirectory: string,
  env: Record<string, string | undefined>,
): Promise<ProjectUpdateResult[]> {
  const state = await loadInstallState({ stateDirectory, env });
  if (!state.projects.length) return [];
  const verifiedSkillBundle = await VerifiedPinnedSkillBundle.load(versionRoot);
  return mapProjectsBounded(state.projects, async (project) => {
    try {
      const selected = await resolveProjectProfile(project.project_root, { stateDirectory, env, platform: "win32" });
      if (!selected) {
        return { project_root: project.project_root, status: "skipped", reason: "project_binding_missing" };
      }
      const options = {
        projectRoot: project.project_root,
        tyrantRoot: versionRoot,
        hosts: project.hosts as ProjectAdapterHost[],
        profileGuidance: {
          profileId: selected.profile.id,
          profileName: selected.profile.name,
          workspace: selected.binding.scope.workspace,
          project: selected.binding.scope.project,
        },
        allowManagedUpgrade: true,
        verifiedSkillBundle,
      };
      // installProjectAdapters revalidates every ownership/hash gate before any write.
      // A separate preview would scan the pinned skill bundle twice without strengthening the transaction.
      const result = await installProjectAdapters(options);
      if (result.status === "installed" || result.status === "already_configured") {
        return { project_root: project.project_root, status: result.status === "already_configured" ? "already_current" : "updated" };
      }
      return { project_root: project.project_root, status: "skipped", reason: result.status === "conflict" ? "project_adapter_conflict" : "project_adapter_incomplete" };
    } catch (error) {
      return { project_root: project.project_root, status: "skipped", reason: safeFailure(error) };
    }
  });
}

function safeFailure(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]{1,100}$/i.test(error.message)) return error.message;
  return "release_update_failed";
}

export const RELEASE_UPDATE_METADATA_URL = API_URL;

export async function updateTyrant(options: ReleaseUpdateOptions = {}): Promise<UpdateResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") throw new Error("release_update_platform_unsupported");
  const env = options.env ?? process.env;
  const stateDirectory = resolve(options.stateDirectory ?? getTyrantUserDirectory(env, platform));
  const currentVersion = options.currentVersion ?? await readInstalledVersion(resolve(options.currentRoot ?? packageRoot()));
  if (!validVersion(currentVersion)) throw new Error("installed_package_invalid");
  const fetcher = options.fetch ?? fetch;
  let metadataResponse: Response;
  try { metadataResponse = await fetcher(API_URL, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Tyrant-Engine" }, signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error("release_metadata_fetch_failed"); }
  if (!metadataResponse.ok) throw new Error("release_metadata_fetch_failed");
  let metadata: unknown;
  try { metadata = await metadataResponse.json(); } catch { throw new Error("release_metadata_invalid"); }
  const asset = selectWindowsReleaseAsset(metadata);
  if (compareVersions(asset.version, currentVersion) <= 0) return { status: "up_to_date", previous_version: currentVersion, version: currentVersion };

  let archiveResponse: Response;
  try { archiveResponse = await fetcher(asset.url, { headers: { "User-Agent": "Tyrant-Engine" }, signal: AbortSignal.timeout(120_000) }); }
  catch { throw new Error("release_download_failed"); }
  if (!archiveResponse.ok) throw new Error("release_download_failed");
  const advertisedLength = Number(archiveResponse.headers.get("content-length") ?? 0);
  if (advertisedLength > MAX_RELEASE_BYTES) throw new Error("release_asset_too_large");
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await archiveResponse.arrayBuffer()); }
  catch { throw new Error("release_download_failed"); }
  if (bytes.byteLength > MAX_RELEASE_BYTES) throw new Error("release_asset_too_large");
  if (!verifyReleaseDigest(bytes, `sha256:${asset.sha256}`)) throw new Error("release_digest_mismatch");
  const versionRoot = await (options.installArchive ?? ((selected, archive, state) => installArchive(selected, archive, state, env)))(asset, bytes, stateDirectory);
  await (options.activateVersion ?? ((version, root, state) => activateVersion(root, state)))(asset.version, versionRoot, stateDirectory);

  let dshPlugin: DshPluginResult;
  try { dshPlugin = await (options.refreshDsh ?? ((root, currentEnv) => refreshDsh(root, stateDirectory, currentEnv)))(versionRoot, env); }
  catch { dshPlugin = { status: "not_detected", profile: env.TYRANT_DSH_PROFILE?.trim() || "desktop" }; }
  let projects: ProjectUpdateResult[] | undefined;
  try { projects = await (options.refreshProjects ?? ((root, directory) => refreshRegisteredProjects(root, directory, env)))(versionRoot, stateDirectory); }
  catch { projects = [{ project_root: "", status: "skipped", reason: "project_refresh_failed" }]; }
  const dshGap = dshPlugin.status === "not_detected";
  const projectGap = projects?.some((project) => project.status === "skipped") ?? false;
  return {
    status: dshGap || projectGap ? "updated_with_gaps" : "updated",
    previous_version: currentVersion,
    version: asset.version,
    dsh_plugin: dshPlugin,
    ...(projects ? { projects } : {}),
  };
}
