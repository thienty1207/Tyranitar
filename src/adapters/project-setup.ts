import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readAdapterActivation, type AutomaticAdapterHost } from "./activation";

export { recordAdapterExecution } from "./activation";

export type ProjectAdapterHost = AutomaticAdapterHost | "dsh" | "claude-desktop";

export type ProjectProfileGuidance = { profileId: string; profileName: string; workspace: string; project: string };

export type ProjectAdapterSetupOptions = {
  projectRoot: string;
  tyrantRoot: string;
  hosts: ProjectAdapterHost[];
  profileGuidance?: ProjectProfileGuidance;
  dshPluginStatus?: "installed" | "ready" | "not_detected";
  allowManagedUpgrade?: boolean;
  verifiedSkillBundle?: VerifiedPinnedSkillBundle;
};

type ManagedFile = {
  path: string;
  previous_exists: boolean;
  previous_sha256?: string;
  backup_path?: string;
  installed_sha256: string;
  managed_block_sha256?: string;
  managed_outside_sha256?: string;
  preserve_outside_edits?: boolean;
};

type OwnerManifest = {
  schema_version: 1;
  owner: "tyrant-engine";
  status: "installing" | "installed";
  installation_id: string;
  hosts: Partial<Record<ProjectAdapterHost, string>>;
  files: ManagedFile[];
  manifest_sha256: string;
};

export type ProposedFile = { path: string; content: Buffer; purpose: string };
type Conflict = { path: string; reason: string };

async function mapBounded<T, R>(items: readonly T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
}

export class VerifiedPinnedSkillBundle {
  private constructor(readonly root: string, private readonly files: ProposedFile[]) {}

  static async load(root: string): Promise<VerifiedPinnedSkillBundle> {
    const canonicalRoot = await loadRoot(root);
    return new VerifiedPinnedSkillBundle(canonicalRoot, await readVendoredSkillFiles(canonicalRoot));
  }

  filesFor(root: string): ProposedFile[] {
    const selected = resolve(root);
    const matches = process.platform === "win32"
      ? selected.toLocaleLowerCase("en-US") === this.root.toLocaleLowerCase("en-US")
      : selected === this.root;
    if (!matches) throw new Error("pinned_skill_bundle_root_mismatch");
    return this.files;
  }
}

const MANIFEST_PATH = ".tyrant/adapters/manifest.json";
const ADAPTER_DIRECTORY = ".tyrant/adapters";
const PROJECT_GUIDANCE_START = "<!-- BEGIN TYRANT ENGINE PROJECT GUIDANCE -->";
const PROJECT_GUIDANCE_END = "<!-- END TYRANT ENGINE PROJECT GUIDANCE -->";
const CODEX_MANAGED_START = "# BEGIN TYRANT ENGINE MANAGED";
const CODEX_MANAGED_END = "# END TYRANT ENGINE MANAGED";
const ALL_HOSTS = ["codex", "claude-code", "opencode", "dsh", "claude-desktop"] as const;
const SKILL_PACKAGE_PINS = [
  { repository: "https://github.com/mattpocock/skills", commit: "d1478fcb140db0b93c0c8df17bcfd311844749d0", tree_sha: "42b57b23ac2979fce601ce1d4b4d6c1d46471bbe", license: "MIT", skill_ids: ["ask-matt", "tdd", "diagnosing-bugs", "code-review"] },
  { repository: "https://github.com/Leonxlnx/taste-skill", commit: "f6b76575f949707b4e3c37cd86cb44b0b98643e8", tree_sha: "8684feda2c345302dab976ae4c42ae62e04e1263", license: "MIT", skill_ids: ["design-taste-frontend"] },
  { repository: "https://github.com/cloudflare/security-audit-skill", commit: "c1c8a8c1471069fb0e188eeaff69b8e8db6564a8", tree_sha: "8cd03bb3941496e441d6248aaae2429a35b93cc3", license: "MIT", skill_ids: ["security-audit"] },
] as const;
const ALLOWED_SKILL_LICENSE_PATHS = new Set([
  "vendor/skills/_licenses/mattpocock-skills-LICENSE",
  "vendor/skills/_licenses/Leonxlnx-taste-skill-LICENSE",
  "vendor/skills/_licenses/cloudflare-security-audit-skill-LICENSE",
]);
const REQUIRED_BUNDLED_SKILL_FILES = [
  ".tyrant/skills/ask-matt/SKILL.md",
  ".tyrant/skills/tdd/SKILL.md",
  ".tyrant/skills/diagnosing-bugs/SKILL.md",
  ".tyrant/skills/code-review/SKILL.md",
  ".tyrant/skills/design-taste-frontend/SKILL.md",
  ".tyrant/skills/security-audit/SKILL.md",
];
const REQUIRED_BUNDLED_LICENSE_FILES = [
  ".tyrant/skills/_licenses/mattpocock-skills-LICENSE",
  ".tyrant/skills/_licenses/Leonxlnx-taste-skill-LICENSE",
  ".tyrant/skills/_licenses/cloudflare-security-audit-skill-LICENSE",
];
const MAX_VENDORED_SKILL_FILES = 2_048;
const MAX_VENDORED_SKILL_FILE_BYTES = 2_000_000;
const MAX_VENDORED_SKILL_TOTAL_BYTES = 50_000_000;

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectGuidanceDetails(bytes: Buffer): { blockHash: string; outsideHash: string; withoutBlock: Buffer } | undefined {
  const source = bytes.toString("utf8");
  const startIndex = source.indexOf(PROJECT_GUIDANCE_START);
  const endIndex = source.indexOf(PROJECT_GUIDANCE_END);
  if (startIndex < 0 || endIndex < startIndex
    || source.indexOf(PROJECT_GUIDANCE_START, startIndex + PROJECT_GUIDANCE_START.length) >= 0
    || source.indexOf(PROJECT_GUIDANCE_END, endIndex + PROJECT_GUIDANCE_END.length) >= 0) return undefined;
  const afterIndex = endIndex + PROJECT_GUIDANCE_END.length;
  const withoutBlock = Buffer.from(`${source.slice(0, startIndex)}${source.slice(afterIndex)}`, "utf8");
  return { blockHash: hash(source.slice(startIndex, afterIndex)), outsideHash: hash(withoutBlock), withoutBlock };
}

function managedFileMatches(file: ManagedFile, bytes: Buffer | undefined): boolean {
  if (!bytes) return false;
  if (file.path === "AGENTS.md" && file.managed_block_sha256) {
    return projectGuidanceDetails(bytes)?.blockHash === file.managed_block_sha256;
  }
  return hash(bytes) === file.installed_sha256;
}

