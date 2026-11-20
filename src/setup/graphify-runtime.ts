import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { getTyrantUserDirectory } from "./profiles";

export const GRAPHIFY_PINNED_VERSION = "0.9.109";
export const UV_PINNED_VERSION = "0.13.7";
const UV_ARCHIVE_URL = `https://releases.astral.sh/github/uv/releases/download/${UV_PINNED_VERSION}/uv-x86_64-pc-windows-msvc.zip`;
const UV_ARCHIVE_SHA256 = "0cdc5b38fe5a8168ed6a25814f5ba43c21d313dd3187314fccb37b7cec46e021";
const UV_MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const execFile = promisify(execFileCallback);
const SECRET_ENVIRONMENT_KEY = /(?:API[_-]?KEY|(?:^|[_-])(?:ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|AUTH[_-]?TOKEN|SESSION[_-]?TOKEN|TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS?|DATABASE_URL|BASE[_-]?URL)(?:$|[_-])|^UV_)/i;

export type GraphifyRuntimeStatus = {
  status: "ready" | "missing" | "version_mismatch";
  source?: "system" | "managed";
  version?: string;
  executable?: string;
};

export type GraphifyCommandResult = { exitCode: number; stdout: string; stderr?: string };
export type GraphifyRuntimeOptions = {
  stateDirectory?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  arch?: string;
  graphifyExecutable?: string | null;
  uvExecutable?: string | null;
  runCommand?: (executable: string, args: string[], env?: Record<string, string>, timeoutMs?: number) => Promise<GraphifyCommandResult>;
  bootstrapUv?: (stateDirectory: string, platform: NodeJS.Platform, arch: string) => Promise<string>;
  fetcher?: typeof fetch;
};

function userStateDirectory(options: GraphifyRuntimeOptions): string {
  if (options.stateDirectory?.trim()) return resolve(options.stateDirectory);
  return getTyrantUserDirectory(options.env ?? process.env, options.platform ?? process.platform);
}

function managedGraphifyRoot(stateDirectory: string): string {
  return join(stateDirectory, "runtimes", "graphify", GRAPHIFY_PINNED_VERSION);
}

function managedGraphifyExecutable(stateDirectory: string, platform: NodeJS.Platform): string {
  return join(managedGraphifyRoot(stateDirectory), "bin", platform === "win32" ? "graphify.exe" : "graphify");
}

function configuredGraphifyExecutable(options: GraphifyRuntimeOptions): { path?: string; explicit: boolean } {
  if (options.graphifyExecutable !== undefined) { const path = options.graphifyExecutable?.trim() || undefined; return { path, explicit: Boolean(path) }; }
  const configured = options.env?.TYRANT_GRAPHIFY_BIN?.trim() || process.env.TYRANT_GRAPHIFY_BIN?.trim();
  if (configured) return { path: configured, explicit: true };
  return { path: Bun.which("graphify") ?? Bun.which("graphify.exe") ?? undefined, explicit: false };
}

function configuredUvExecutable(options: GraphifyRuntimeOptions): string | undefined {
  if (options.uvExecutable !== undefined) return options.uvExecutable?.trim() || undefined;
  return options.env?.TYRANT_UV_BIN?.trim() || process.env.TYRANT_UV_BIN?.trim()
    || Bun.which("uv") || Bun.which("uv.exe") || undefined;
}

async function defaultRunCommand(executable: string, args: string[], env?: Record<string, string>, timeoutMs = 5_000): Promise<GraphifyCommandResult> {
  try {
    const result = await execFile(executable, args, {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
      timeout: Math.max(250, Math.min(10 * 60_000, timeoutMs)),
      ...(env ? { env } : {}),
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };
    if (typeof value.code === "number") return { exitCode: value.code, stdout: value.stdout ?? "", stderr: value.stderr };
    if (value.code === "ENOENT") return { exitCode: 127, stdout: "" };
    return { exitCode: 1, stdout: value.stdout ?? "", stderr: value.stderr };
  }
}

function sanitizedProbeEnvironment(base: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(base).filter(([key, value]) =>
    value !== undefined && !SECRET_ENVIRONMENT_KEY.test(key))) as Record<string, string>;
}

function parseGraphifyVersion(output: string): string | undefined {
  return output.match(/\bgraphify\s+v?(\d+\.\d+\.\d+)\b/i)?.[1]
    ?? output.match(/^\s*v?(\d+\.\d+\.\d+)\s*$/m)?.[1];
}

function parseUvVersion(output: string): string | undefined {
  return output.match(/\buv\s+(\d+\.\d+\.\d+)\b/i)?.[1];
}

