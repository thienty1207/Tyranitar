import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, win32 } from "node:path";

export type VaultProfile = {
  id: string;
  name: string;
  vaultPath: string;
  endpoint: string;
  configPath: string;
  tokenFile?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProfileRegistry = {
  schemaVersion: 1;
  defaultProfileId: string | null;
  profiles: VaultProfile[];
};

export type ProjectScope = { workspace: string; project: string };

export type ProjectBinding = {
  schemaVersion: 1;
  projectId: string;
  projectRoot: string;
  profileId: string;
  scope: ProjectScope;
  scopeSource?: "tyrant" | "ai-memory-config";
  scopeFingerprint?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProfileStoreOptions = {
  stateDirectory?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
};

const REGISTRY_FILE = "profiles.json";
const PROJECT_BINDING_FILE = join(".tyrant", "project.json");

function platformPath(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

export function getTyrantUserDirectory(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  const paths = platformPath(platform);
  const explicit = env.TYRANT_STATE_DIR?.trim();
  if (explicit) return paths.resolve(explicit);
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) return paths.join(paths.resolve(localAppData), "Tyrant");
    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) return paths.join(paths.resolve(userProfile), "AppData", "Local", "Tyrant");
    throw new Error("user_state_directory_unavailable");
  }
  const stateHome = env.XDG_STATE_HOME?.trim();
  if (stateHome) return paths.join(paths.resolve(stateHome), "tyrant");
  const home = env.HOME?.trim();
  if (home) return paths.join(paths.resolve(home), ".local", "state", "tyrant");
  throw new Error("user_state_directory_unavailable");
}

export function resolveVaultPath(vaultPath?: string, cwd = process.cwd(), platform: NodeJS.Platform = process.platform): string {
  const paths = platformPath(platform);
  const selected = vaultPath?.trim() || cwd;
  return paths.normalize(paths.resolve(cwd, selected));
}

function stateDirectory(options: ProfileStoreOptions = {}): string {
  const platform = options.platform ?? process.platform;
  return options.stateDirectory?.trim()
    ? platformPath(platform).resolve(options.stateDirectory)
    : getTyrantUserDirectory(options.env, platform);
}

function registryFile(options: ProfileStoreOptions = {}): string {
  return join(stateDirectory(options), REGISTRY_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateProfile(value: unknown): VaultProfile {
  if (!isRecord(value)
    || !nonEmptyString(value.id)
    || !nonEmptyString(value.name)
    || !nonEmptyString(value.vaultPath)
    || !nonEmptyString(value.endpoint)
    || !nonEmptyString(value.configPath)
    || !nonEmptyString(value.createdAt)
    || !nonEmptyString(value.updatedAt)
    || (value.tokenFile !== undefined && !nonEmptyString(value.tokenFile))) {
    throw new Error("profile_registry_invalid");
  }
  return {
    id: value.id.trim(),
    name: value.name.trim(),
    vaultPath: value.vaultPath,
    endpoint: normalizeEndpoint(value.endpoint),
    configPath: value.configPath,
    ...(typeof value.tokenFile === "string" ? { tokenFile: value.tokenFile } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function validateRegistry(value: unknown, platform: NodeJS.Platform): ProfileRegistry {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.profiles)
    || !(value.defaultProfileId === null || nonEmptyString(value.defaultProfileId))) {
    throw new Error("profile_registry_invalid");
  }
  const profiles = value.profiles.map(validateProfile);
  const ids = new Set<string>();
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const profile of profiles) {
    const nameKey = normalizeName(profile.name);
    const pathKey = profilePathKey(profile.vaultPath, platform);
    if (ids.has(profile.id) || names.has(nameKey) || paths.has(pathKey)) throw new Error("profile_registry_invalid");
    ids.add(profile.id);
    names.add(nameKey);
    paths.add(pathKey);
  }
  if (value.defaultProfileId !== null && !ids.has(value.defaultProfileId)) throw new Error("profile_registry_invalid");
  return { schemaVersion: 1, defaultProfileId: value.defaultProfileId as string | null, profiles };
}

function normalizeEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("profile_endpoint_invalid");
  }
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("profile_endpoint_must_be_loopback");
  }
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("profile_endpoint_port_invalid");
  const path = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = path.endsWith("/mcp") ? path : `${path}/mcp`;
  return endpoint.toString().replace(/\/$/, "");
}