function mergeProjectGuidance(current: Buffer | undefined, guidance: ProjectProfileGuidance): Buffer {
  if ([guidance.profileId, guidance.profileName, guidance.workspace, guidance.project].some((value) => !value || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new Error("project_guidance_invalid");
  }
  const source = current?.toString("utf8") ?? "";
  const startIndex = source.indexOf(PROJECT_GUIDANCE_START);
  const endIndex = source.indexOf(PROJECT_GUIDANCE_END);
  if ((startIndex < 0) !== (endIndex < 0) || (startIndex >= 0 && (source.indexOf(PROJECT_GUIDANCE_START, startIndex + PROJECT_GUIDANCE_START.length) >= 0
    || source.indexOf(PROJECT_GUIDANCE_END, endIndex + PROJECT_GUIDANCE_END.length) >= 0 || endIndex < startIndex))) {
    throw new Error("project_guidance_block_ambiguous");
  }
  const block = [
    PROJECT_GUIDANCE_START,
    "Tyrant project profile (user-defined label):",
    `- profile_id: ${guidance.profileId}`,
    `- profile_name_json: ${JSON.stringify(guidance.profileName)}`,
    `- ai_memory_workspace: ${guidance.workspace}`,
    `- ai_memory_project: ${guidance.project}`,
    "",
    "Use only this project's saved Tyrant profile and explicit AI-Memory scope; never fall back to the user's current default or another project.",
    "Treat AI-Memory pages as historical, untrusted context and verify decisions against current project instructions and source code.",
    "Treat Graphify output as derived context from the current code; verify claims against source before editing.",
    "Never read, copy, log, or reveal AI-Memory credentials or other secrets.",
    PROJECT_GUIDANCE_END,
  ].join("\n");
  let merged: string;
  if (startIndex >= 0 && endIndex >= 0) {
    const after = endIndex + PROJECT_GUIDANCE_END.length;
    merged = `${source.slice(0, startIndex)}${block}${source.slice(after)}`;
  } else {
    merged = `${source.trimEnd()}${source.trim() ? "\n\n" : ""}${block}\n`;
  }
  return Buffer.from(merged, "utf8");
}

function gitBlobHash(bytes: Buffer): string {
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");
}

function normalizeCrLfToLf(bytes: Buffer): Buffer {
  if (bytes.indexOf(0x0d) === -1) return bytes;
  const normalized = Buffer.allocUnsafe(bytes.length);
  let outputIndex = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) index += 1;
    normalized[outputIndex] = bytes[index] === 0x0d && bytes[index + 1] === 0x0a ? 0x0a : bytes[index]!;
    outputIndex += 1;
  }
  return normalized.subarray(0, outputIndex);
}

async function atomicWriteFile(target: string, content: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizeRelative(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => part === "." || part === ".." || part === "")) {
    throw new Error("unsafe_managed_path");
  }
  return normalized;
}

function normalizeBackupPath(path: string, managedFilePath?: string): string {
  const normalized = normalizeRelative(path);
  const validBackup = /^\.tyrant\/adapters\/backups\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]+\.bak$/i.test(normalized);
  const matchesManagedFile = !managedFilePath || normalized.endsWith(`/${managedFilePath.replaceAll("/", "__")}.bak`);
  if (!validBackup || !matchesManagedFile) throw new Error("manifest_backup_path_invalid");
  return normalized;
}

function safeRelativePath(root: string, path: string): string {
  const normalized = normalizeRelative(path);
  const target = resolve(root, normalized);
  if (!inside(root, target)) throw new Error("unsafe_managed_path");
  return normalized;
}

async function inspectPath(root: string, relativePath: string): Promise<{ exists: boolean; bytes?: Buffer }> {
  const normalized = safeRelativePath(root, relativePath);
  let current = root;
  const parts = normalized.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]);
    if (!inside(root, current)) throw new Error("managed_path_outside_project");
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("managed_path_is_symlink");
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error("managed_parent_not_directory");
      if (index === parts.length - 1 && !info.isFile()) throw new Error("managed_target_not_file");
      if (!inside(root, await realpath(current))) throw new Error("managed_path_outside_project");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
      throw error;
    }
  }
  return { exists: true, bytes: await readFile(current) };
}

async function removeEmptyManagedDirectory(root: string, relativePath: string): Promise<void> {
  const normalized = safeRelativePath(root, relativePath);
  let current = root;
  for (const part of normalized.split("/")) {
    current = resolve(current, part);
    if (!inside(root, current)) throw new Error("managed_path_outside_project");
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("managed_path_is_symlink");
    if (!info.isDirectory()) throw new Error("managed_parent_not_directory");
    if (!inside(root, await realpath(current))) throw new Error("managed_path_outside_project");
  }
  await rmdir(current);
}