async function readVersion(
  executable: string,
  runCommand: NonNullable<GraphifyRuntimeOptions["runCommand"]>,
  env: Record<string, string>,
): Promise<string | undefined> {
  const result = await runCommand(executable, ["--version"], env, 5_000);
  if (result.exitCode !== 0) return undefined;
  return parseGraphifyVersion(result.stdout);
}

export async function graphifyRuntimeStatus(options: GraphifyRuntimeOptions = {}): Promise<GraphifyRuntimeStatus> {
  const stateDirectory = userStateDirectory(options);
  const runCommand = options.runCommand ?? defaultRunCommand;
  const probeEnv = sanitizedProbeEnvironment(options.env ?? process.env);
  const configured = configuredGraphifyExecutable(options);
  if (configured.explicit) {
    if (!configured.path) return { status: "missing" };
    const version = await readVersion(configured.path, runCommand, probeEnv);
    if (!version) return { status: "missing", executable: configured.path };
    return version === GRAPHIFY_PINNED_VERSION
      ? { status: "ready", source: "system", version, executable: configured.path }
      : { status: "version_mismatch", source: "system", version, executable: configured.path };
  }

  const systemExecutable = configured.path;
  const systemVersion = systemExecutable ? await readVersion(systemExecutable, runCommand, probeEnv) : undefined;
  if (systemExecutable && systemVersion === GRAPHIFY_PINNED_VERSION) {
    return { status: "ready", source: "system", version: systemVersion, executable: systemExecutable };
  }

  const managedExecutable = managedGraphifyExecutable(stateDirectory, options.platform ?? process.platform);
  const managedVersion = existsSync(managedExecutable) ? await readVersion(managedExecutable, runCommand, probeEnv) : undefined;
  if (managedVersion === GRAPHIFY_PINNED_VERSION) {
    return { status: "ready", source: "managed", version: managedVersion, executable: managedExecutable };
  }
  if (existsSync(managedExecutable) && managedVersion) {
    return { status: "version_mismatch", source: "managed", version: managedVersion, executable: managedExecutable };
  }
  if (systemExecutable && systemVersion) {
    return { status: "version_mismatch", source: "system", version: systemVersion, executable: systemExecutable };
  }
  return { status: "missing" };
}

function managedUvExecutable(stateDirectory: string, platform: NodeJS.Platform): string {
  return join(stateDirectory, "runtimes", "uv", UV_PINNED_VERSION, platform === "win32" ? "uv.exe" : "uv");
}

export function buildUvExtractionCommand(): string {
  return "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:TYRANT_UV_ARCHIVE, $env:TYRANT_UV_EXTRACT_TO); $files = @(Get-ChildItem -LiteralPath $env:TYRANT_UV_EXTRACT_TO -Recurse -File -Filter 'uv.exe'); if ($files.Count -ne 1) { exit 21 }; Copy-Item -LiteralPath $files[0].FullName -Destination $env:TYRANT_UV_OUTPUT";
}

function managedUvEnvironment(stateDirectory: string, graphifyRoot: string, base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !SECRET_ENVIRONMENT_KEY.test(key)) env[key] = value;
  }
  env.UV_TOOL_DIR = join(graphifyRoot, "tools");
  env.UV_TOOL_BIN_DIR = join(graphifyRoot, "bin");
  env.UV_CACHE_DIR = join(stateDirectory, "runtimes", "uv-cache");
  env.UV_PYTHON_INSTALL_DIR = join(stateDirectory, "runtimes", "python");
  env.UV_PYTHON_BIN_DIR = join(stateDirectory, "runtimes", "python-bin");
  env.UV_PYTHON_PREFERENCE = "only-managed";
  env.UV_PYTHON_DOWNLOADS = "automatic";
  return env;
}