function normalizeName(name: string): string {
  const value = name.trim().normalize("NFKC");
  if (!value || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("profile_name_invalid");
  return value.toLocaleLowerCase("en-US");
}

function profilePathKey(path: string, platform: NodeJS.Platform): string {
  const paths = platformPath(platform);
  const normalized = paths.normalize(paths.resolve(path));
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

async function canonicalDirectory(path: string, notFoundCode: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(resolve(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(notFoundCode);
    throw error;
  }
  const info = await lstat(canonical);
  if (!info.isDirectory()) throw new Error("path_not_directory");
  return canonical;
}

async function readJsonFile(path: string, invalidCode = "profile_file_invalid"): Promise<unknown> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("profile_file_not_regular");
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    if (error instanceof SyntaxError) throw new Error(invalidCode);
    throw error;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function loadProfileRegistry(options: ProfileStoreOptions = {}): Promise<ProfileRegistry> {
  const path = registryFile(options);
  try {
    return validateRegistry(await readJsonFile(path), options.platform ?? process.platform);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, defaultProfileId: null, profiles: [] };
    throw error;
  }
}

async function withRegistryLock<T>(options: ProfileStoreOptions, action: () => Promise<T>): Promise<T> {
  const lockPath = `${registryFile(options)}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 15_000;
  let handle;
  for (;;) {
    let opened;
    try {
      opened = await open(lockPath, "wx", 0o600);
      await opened.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
      handle = opened;
      break;
    } catch (error) {
      if (opened) {
        await opened.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const [pidText, createdText] = (await readFile(lockPath, "utf8")).trim().split(/\s+/);
        const pid = Number(pidText);
        const createdAt = Number(createdText);
        let alive = true;
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (processError) { alive = (processError as NodeJS.ErrnoException).code === "EPERM"; }
        }
        if (Number.isFinite(createdAt) && Date.now() - createdAt > 30_000 && !alive) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      if (Date.now() >= deadline) throw new Error("profile_registry_lock_timeout");
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

export function getDefaultVaultProfile(registry: ProfileRegistry): VaultProfile {
  if (!registry.defaultProfileId) throw new Error("profile_default_missing");
  const profile = registry.profiles.find((candidate) => candidate.id === registry.defaultProfileId);
  if (!profile) throw new Error("profile_not_found");
  return profile;
}

export function resolveVaultProfile(registry: ProfileRegistry, selector: string): VaultProfile {
  const key = selector.trim().normalize("NFKC").toLocaleLowerCase("en-US");
  const profile = registry.profiles.find((candidate) => candidate.id === selector)
    ?? registry.profiles.find((candidate) => normalizeName(candidate.name) === key);
  if (!profile) throw new Error("profile_not_found");
  return profile;
}

export type VaultProfileIdentityCandidate = { id: string; name: string; vaultPath: string; existingProfile?: VaultProfile };

export async function prepareVaultProfileIdentity(
  input: { vaultPath: string; name?: string },
  options: ProfileStoreOptions = {},
): Promise<VaultProfileIdentityCandidate> {
  if (!nonEmptyString(input.vaultPath)) throw new Error("vault_path_missing");
  const platform = options.platform ?? process.platform;
  const paths = platformPath(platform);
  const vaultPath = await canonicalDirectory(input.vaultPath, "vault_path_missing");
  const registry = await loadProfileRegistry(options);
  const vaultKey = profilePathKey(vaultPath, platform);
  const existingProfile = registry.profiles.find((profile) => profilePathKey(profile.vaultPath, platform) === vaultKey);
  const name = input.name?.trim() || existingProfile?.name || paths.basename(vaultPath);
  const nameKey = normalizeName(name);
  const nameOwner = registry.profiles.find((profile) => normalizeName(profile.name) === nameKey && profile.id !== existingProfile?.id);
  if (nameOwner) throw new Error("profile_name_conflict");
  return {
    id: existingProfile?.id ?? randomUUID(),
    name,
    vaultPath,
    ...(existingProfile ? { existingProfile } : {}),
  };
}
export async function activateVaultProfile(
  input: { id?: string; vaultPath: string; name?: string; endpoint: string; configPath: string; tokenFile?: string },
  options: ProfileStoreOptions = {},
): Promise<VaultProfile> {
  const platform = options.platform ?? process.platform;
  const paths = platformPath(platform);
  if (!nonEmptyString(input.vaultPath) || !nonEmptyString(input.endpoint) || !nonEmptyString(input.configPath)) {
    throw new Error("profile_setup_incomplete");
  }
  if (input.id !== undefined && (!nonEmptyString(input.id) || input.id.length > 128 || /[\u0000-\u001f\u007f]/.test(input.id))) {
    throw new Error("profile_id_invalid");
  }
  if (input.tokenFile !== undefined && !nonEmptyString(input.tokenFile)) throw new Error("profile_token_file_invalid");
  const vaultPath = await canonicalDirectory(input.vaultPath, "vault_path_missing");
  const vaultKey = profilePathKey(vaultPath, platform);
  const name = input.name?.trim() || paths.basename(vaultPath);
  const nameKey = normalizeName(name);
  const endpoint = normalizeEndpoint(input.endpoint);
  const configPath = paths.resolve(input.configPath);
  const tokenFile = input.tokenFile ? paths.resolve(input.tokenFile) : undefined;
  return await withRegistryLock(options, async () => {
    const registryPath = registryFile(options);
    const registry = await loadProfileRegistry(options);
    const existingByPath = registry.profiles.find((profile) => profilePathKey(profile.vaultPath, platform) === vaultKey);
    if (existingByPath && input.id && input.id !== existingByPath.id) throw new Error("profile_identity_changed");
    const selectedId = existingByPath?.id ?? input.id ?? randomUUID();
    if (!existingByPath && registry.profiles.some((profile) => profile.id === selectedId)) throw new Error("profile_id_conflict");
    const nameOwner = registry.profiles.find((profile) => normalizeName(profile.name) === nameKey && profile.id !== existingByPath?.id);
    if (nameOwner) throw new Error("profile_name_conflict");

    const timestamp = new Date().toISOString();
    const profile: VaultProfile = existingByPath
      ? {
        ...existingByPath,
        name,
        vaultPath,
        endpoint,
        configPath,
        ...(tokenFile ? { tokenFile } : existingByPath.tokenFile ? { tokenFile: existingByPath.tokenFile } : {}),
        updatedAt: timestamp,
      }
      : {
        id: selectedId, name, vaultPath, endpoint, configPath,
        ...(tokenFile ? { tokenFile } : {}), createdAt: timestamp, updatedAt: timestamp,
      };
    const profiles = existingByPath
      ? registry.profiles.map((current) => current.id === existingByPath.id ? profile : current)
      : [...registry.profiles, profile];
    const updated: ProfileRegistry = { schemaVersion: 1, defaultProfileId: profile.id, profiles };
    await atomicWriteJson(registryPath, updated);
    return profile;
  });
}

function isBinding(value: unknown): value is ProjectBinding {
  if (!isRecord(value) || value.schemaVersion !== 1 || !nonEmptyString(value.projectId)
    || !nonEmptyString(value.projectRoot) || !nonEmptyString(value.profileId)
    || !isRecord(value.scope) || !validScopePart(value.scope.workspace) || !validScopePart(value.scope.project)
    || !nonEmptyString(value.createdAt) || !nonEmptyString(value.updatedAt)) return false;
  if (value.scopeSource !== undefined && value.scopeSource !== "tyrant" && value.scopeSource !== "ai-memory-config") return false;
  if (value.scopeFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(String(value.scopeFingerprint))) return false;
  return true;
}

async function projectBindingPath(projectRoot: string): Promise<{ root: string; path: string }> {
  const root = await canonicalDirectory(projectRoot, "project_root_missing");
  const directory = join(root, ".tyrant");
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("project_binding_directory_unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { root, path: join(directory, "project.json") };
}

function projectRootKey(projectRoot: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? projectRoot.toLocaleLowerCase("en-US") : projectRoot;
}

function stableProjectScope(projectRoot: string, profileId: string, platform: NodeJS.Platform): { projectId: string; scope: ProjectScope } {
  const normalizedRoot = projectRootKey(projectRoot, platform);
  const projectId = createHash("sha256").update(normalizedRoot).digest("hex");
  return {
    projectId,
    scope: { workspace: `tyrant-profile-${profileId}`, project: `project-${projectId}` },
  };
}

function validScopePart(value: unknown): value is string {
  return nonEmptyString(value) && value.trim() === value && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value);
}

function sameScope(left: ProjectScope, right: ProjectScope): boolean {
  return left.workspace === right.workspace && left.project === right.project;
}

export function readConfiguredProjectScope(projectRoot: string): ProjectScope | undefined {
  const path = join(resolve(projectRoot), ".ai-memory.toml");
  let raw: string;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("project_scope_config_unsafe");
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(raw) as unknown;
  } catch {
    throw new Error("project_scope_config_invalid");
  }
  if (!isRecord(parsed)) throw new Error("project_scope_config_invalid");
  const hasWorkspace = parsed.workspace !== undefined;
  const hasProject = parsed.project !== undefined;
  if (!hasWorkspace && !hasProject) return undefined;
  if (!validScopePart(parsed.workspace) || !validScopePart(parsed.project)) throw new Error("project_scope_incomplete");
  return { workspace: parsed.workspace, project: parsed.project };
}

function scopeFingerprint(projectId: string, profileId: string, scope: ProjectScope, source: "tyrant" | "ai-memory-config"): string {
  return createHash("sha256").update(JSON.stringify({ projectId, profileId, scope, source })).digest("hex");
}

function validateBindingIdentity(binding: ProjectBinding, root: string, profileId: string, platform: NodeJS.Platform): void {
  if (projectRootKey(binding.projectRoot, platform) !== projectRootKey(root, platform)) throw new Error("project_binding_root_mismatch");
  const identity = stableProjectScope(root, profileId, platform);
  if (binding.projectId !== identity.projectId) throw new Error("project_binding_identity_mismatch");
  const source = binding.scopeSource ?? "tyrant";
  const configuredScope = readConfiguredProjectScope(root);
  if (source === "tyrant") {
    if (!sameScope(binding.scope, identity.scope)) throw new Error("project_binding_scope_mismatch");
    if (configuredScope && !sameScope(configuredScope, binding.scope)) throw new Error("project_scope_conflicts_with_binding");
  } else {
    if (!configuredScope) throw new Error("project_scope_config_missing");
    if (!sameScope(configuredScope, binding.scope)) throw new Error("project_scope_conflicts_with_binding");
    if (!binding.scopeFingerprint) throw new Error("project_binding_scope_mismatch");
  }
  if (binding.scopeFingerprint && binding.scopeFingerprint !== scopeFingerprint(binding.projectId, profileId, binding.scope, source)) {
    throw new Error("project_binding_scope_mismatch");
  }
}

export async function deriveProjectProfileScope(
  projectRoot: string,
  profile: Pick<VaultProfile, "id">,
  options: ProfileStoreOptions = {},
): Promise<{ projectRoot: string; projectId: string; scope: ProjectScope }> {
  const platform = options.platform ?? process.platform;
  const canonicalRoot = await canonicalDirectory(projectRoot, "project_root_missing");
  return { projectRoot: canonicalRoot, ...stableProjectScope(canonicalRoot, profile.id, platform) };
}

export async function bindProjectProfile(
  input: { projectRoot: string; profile: VaultProfile; explicitRebind?: boolean; scope?: ProjectScope; scopeSource?: "tyrant" | "ai-memory-config" },
  options: ProfileStoreOptions = {},
): Promise<ProjectBinding> {
  const platform = options.platform ?? process.platform;
  const { root, path } = await projectBindingPath(input.projectRoot);
  let current: ProjectBinding | undefined;
  try {
    const parsed = await readJsonFile(path, "project_binding_invalid");
    if (!isBinding(parsed)) throw new Error("project_binding_invalid");
    current = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current && !input.explicitRebind) {
    validateBindingIdentity(current, root, current.profileId, platform);
    return current;
  }

  const identity = stableProjectScope(root, input.profile.id, platform);
  const source = input.scopeSource ?? "tyrant";
  const scope = input.scope ?? identity.scope;
  if (!validScopePart(scope.workspace) || !validScopePart(scope.project)) throw new Error("project_scope_incomplete");
  if (source === "tyrant" && !sameScope(scope, identity.scope)) throw new Error("project_binding_scope_mismatch");
  if (source === "ai-memory-config") {
    const configuredScope = readConfiguredProjectScope(root);
    if (!configuredScope || !sameScope(configuredScope, scope)) throw new Error("project_scope_conflicts_with_binding");
  }
  const timestamp = new Date().toISOString();
  const binding: ProjectBinding = {
    schemaVersion: 1,
    projectId: identity.projectId,
    projectRoot: root,
    profileId: input.profile.id,
    scope,
    scopeSource: source,
    scopeFingerprint: scopeFingerprint(identity.projectId, input.profile.id, scope, source),
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  await atomicWriteJson(path, binding);
  return binding;
}

export async function resolveProjectProfile(
  projectRoot: string,
  options: ProfileStoreOptions = {},
): Promise<{ profile: VaultProfile; binding: ProjectBinding } | undefined> {
  const platform = options.platform ?? process.platform;
  const { root, path } = await projectBindingPath(projectRoot);
  let parsed: unknown;
  try {
    parsed = await readJsonFile(path, "project_binding_invalid");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!isBinding(parsed)) throw new Error("project_binding_invalid");
  if (projectRootKey(parsed.projectRoot, platform) !== projectRootKey(root, platform)) throw new Error("project_binding_root_mismatch");
  const registry = await loadProfileRegistry(options);
  const profile = registry.profiles.find((candidate) => candidate.id === parsed.profileId);
  if (!profile) throw new Error("profile_not_found");
  validateBindingIdentity(parsed, root, profile.id, platform);
  return { profile, binding: parsed };
}

export function resolveProjectProfileSync(
  projectRoot: string,
  options: ProfileStoreOptions = {},
): { profile: VaultProfile; binding: ProjectBinding } | undefined {
  const platform = options.platform ?? process.platform;
  let root: string;
  try {
    root = realpathSync(resolve(projectRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("project_root_missing");
    throw error;
  }
  const tyrantDirectory = join(root, ".tyrant");
  try {
    const info = lstatSync(tyrantDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("project_binding_directory_unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const bindingPath = join(root, PROJECT_BINDING_FILE);
  let parsed: unknown;
  try {
    const info = lstatSync(bindingPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("profile_file_not_regular");
    parsed = JSON.parse(readFileSync(bindingPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error("project_binding_invalid");
    throw error;
  }
  if (!isBinding(parsed)) throw new Error("project_binding_invalid");
  if (projectRootKey(parsed.projectRoot, platform) !== projectRootKey(root, platform)) throw new Error("project_binding_root_mismatch");
  let registry: ProfileRegistry;
  try {
    const registryPath = registryFile(options);
    const info = lstatSync(registryPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("profile_file_not_regular");
    registry = validateRegistry(JSON.parse(readFileSync(registryPath, "utf8")) as unknown, platform);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") registry = { schemaVersion: 1, defaultProfileId: null, profiles: [] };
    else if (error instanceof SyntaxError) throw new Error("profile_file_invalid");
    else throw error;
  }
  const profile = registry.profiles.find((candidate) => candidate.id === parsed.profileId);
  if (!profile) throw new Error("profile_not_found");
  validateBindingIdentity(parsed, root, profile.id, platform);
  return { profile, binding: parsed };
}