async function readVendoredSkillFiles(tyrantRoot: string): Promise<ProposedFile[]> {
  const sourceRoot = await loadRoot(tyrantRoot);
  const manifestResult = await inspectPath(sourceRoot, "vendor/skills/manifest.json");
  if (!manifestResult.exists || !manifestResult.bytes) throw new Error("pinned_skill_manifest_missing");
  if (manifestResult.bytes.length > 1_000_000) throw new Error("pinned_skill_manifest_too_large");
  const manifest = asObject(JSON.parse(manifestResult.bytes.toString("utf8")), "vendor/skills/manifest.json");
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.packages) || !Array.isArray(manifest.files)) throw new Error("pinned_skill_manifest_invalid");
  if (manifest.files.length === 0 || manifest.files.length > MAX_VENDORED_SKILL_FILES) throw new Error("pinned_skill_file_count_invalid");

  const packages = manifest.packages.map((value) => asObject(value, "vendor/skills/manifest.json:package"));
  if (packages.length !== SKILL_PACKAGE_PINS.length) throw new Error("pinned_skill_package_count_invalid");
  for (const pin of SKILL_PACKAGE_PINS) {
    const pkg = packages.find((item) => item.repository === pin.repository);
    if (!pkg || pkg.commit !== pin.commit || pkg.tree_sha !== pin.tree_sha || pkg.license !== pin.license || !Array.isArray(pkg.skill_ids)
      || JSON.stringify([...pkg.skill_ids].sort()) !== JSON.stringify([...pin.skill_ids].sort())) {
      throw new Error(`pinned_skill_source_mismatch:${pin.repository}`);
    }
  }

  const paths = new Set<string>();
  const entries: Array<{ entry: Record<string, unknown>; vendorPath: string; projectPath: string }> = [];
  for (const value of manifest.files) {
    const entry = asObject(value, "vendor/skills/manifest.json:file");
    if (typeof entry.source_path !== "string" || typeof entry.vendor_path !== "string" || typeof entry.project_path !== "string"
      || typeof entry.git_blob_sha !== "string" || !/^[a-f0-9]{40}$/.test(entry.git_blob_sha)
      || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Number.isSafeInteger(entry.size) || Number(entry.size) < 0 || Number(entry.size) > MAX_VENDORED_SKILL_FILE_BYTES) {
      throw new Error("pinned_skill_file_record_invalid");
    }
    const vendorPath = normalizeRelative(entry.vendor_path);
    const projectPath = normalizeRelative(entry.project_path);
    if (!vendorPath.startsWith("vendor/skills/")) throw new Error("pinned_skill_vendor_path_invalid");
    const relativeVendorPath = vendorPath.slice("vendor/skills/".length);
    if (projectPath !== `.tyrant/skills/${relativeVendorPath}`) throw new Error("pinned_skill_project_path_invalid");
    const sourcePath = String(entry.source_path);
    const expectedVendorPath = sourcePath === "LICENSE"
      ? ALLOWED_SKILL_LICENSE_PATHS.has(vendorPath) ? vendorPath : undefined
      : sourcePath.startsWith("skills/engineering/ask-matt/") || sourcePath.startsWith("skills/engineering/tdd/")
          || sourcePath.startsWith("skills/engineering/diagnosing-bugs/") || sourcePath.startsWith("skills/engineering/code-review/")
        ? `vendor/skills/${sourcePath.slice("skills/engineering/".length)}`
        : sourcePath.startsWith("skills/taste-skill/")
          ? `vendor/skills/design-taste-frontend/${sourcePath.slice("skills/taste-skill/".length)}`
          : sourcePath.startsWith("skills/security-audit/")
            ? `vendor/skills/security-audit/${sourcePath.slice("skills/security-audit/".length)}`
            : undefined;
    if (!expectedVendorPath || vendorPath !== expectedVendorPath) throw new Error("pinned_skill_source_path_not_allowlisted");
    const projectPathKey = projectPath.toLowerCase();
    if (paths.has(projectPathKey)) throw new Error("pinned_skill_duplicate_project_path");
    paths.add(projectPathKey);
    entries.push({ entry, vendorPath, projectPath });
  }

  const installed = await mapBounded(entries, 32, async ({ entry, vendorPath, projectPath }) => {
    const source = await inspectPath(sourceRoot, vendorPath);
    if (!source.exists || !source.bytes) throw new Error(`pinned_skill_file_missing:${vendorPath}`);
    const matchesPin = (bytes: Buffer) => bytes.length === Number(entry.size)
      && hash(bytes) === entry.sha256 && gitBlobHash(bytes) === entry.git_blob_sha;
    const pinnedBytes = matchesPin(source.bytes) ? source.bytes : normalizeCrLfToLf(source.bytes);
    if (!matchesPin(pinnedBytes)) throw new Error(`pinned_skill_hash_mismatch:${vendorPath}`);
    return { path: projectPath, content: pinnedBytes, purpose: "pinned skill package file; upstream, revision and license are recorded in its manifest" };
  });
  if (installed.reduce((total, file) => total + file.content.length, 0) > MAX_VENDORED_SKILL_TOTAL_BYTES) throw new Error("pinned_skill_package_too_large");
  const skillPaths = new Set(installed.filter((file) => file.path.endsWith("/SKILL.md")).map((file) => file.path));
  for (const path of REQUIRED_BUNDLED_SKILL_FILES) if (!skillPaths.has(path)) throw new Error(`required_pinned_skill_missing:${path}`);
  for (const path of REQUIRED_BUNDLED_LICENSE_FILES) if (!paths.has(path.toLowerCase())) throw new Error(`required_pinned_skill_license_missing:${path}`);
  return [...installed, { path: ".tyrant/skills/manifest.json", content: manifestResult.bytes, purpose: "pinned skill source, revision, license and integrity manifest" }];
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path}:config_root_not_object`);
  return value as Record<string, unknown>;
}

function eventList(config: Record<string, unknown>, path: string, event: string): unknown[] {
  if (config.hooks === undefined) config.hooks = {};
  const hooks = asObject(config.hooks, path);
  if (hooks[event] === undefined) hooks[event] = [];
  if (!Array.isArray(hooks[event])) throw new Error(`${path}:hook_event_not_array:${event}`);
  return hooks[event] as unknown[];
}

function quoteCommandPath(path: string): string {
  // The host later parses this string as a command. Reject substitutions and
  // environment expansion syntax used by POSIX shells, PowerShell, and cmd.
  if (/["\r\n`$%!]/.test(path)) throw new Error("hook_path_has_unsupported_characters");
  return `"${path}"`;
}

function commandHookEntry(hookPath: string, host: "codex" | "claude-code", event: "UserPromptSubmit" | "SessionEnd"): Record<string, unknown> {
  const command = `bun run ${quoteCommandPath(hookPath)} ${host}`;
  const handler: Record<string, unknown> = { type: "command", command };
  if (event === "UserPromptSubmit") {
    handler.statusMessage = "Tyrant is preparing project context";
    if (host === "claude-code") {
      handler.onFailure = "block";
      handler.timeout = 60;
    }
  }
  else handler.timeout = host === "codex" ? 3 : 60;
  if (host === "codex" && process.platform === "win32") handler.commandWindows = command;
  return { hooks: [handler] };
}