async function bootstrapUv(stateDirectory: string, platform: NodeJS.Platform, arch: string, fetcher: typeof fetch): Promise<string> {
  if (platform !== "win32" || arch !== "x64") throw new Error("uv_bootstrap_platform_unsupported");
  const root = join(stateDirectory, "runtimes", "uv");
  const destination = join(root, UV_PINNED_VERSION);
  const executable = join(destination, "uv.exe");
  if (existsSync(executable)) return executable;
  if (existsSync(destination)) throw new Error("uv_managed_state_conflict");
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, `.install-${randomUUID()}-`));
  try {
    let response: Response;
    try {
      response = await fetcher(UV_ARCHIVE_URL, { signal: AbortSignal.timeout(60_000), redirect: "follow" });
    } catch {
      throw new Error("uv_download_failed");
    }
    if (!response.ok) throw new Error("uv_download_failed");
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > UV_MAX_DOWNLOAD_BYTES) throw new Error("uv_archive_too_large");
    const archive = new Uint8Array(await response.arrayBuffer());
    if (archive.length > UV_MAX_DOWNLOAD_BYTES) throw new Error("uv_archive_too_large");
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== UV_ARCHIVE_SHA256) throw new Error("uv_checksum_mismatch");

    const archivePath = join(staging, "uv.zip");
    const extractionPath = join(staging, "extract");
    const stagedExecutable = join(staging, "uv.exe");
    await writeFile(archivePath, archive, { flag: "wx" });
    await mkdir(extractionPath);
    const extractionEnv = {
      ...sanitizedProbeEnvironment(process.env),
      TYRANT_UV_ARCHIVE: archivePath,
      TYRANT_UV_EXTRACT_TO: extractionPath,
      TYRANT_UV_OUTPUT: stagedExecutable,
    } as Record<string, string>;
    const extracted = await defaultRunCommand("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      buildUvExtractionCommand(),
    ], extractionEnv);
    if (extracted.exitCode !== 0 || !existsSync(stagedExecutable)) throw new Error("uv_extract_failed");
    const versionCheck = await defaultRunCommand(stagedExecutable, ["--version"], sanitizedProbeEnvironment(process.env));
    if (versionCheck.exitCode !== 0 || parseUvVersion(versionCheck.stdout) !== UV_PINNED_VERSION) throw new Error("uv_version_mismatch");

    try {
      await rename(staging, destination);
      return executable;
    } catch (error) {
      if (!existsSync(executable)) throw error;
      return executable;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function resolveUv(options: GraphifyRuntimeOptions, stateDirectory: string): Promise<string> {
  const configured = configuredUvExecutable(options);
  if (configured) {
    const runCommand = options.runCommand ?? defaultRunCommand;
    const version = await runCommand(configured, ["--version"], sanitizedProbeEnvironment(options.env ?? process.env), 5_000);
    if (version.exitCode === 0 && parseUvVersion(version.stdout)) return configured;
  }
  const managed = managedUvExecutable(stateDirectory, options.platform ?? process.platform);
  if (existsSync(managed)) {
    const runCommand = options.runCommand ?? defaultRunCommand;
    const version = await runCommand(managed, ["--version"], sanitizedProbeEnvironment(options.env ?? process.env), 5_000);
    if (version.exitCode === 0 && parseUvVersion(version.stdout) === UV_PINNED_VERSION) return managed;
    throw new Error("uv_managed_version_mismatch");
  }
  const bootstrap = options.bootstrapUv ?? ((directory, platform, arch) => bootstrapUv(directory, platform, arch, options.fetcher ?? fetch));
  return bootstrap(stateDirectory, options.platform ?? process.platform, options.arch ?? process.arch);
}

export async function ensureGraphifyRuntime(options: GraphifyRuntimeOptions = {}): Promise<GraphifyRuntimeStatus & { status: "ready" }> {
  const initial = await graphifyRuntimeStatus(options);
  if (initial.status === "ready") return initial as GraphifyRuntimeStatus & { status: "ready" };

  const configured = configuredGraphifyExecutable(options);
  if (configured.explicit) {
    if (initial.status === "version_mismatch") throw new Error("graphify_version_mismatch");
    throw new Error("graphify_executable_unavailable");
  }
  if (initial.status === "version_mismatch" && initial.source === "managed") throw new Error("graphify_managed_version_mismatch");

  const stateDirectory = userStateDirectory(options);
  const graphifyRoot = managedGraphifyRoot(stateDirectory);
  const outputDirectory = join(graphifyRoot, "bin");
  const managedExecutable = managedGraphifyExecutable(stateDirectory, options.platform ?? process.platform);
  await mkdir(outputDirectory, { recursive: true });
  const uv = await resolveUv(options, stateDirectory);
  const runCommand = options.runCommand ?? defaultRunCommand;
  const env = managedUvEnvironment(stateDirectory, graphifyRoot, options.env ?? process.env);
  const result = await runCommand(uv, [
    "tool", "install", "--python", "3.13", "--python-preference", "only-managed",
    "--no-progress", `graphifyy==${GRAPHIFY_PINNED_VERSION}`,
  ], env, 10 * 60_000);
  if (result.exitCode !== 0) throw new Error("graphify_install_failed");
  const version = await readVersion(managedExecutable, runCommand, env);
  if (!version) throw new Error("graphify_install_unverified");
  if (version !== GRAPHIFY_PINNED_VERSION) throw new Error("graphify_version_mismatch");
  return { status: "ready", source: "managed", version, executable: managedExecutable };
}