function mergeHookConfig(existing: Buffer | undefined, relativePath: string, hookPath: string, host: "codex" | "claude-code", alreadyManaged: boolean): Buffer {
  let config: Record<string, unknown> = {};
  if (existing) {
    try {
      config = asObject(JSON.parse(existing.toString("utf8")), relativePath);
    } catch (error) {
      throw new Error(`${relativePath}:${error instanceof Error ? error.message : "invalid_json"}`);
    }
  }
  for (const event of ["UserPromptSubmit", "SessionEnd"] as const) {
    const entries = eventList(config, relativePath, event);
    const entry = commandHookEntry(hookPath, host, event);
    const serialized = JSON.stringify(entry);
    if (entries.some((current) => JSON.stringify(current) === serialized)) {
      if (alreadyManaged) continue;
      throw new Error(`${relativePath}:ownership_ambiguous:${event}`);
    }
    entries.push(entry);
  }
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function jsonChild(parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  if (parent[key] === undefined) parent[key] = {};
  const value = parent[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path}:config_object_invalid:${key}`);
  return value as Record<string, unknown>;
}

function mergeMcpJsonConfig(
  existing: Buffer | undefined,
  relativePath: string,
  mode: "claude-code" | "opencode",
  serverEntry: Record<string, unknown>,
  alreadyManaged: boolean,
): Buffer {
  let config: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = mode === "opencode" ? Bun.JSONC.parse(existing.toString("utf8")) as unknown : JSON.parse(existing.toString("utf8")) as unknown;
      config = asObject(parsed, relativePath);
    } catch (error) {
      throw new Error(`${relativePath}:${error instanceof Error ? error.message : "invalid_json"}`);
    }
  }
  const namespace = mode === "claude-code" ? jsonChild(config, "mcpServers", relativePath) : jsonChild(jsonChild(config, "mcp", relativePath), "servers", relativePath);
  if (namespace.tyrant !== undefined) {
    if (!alreadyManaged) throw new Error(`${relativePath}:ownership_ambiguous:mcpServers.tyrant`);
  }
  namespace.tyrant = serverEntry;
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function codexConfigContent(
  existing: Buffer | undefined,
  relativePath: string,
  hookPath: string,
  mcpEntryPath: string,
  projectRoot: string,
  alreadyManaged: boolean,
  allowManagedUpgrade: boolean,
): Buffer {
  let current = existing?.toString("utf8") ?? "";
  if (current.includes(CODEX_MANAGED_START) || current.includes(CODEX_MANAGED_END)) {
    const startIndex = current.indexOf(CODEX_MANAGED_START);
    const endIndex = current.indexOf(CODEX_MANAGED_END);
    const afterIndex = endIndex + CODEX_MANAGED_END.length;
    const markersAreUnique = startIndex >= 0 && endIndex > startIndex
      && current.indexOf(CODEX_MANAGED_START, startIndex + CODEX_MANAGED_START.length) < 0
      && current.indexOf(CODEX_MANAGED_END, afterIndex) < 0;
    if (!alreadyManaged || !markersAreUnique) throw new Error(`${relativePath}:ownership_ambiguous:tyrant_block`);
    if (!allowManagedUpgrade) return Buffer.from(current, "utf8");
    current = `${current.slice(0, startIndex)}${current.slice(afterIndex)}`;
  }
  let config: Record<string, unknown> = {};
  if (current.trim()) {
    try {
      config = Bun.TOML.parse(current) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`${relativePath}:invalid_toml:${error instanceof Error ? error.message : "parse_failed"}`);
    }
  }
  const mcpServers = config.mcp_servers === undefined ? {} : asObject(config.mcp_servers, relativePath);
  if (mcpServers.tyrant !== undefined) throw new Error(`${relativePath}:ownership_ambiguous:mcp_servers.tyrant`);

  const promptCommand = String((commandHookEntry(hookPath, "codex", "UserPromptSubmit").hooks as Array<Record<string, unknown>>)[0].command);
  const endCommand = String((commandHookEntry(hookPath, "codex", "SessionEnd").hooks as Array<Record<string, unknown>>)[0].command);
  const commandPathForMcp = JSON.stringify(["run", mcpEntryPath]);
  const block = [
    CODEX_MANAGED_START,
    "[mcp_servers.tyrant]",
    'command = "bun"',
    `args = ${commandPathForMcp}`,
    `cwd = ${JSON.stringify(projectRoot)}`,
    `env = { TYRANT_PROJECT_ROOT = ${JSON.stringify(projectRoot)} }`,
    "",
    "[[hooks.UserPromptSubmit]]",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(promptCommand)}`,
    "additionalContextLimit = 0",
    "",
    "[[hooks.SessionEnd]]",
    "[[hooks.SessionEnd.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(endCommand)}`,
    "timeout = 3",
    CODEX_MANAGED_END,
  ].join("\n");
  const merged = `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
  try {
    Bun.TOML.parse(merged);
  } catch (error) {
    throw new Error(`${relativePath}:generated_toml_invalid:${error instanceof Error ? error.message : "parse_failed"}`);
  }
  return Buffer.from(merged, "utf8");
}

function manifestUnsigned(manifest: Omit<OwnerManifest, "manifest_sha256">): string {
  return JSON.stringify(manifest);
}

function serializeManifest(manifest: Omit<OwnerManifest, "manifest_sha256">): Buffer {
  const full: OwnerManifest = { ...manifest, manifest_sha256: hash(manifestUnsigned(manifest)) };
  return Buffer.from(`${JSON.stringify(full, null, 2)}\n`, "utf8");
}

function parseManifest(bytes: Buffer): OwnerManifest {
  const value = JSON.parse(bytes.toString("utf8")) as Partial<OwnerManifest>;
  if (value.schema_version !== 1 || value.owner !== "tyrant-engine" || !["installing", "installed"].includes(String(value.status)) || typeof value.installation_id !== "string" || !Array.isArray(value.files) || typeof value.manifest_sha256 !== "string") {
    throw new Error("manifest_invalid_or_foreign");
  }
  const unsigned: Omit<OwnerManifest, "manifest_sha256"> = {
    schema_version: 1,
    owner: "tyrant-engine",
    status: value.status as OwnerManifest["status"],
    installation_id: value.installation_id,
    hosts: value.hosts ?? {},
    files: value.files,
  };
  if (hash(manifestUnsigned(unsigned)) !== value.manifest_sha256) throw new Error("manifest_integrity_mismatch");
  for (const file of value.files) {
    if (!file || typeof file.path !== "string" || typeof file.installed_sha256 !== "string" || typeof file.previous_exists !== "boolean") throw new Error("manifest_file_record_invalid");
    const managedPath = normalizeRelative(file.path);
    if (file.managed_block_sha256 !== undefined
      && (managedPath !== "AGENTS.md" || typeof file.managed_block_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.managed_block_sha256))) {
      throw new Error("manifest_file_record_invalid");
    }
    if (file.managed_outside_sha256 !== undefined
      && (managedPath !== "AGENTS.md" || typeof file.managed_outside_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.managed_outside_sha256))) {
      throw new Error("manifest_file_record_invalid");
    }
    if (file.preserve_outside_edits !== undefined && (managedPath !== "AGENTS.md" || typeof file.preserve_outside_edits !== "boolean")) {
      throw new Error("manifest_file_record_invalid");
    }
    if (file.backup_path) {
      normalizeBackupPath(file.backup_path, managedPath);
      if (!file.previous_exists || typeof file.previous_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.previous_sha256)) {
        throw new Error("manifest_backup_record_invalid");
      }
    }
  }
  return value as OwnerManifest;
}

async function loadRoot(projectRoot: string): Promise<string> {
  const root = await realpath(resolve(projectRoot));
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error("project_root_not_directory");
  return root;
}

async function readExistingManifest(root: string): Promise<{ manifest?: OwnerManifest; conflict?: Conflict }> {
  try {
    const target = await inspectPath(root, MANIFEST_PATH);
    if (!target.exists || !target.bytes) return {};
    return { manifest: parseManifest(target.bytes) };
  } catch (error) {
    return { conflict: { path: MANIFEST_PATH, reason: error instanceof Error ? error.message : "manifest_unreadable" } };
  }
}

async function verifyManifestTargets(root: string, manifest: OwnerManifest): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  if (manifest.status === "installing") {
    conflicts.push({ path: MANIFEST_PATH, reason: "setup_interrupted_rollback_before_retry" });
    return conflicts;
  }
  const results = await mapBounded(manifest.files, 32, async (file) => {
    try {
      const current = await inspectPath(root, file.path);
      return !current.exists || !managedFileMatches(file, current.bytes)
        ? { path: file.path, reason: "managed_file_changed_since_install" }
        : undefined;
    } catch (error) {
      return { path: file.path, reason: error instanceof Error ? error.message : "managed_file_unreadable" };
    }
  });
  return results.filter((conflict): conflict is Conflict => conflict !== undefined);
}

async function planFiles(options: ProjectAdapterSetupOptions, root: string, managedPaths = new Set<string>()): Promise<{ files: ProposedFile[]; conflicts: Conflict[]; hosts: Partial<Record<ProjectAdapterHost, string>>; manualActions: string[] }> {
  const conflicts: Conflict[] = [];
  const files: ProposedFile[] = [];
  const hosts: Partial<Record<ProjectAdapterHost, string>> = {};
  const manualActions: string[] = [];
  const selected = [...new Set(options.hosts)];
  if (!selected.length || selected.some((host) => !ALL_HOSTS.includes(host as typeof ALL_HOSTS[number]))) {
    return { files, conflicts: [{ path: "", reason: "hosts_must_include_supported_host_ids" }], hosts, manualActions };
  }
  if (options.profileGuidance) {
    try {
      const current = await inspectPath(root, "AGENTS.md");
      files.push({ path: "AGENTS.md", content: mergeProjectGuidance(current.bytes, options.profileGuidance), purpose: "Tyrant project-scoped profile and memory-safety guidance" });
    } catch (error) {
      conflicts.push({ path: "AGENTS.md", reason: error instanceof Error ? error.message : "project_guidance_invalid" });
    }
  }
  try {
    const pinnedSkills = options.verifiedSkillBundle
      ? options.verifiedSkillBundle.filesFor(options.tyrantRoot)
      : await readVendoredSkillFiles(options.tyrantRoot);
    files.push(...pinnedSkills);
    if (selected.includes("dsh")) {
      for (const file of pinnedSkills) {
        const prefix = ".tyrant/skills/";
        if (!file.path.startsWith(prefix) || file.path === ".tyrant/skills/manifest.json" || file.path.includes("/_licenses/")) continue;
        files.push({
          ...file,
          path: `.agents/skills/${file.path.slice(prefix.length)}`,
          purpose: "integrity-pinned DSH-native skill registry copy; hash-checked against Tyrant's private skill copy before automatic loading",
        });
      }
    }
  } catch (error) {
    conflicts.push({ path: "vendor/skills/manifest.json", reason: error instanceof Error ? error.message : "pinned_skill_package_invalid" });
  }
  const hookHosts = selected.filter((host): host is "codex" | "claude-code" => host === "codex" || host === "claude-code");
  if (hookHosts.length) {
    const hookRelative = ".tyrant/adapters/command-hook.js";
    const hookSource = resolve(options.tyrantRoot, "integrations", "command-hook.js");
    let hookBytes: Buffer;
    try {
      hookBytes = await readFile(hookSource);
    } catch {
      conflicts.push({ path: "integrations/command-hook.js", reason: "build_command_hook_bundle_first" });
      hookBytes = Buffer.alloc(0);
    }
    if (!conflicts.length) files.push({ path: hookRelative, content: hookBytes, purpose: "self-contained Codex and Claude Code command adapter" });
    const targetHook = join(root, hookRelative.replaceAll("/", sep));
    const mcpEntryPath = resolve(options.tyrantRoot, "src", "index.ts");
    try {
      await readFile(mcpEntryPath);
    } catch {
      conflicts.push({ path: "src/index.ts", reason: "tyrant_mcp_entrypoint_missing" });
    }
    for (const host of hookHosts) {
      const configRelative = host === "codex" ? ".codex/config.toml" : ".claude/settings.json";
      try {
        const current = await inspectPath(root, configRelative);
        let content: Buffer;
        if (host === "codex") {
          const legacyHooks = await inspectPath(root, ".codex/hooks.json");
          if (legacyHooks.exists) throw new Error(".codex/hooks.json:existing_hook_source_use_one_codex_hook_representation");
          content = codexConfigContent(current.bytes, configRelative, targetHook, mcpEntryPath, root, managedPaths.has(configRelative), options.allowManagedUpgrade === true);
        } else {
          content = mergeHookConfig(current.bytes, configRelative, targetHook, host, managedPaths.has(configRelative));
        }
        files.push({ path: configRelative, content, purpose: `${host} automatic hooks${host === "codex" ? " and MCP server" : ""}` });
        hosts[host] = host === "codex" ? "configured_pending_trust" : "configured_pending_execution";
      } catch (error) {
        conflicts.push({ path: configRelative, reason: error instanceof Error ? error.message : "host_config_invalid" });
      }
      if (host === "claude-code") {
        const mcpRelative = ".mcp.json";
        try {
          const current = await inspectPath(root, mcpRelative);
          const content = mergeMcpJsonConfig(current.bytes, mcpRelative, "claude-code", {
            type: "stdio", command: "bun", args: ["run", mcpEntryPath], env: { TYRANT_PROJECT_ROOT: "${CLAUDE_PROJECT_DIR:-.}" },
          }, managedPaths.has(mcpRelative));
          files.push({ path: mcpRelative, content, purpose: "Claude Code project-scoped Tyrant MCP server" });
        } catch (error) {
          conflicts.push({ path: mcpRelative, reason: error instanceof Error ? error.message : "mcp_config_invalid" });
        }
      }
    }
  }
  if (selected.includes("opencode")) {
    const pluginRelative = ".opencode/plugins/tyrant-engine.js";
    try {
      const source = await readFile(resolve(options.tyrantRoot, "integrations", "opencode", "index.js"));
      files.push({ path: pluginRelative, content: source, purpose: "OpenCode project plugin" });
      const configRelative = ".opencode/opencode.jsonc";
      const current = await inspectPath(root, configRelative);
      const serverEntry = {
        type: "local", command: ["bun", "run", resolve(options.tyrantRoot, "src", "index.ts")], cwd: ".",
      };
      const content = mergeMcpJsonConfig(current.bytes, configRelative, "opencode", serverEntry, managedPaths.has(configRelative));
      files.push({ path: configRelative, content, purpose: "OpenCode project-scoped Tyrant MCP server" });
      hosts.opencode = "configured_pending_execution";
    } catch {
      conflicts.push({ path: "integrations/opencode/index.js", reason: "build_opencode_adapter_first" });
    }
  }
  if (selected.includes("dsh")) {
    hosts.dsh = options.dshPluginStatus === "not_detected" ? "not_detected" : "profile_plugin_managed";
  }
  if (selected.includes("claude-desktop")) hosts["claude-desktop"] = "mcp_only";
  return { files, conflicts, hosts, manualActions };
}

async function createPlan(options: ProjectAdapterSetupOptions) {
  let root: string;
  try {
    root = await loadRoot(options.projectRoot);
  } catch (error) {
    return { root: resolve(options.projectRoot), existingManifest: undefined, files: [] as ProposedFile[], hosts: {} as Partial<Record<ProjectAdapterHost, string>>, manualActions: [] as string[], conflicts: [{ path: options.projectRoot, reason: error instanceof Error ? error.message : "project_root_invalid" }] };
  }
  const manifestPath = await inspectPath(root, MANIFEST_PATH).catch((error) => ({ exists: false, error } as const));
  let existingManifest: OwnerManifest | undefined;
  const baseConflicts: Conflict[] = [];
  if ("error" in manifestPath) baseConflicts.push({ path: MANIFEST_PATH, reason: manifestPath.error instanceof Error ? manifestPath.error.message : "manifest_path_unreadable" });
  else if (manifestPath.exists) {
    const loaded = await readExistingManifest(root);
    if (loaded.conflict) baseConflicts.push(loaded.conflict);
    else if (loaded.manifest) {
      existingManifest = loaded.manifest;
      baseConflicts.push(...await verifyManifestTargets(root, loaded.manifest));
    }
  }
  const planned = await planFiles(options, root, new Set(existingManifest?.files.map((file) => file.path) ?? []));
  planned.conflicts.push(...baseConflicts);
  if (existingManifest) {
    const managedPaths = new Set(existingManifest.files.map((file) => file.path));
    for (const file of planned.files) {
      if (managedPaths.has(file.path)) continue;
      const existing = await inspectPath(root, file.path).catch((error) => ({ exists: false, error } as const));
      if ("error" in existing || (existing.exists && file.path !== "AGENTS.md")) planned.conflicts.push({ path: file.path, reason: "unowned_target_already_exists" });
    }
    for (const file of planned.files) {
      const old = existingManifest.files.find((item) => item.path === file.path);
      if (!options.allowManagedUpgrade && old && old.installed_sha256 !== hash(file.content) && file.path !== "AGENTS.md") {
        planned.conflicts.push({ path: file.path, reason: "managed_adapter_version_changed_rollback_before_upgrade" });
      }
    }
  } else if (!baseConflicts.length) {
    if ("error" in manifestPath) {
      // The path inspection error is already represented in baseConflicts.
    } else if (manifestPath.exists) {
      planned.conflicts.push({ path: MANIFEST_PATH, reason: "manifest_unreadable" });
    }
    for (const file of planned.files) {
      const current = await inspectPath(root, file.path).catch((error) => ({ exists: false, error } as const));
      if ("error" in current) planned.conflicts.push({ path: file.path, reason: current.error instanceof Error ? current.error.message : "target_unreadable" });
      if ((file.path.startsWith(".tyrant/skills/") || file.path.startsWith(".agents/skills/") || file.path === ".tyrant/adapters/command-hook.js" || file.path === ".opencode/plugins/tyrant-engine.js") && current.exists) {
        planned.conflicts.push({ path: file.path, reason: file.path.startsWith(".tyrant/skills/") || file.path.startsWith(".agents/skills/") ? "unowned_pinned_skill_target_already_exists" : "unowned_target_already_exists" });
      }
    }
  } else {
    // An unreadable or invalid manifest is an ownership conflict; no writes are allowed.
  }
  return { root, existingManifest, ...planned };
}

export async function previewProjectAdapters(options: ProjectAdapterSetupOptions) {
  const plan = await createPlan(options);
  const changes = plan.files.filter((file) => {
    const existing = plan.existingManifest?.files.find((managed) => managed.path === file.path);
    return !existing || existing.installed_sha256 !== hash(file.content);
  });
  return {
    status: plan.conflicts.length ? "conflict" as const : "ready" as const,
    project_root: plan.root,
    changes: [
      ...changes.map(({ path, purpose }) => ({ path, purpose, action: "create_or_update" })),
      ...(changes.length && plan.files.length ? [{ path: MANIFEST_PATH, purpose: "Tyrant ownership manifest and rollback index", action: "create_or_update" }] : []),
    ],
    hosts: plan.hosts,
    manual_actions: plan.manualActions,
    conflicts: plan.conflicts,
  };
}

export async function installProjectAdapters(options: ProjectAdapterSetupOptions) {
  const plan = await createPlan(options);
  if (plan.conflicts.length) return { status: "conflict" as const, project_root: plan.root, hosts: plan.hosts, manual_actions: plan.manualActions, conflicts: plan.conflicts };
  if (!plan.files.length) return { status: "manual_action_required" as const, project_root: plan.root, hosts: plan.hosts, manual_actions: plan.manualActions, conflicts: [] as Conflict[] };

  const priorResult = await readExistingManifest(plan.root);
  if (priorResult.conflict) return { status: "conflict" as const, project_root: plan.root, conflicts: [priorResult.conflict] };
  const prior = priorResult.manifest;
  if (prior) {
    if (prior.status !== "installed") return { status: "conflict" as const, project_root: plan.root, conflicts: [{ path: MANIFEST_PATH, reason: "setup_interrupted_rollback_before_retry" }] };
    const allRequestedPresent = plan.files.every((file) => prior.files.some((managed) => managed.path === file.path && managed.installed_sha256 === hash(file.content)));
    if (allRequestedPresent) return {
      status: "already_configured" as const,
      project_root: plan.root,
      hosts: { ...prior.hosts, ...plan.hosts },
      manual_actions: plan.manualActions,
      conflicts: [] as Conflict[],
    };
  }

  const installId = randomUUID();
  const backupDirectory = `${ADAPTER_DIRECTORY}/backups/${installId}`;
  const oldFiles = new Map((prior?.files ?? []).map((file) => [file.path, file]));
  const outputFiles: ManagedFile[] = [...(prior?.files ?? [])];
  const writes: Array<{ target: string; before?: Buffer; after: Buffer; relativePath: string }> = [];
  const backups: Array<{ relativePath: string; bytes: Buffer }> = [];

  try {
    for (const file of plan.files) {
      const current = await inspectPath(plan.root, file.path);
      const existingManaged = oldFiles.get(file.path);
      if (existingManaged && existingManaged.installed_sha256 === hash(file.content)) continue;
      const backupPath = current.exists && !existingManaged ? `${backupDirectory}/${file.path.replaceAll("/", "__")}.bak` : undefined;
      if (current.exists && current.bytes && backupPath) backups.push({ relativePath: backupPath, bytes: current.bytes });
      const guidanceDetails = file.path === "AGENTS.md" ? projectGuidanceDetails(file.content) : undefined;
      const currentGuidance = file.path === "AGENTS.md" && current.bytes ? projectGuidanceDetails(current.bytes) : undefined;
      const outsideChangedSinceInstall = existingManaged?.managed_outside_sha256 !== undefined
        && currentGuidance?.outsideHash !== existingManaged.managed_outside_sha256;
      const managed: ManagedFile = {
        path: file.path,
        previous_exists: existingManaged?.previous_exists ?? current.exists,
        ...(existingManaged?.previous_sha256 ? { previous_sha256: existingManaged.previous_sha256 } : current.exists && current.bytes ? { previous_sha256: hash(current.bytes) } : {}),
        ...(existingManaged?.backup_path ? { backup_path: existingManaged.backup_path } : backupPath ? { backup_path: backupPath } : {}),
        installed_sha256: hash(file.content),
        ...(guidanceDetails ? {
          managed_block_sha256: guidanceDetails.blockHash,
          managed_outside_sha256: guidanceDetails.outsideHash,
          preserve_outside_edits: existingManaged?.preserve_outside_edits === true || outsideChangedSinceInstall,
        } : {}),
      };
      if (file.path === "AGENTS.md" && (!managed.managed_block_sha256 || !guidanceDetails)) throw new Error("project_guidance_block_ambiguous");
      const index = outputFiles.findIndex((entry) => entry.path === managed.path);
      if (index >= 0) outputFiles[index] = managed;
      else outputFiles.push(managed);
      writes.push({ target: resolve(plan.root, file.path), relativePath: file.path, ...(current.bytes ? { before: current.bytes } : {}), after: file.content });
    }

    const manifestBase: Omit<OwnerManifest, "manifest_sha256"> = {
      schema_version: 1,
      owner: "tyrant-engine",
      status: "installed",
      installation_id: prior?.installation_id ?? installId,
      hosts: { ...prior?.hosts, ...plan.hosts },
      files: outputFiles,
    };
    const installingBytes = serializeManifest({ ...manifestBase, status: "installing" });
    const installedBytes = serializeManifest(manifestBase);
    const manifestCurrent = await inspectPath(plan.root, MANIFEST_PATH);
    const manifestTarget = resolve(plan.root, MANIFEST_PATH);

    // Backups and an in-progress owner manifest are durable before the first adapter file changes.
    for (const item of backups) {
      const current = await inspectPath(plan.root, item.relativePath);
      if (current.exists) throw new Error("backup_target_already_exists");
      const target = resolve(plan.root, item.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, item.bytes, { flag: "wx" });
    }

    const committed: Array<{ target: string; before?: Buffer }> = [];
    try {
      await atomicWriteFile(manifestTarget, installingBytes);
      committed.push({ target: manifestTarget, ...(manifestCurrent.bytes ? { before: manifestCurrent.bytes } : {}) });
      for (const item of writes) {
        await atomicWriteFile(item.target, item.after);
        committed.push({ target: item.target, ...(item.before ? { before: item.before } : {}) });
      }
      await atomicWriteFile(manifestTarget, installedBytes);
    } catch (error) {
      for (const item of committed.reverse()) {
        if (item.before) await atomicWriteFile(item.target, item.before).catch(() => undefined);
        else await unlink(item.target).catch(() => undefined);
      }
      throw error;
    }
  } catch (error) {
    return { status: "conflict" as const, project_root: plan.root, hosts: plan.hosts, manual_actions: plan.manualActions, conflicts: [{ path: "", reason: error instanceof Error ? error.message : "setup_write_failed" }] };
  }

  return { status: "installed" as const, project_root: plan.root, hosts: plan.hosts, manual_actions: plan.manualActions, conflicts: [] as Conflict[] };
}

export async function getProjectAdapterStatus(input: { projectRoot: string }) {
  let root: string;
  try {
    root = await loadRoot(input.projectRoot);
  } catch (error) {
    return { status: "conflict" as const, hosts: {} as Partial<Record<ProjectAdapterHost, string>>, conflicts: [{ path: input.projectRoot, reason: error instanceof Error ? error.message : "project_root_invalid" }] };
  }
  const loaded = await readExistingManifest(root);
  if (loaded.conflict) return { status: "conflict" as const, hosts: {} as Partial<Record<ProjectAdapterHost, string>>, conflicts: [loaded.conflict] };
  if (!loaded.manifest) return { status: "not_installed" as const, hosts: {} as Partial<Record<ProjectAdapterHost, string>>, conflicts: [] as Conflict[] };
  const conflicts = await verifyManifestTargets(root, loaded.manifest);
  const hosts = { ...loaded.manifest.hosts };
  const activation = await readAdapterActivation(root);
  if (activation?.installation_id === loaded.manifest.installation_id) {
    for (const host of ["codex", "claude-code", "opencode", "dsh"] as const) {
      const execution = activation.executions[host];
      if (!hosts[host] || !execution) continue;
      if (execution.last_outcome === "context_injected") hosts[host] = "hook_executed";
      else if (execution.last_outcome === "blocked") hosts[host] = "hook_blocked";
      else if ((execution.injected_count ?? execution.count) > 0) hosts[host] = "hook_executed";
      else if ((execution.blocked_count ?? 0) > 0) hosts[host] = "hook_blocked";
    }
  }
  return { status: conflicts.length ? "conflict" as const : "installed" as const, hosts, conflicts, installation_id: loaded.manifest.installation_id };
}

async function restoreProjectAdapters(input: { projectRoot: string }) {
  let root: string;
  try {
    root = await loadRoot(input.projectRoot);
  } catch (error) {
    return { status: "conflict" as const, conflicts: [{ path: input.projectRoot, reason: error instanceof Error ? error.message : "project_root_invalid" }] };
  }
  const loaded = await readExistingManifest(root);
  if (loaded.conflict) return { status: "conflict" as const, conflicts: [loaded.conflict] };
  if (!loaded.manifest) return { status: "not_installed" as const, conflicts: [] as Conflict[] };
  const conflicts: Conflict[] = [];
  const restorePlan: Array<{ file: ManagedFile; priorState: boolean; backup?: Buffer; after?: Buffer }> = [];
  for (const file of loaded.manifest.files) {
    try {
      const current = await inspectPath(root, file.path);
      const isFullInstalled = current.exists && Boolean(current.bytes) && hash(current.bytes!) === file.installed_sha256;
      const currentGuidance = file.path === "AGENTS.md" && file.managed_block_sha256 && current.bytes
        ? projectGuidanceDetails(current.bytes)
        : undefined;
      const hasManagedGuidance = Boolean(currentGuidance && currentGuidance.blockHash === file.managed_block_sha256);
      const isInstalled = isFullInstalled || hasManagedGuidance;
      const guidanceOutsideChanged = hasManagedGuidance && currentGuidance
        && (file.preserve_outside_edits === true
          || (file.managed_outside_sha256
            ? hash(currentGuidance.withoutBlock) !== file.managed_outside_sha256
            : !isFullInstalled));
      const isPrior = file.previous_exists
        ? current.exists && Boolean(current.bytes) && hash(current.bytes!) === file.previous_sha256
        : !current.exists;
      if (!isInstalled && !isPrior) {
        conflicts.push({ path: file.path, reason: "managed_file_changed_since_install" });
        continue;
      }
      if (!isInstalled && isPrior) {
        restorePlan.push({ file, priorState: true });
        continue;
      }
      if (hasManagedGuidance && guidanceOutsideChanged && currentGuidance) {
        restorePlan.push({ file, priorState: false, after: currentGuidance.withoutBlock });
        continue;
      }
      if (file.previous_exists) {
        if (!file.backup_path || !file.previous_sha256) {
          conflicts.push({ path: file.path, reason: "backup_reference_missing" });
          continue;
        }
        const backup = await inspectPath(root, file.backup_path);
        if (!backup.exists || !backup.bytes || hash(backup.bytes) !== file.previous_sha256) {
          conflicts.push({ path: file.backup_path, reason: "backup_missing_or_hash_mismatch" });
        } else restorePlan.push({ file, priorState: false, backup: backup.bytes });
      } else {
        restorePlan.push({ file, priorState: false });
      }
    } catch (error) {
      conflicts.push({ path: file.path, reason: error instanceof Error ? error.message : "managed_file_unreadable" });
    }
  }
  if (conflicts.length) return { status: "conflict" as const, conflicts };

  // All ownership and backup hashes are checked before any file is changed.
  for (const item of restorePlan) {
    if (item.priorState) continue;
    const target = resolve(root, safeRelativePath(root, item.file.path));
    if (item.after) {
      if (item.after.length) await atomicWriteFile(target, item.after);
      else await unlink(target);
    } else if (item.backup) await atomicWriteFile(target, item.backup);
    else await unlink(target);
  }
  const backupDirectories = new Set<string>();
  for (const file of loaded.manifest.files) {
    if (!file.backup_path) continue;
    const backupPath = normalizeBackupPath(file.backup_path, file.path);
    backupDirectories.add(dirname(backupPath).replaceAll(sep, "/"));
    try {
      const backup = await inspectPath(root, backupPath);
      if (!backup.exists) continue;
      if (!backup.bytes || hash(backup.bytes) !== file.previous_sha256) {
        conflicts.push({ path: backupPath, reason: "backup_missing_or_hash_mismatch" });
        continue;
      }
      await unlink(resolve(root, safeRelativePath(root, backupPath)));
    } catch (error) {
      conflicts.push({ path: backupPath, reason: error instanceof Error ? error.message : "backup_cleanup_failed" });
    }
  }
  if (conflicts.length) return { status: "conflict" as const, conflicts };
  backupDirectories.add(`${ADAPTER_DIRECTORY}/backups`);
  for (const directory of backupDirectories) {
    try {
      await removeEmptyManagedDirectory(root, directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
        conflicts.push({ path: directory, reason: error instanceof Error ? error.message : "backup_directory_cleanup_failed" });
      }
    }
  }
  if (conflicts.length) return { status: "conflict" as const, conflicts };
  await unlink(resolve(root, MANIFEST_PATH));
  return { status: "rolled_back" as const, conflicts: [] as Conflict[] };
}

export async function rollbackProjectAdapters(input: { projectRoot: string }) {
  return restoreProjectAdapters(input);
}

export async function uninstallProjectAdapters(input: { projectRoot: string }) {
  return restoreProjectAdapters(input);
}

export async function runProjectSetupCli(args = process.argv.slice(2)): Promise<number> {
  const [operation, ...rest] = args;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--") || !rest[index + 1]) return printCliError("invalid_arguments");
    flags.set(key, rest[index + 1]);
    index += 1;
  }
  const projectRoot = flags.get("--project-root");
  if (!projectRoot) return printCliError("missing --project-root");
  try {
    let result: unknown;
    if (operation === "setup" || operation === "preview") {
      const tyrantRoot = flags.get("--tyrant-root");
      const hosts = flags.get("--hosts")?.split(",").map((host) => host.trim()).filter(Boolean) as ProjectAdapterHost[] | undefined;
      if (!tyrantRoot || !hosts?.length) return printCliError("setup and preview need --tyrant-root and --hosts");
      const options = { projectRoot, tyrantRoot, hosts };
      result = operation === "preview" ? await previewProjectAdapters(options) : await installProjectAdapters(options);
    } else if (operation === "status" || operation === "repair") result = await getProjectAdapterStatus({ projectRoot });
    else if (operation === "rollback" || operation === "uninstall") result = await restoreProjectAdapters({ projectRoot });
    else return printCliError("usage: preview|setup|status|repair|rollback|uninstall --project-root <path> [--tyrant-root <path> --hosts codex,claude-code,opencode,dsh,claude-desktop]");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return (result as { status?: string }).status === "conflict" ? 2 : 0;
  } catch (error) {
    return printCliError(error instanceof Error ? error.message : "setup_failed");
  }
}

function printCliError(message: string): number {
  process.stderr.write(`[tyrant-setup] ${message}\n`);
  return 2;
}

if (import.meta.main) process.exitCode = await runProjectSetupCli();
