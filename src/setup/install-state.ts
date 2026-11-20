import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProjectAdapterHost } from "../adapters/project-setup";
import { canonicalPathIdentity } from "../state/path-identity";
import { getTyrantUserDirectory } from "./profiles";

export type RegisteredProject = { project_root: string; hosts: ProjectAdapterHost[] };
export type TyrantInstallState = { schema_version: 1; dsh_profile: string; projects: RegisteredProject[] };
export type InstallStateOptions = { stateDirectory?: string; env?: Record<string, string | undefined> };

const STATE_FILE = "installation.json";
const MAX_STATE_BYTES = 2_000_000;
const MAX_REGISTERED_PROJECTS = 2_000;
const ALLOWED_HOSTS = new Set<ProjectAdapterHost>(["codex", "claude-code", "opencode", "dsh", "claude-desktop"]);

function statePath(options: InstallStateOptions): string {
  return join(resolve(options.stateDirectory ?? getTyrantUserDirectory(options.env)), STATE_FILE);
}

function validProfile(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
}

function projectKey(value: string): string {
  return canonicalPathIdentity(value);
}

function parseState(value: unknown): TyrantInstallState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("install_state_invalid");
  const state = value as Record<string, unknown>;
  if (state.schema_version !== 1 || !validProfile(state.dsh_profile) || !Array.isArray(state.projects) || state.projects.length > MAX_REGISTERED_PROJECTS) {
    throw new Error("install_state_invalid");
  }
  const seen = new Set<string>();
  const projects = state.projects.map((item): RegisteredProject => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("install_state_invalid");
    const project = item as Record<string, unknown>;
    if (typeof project.project_root !== "string" || !project.project_root || project.project_root.length > 4096 || !isAbsolute(project.project_root)
      || !Array.isArray(project.hosts) || !project.hosts.length || project.hosts.some((host) => typeof host !== "string" || !ALLOWED_HOSTS.has(host as ProjectAdapterHost))) {
      throw new Error("install_state_invalid");
    }
    const key = projectKey(project.project_root);
    if (seen.has(key)) throw new Error("install_state_invalid");
    seen.add(key);
    return { project_root: resolve(project.project_root), hosts: [...new Set(project.hosts as ProjectAdapterHost[])] };
  });
  return { schema_version: 1, dsh_profile: state.dsh_profile, projects };
}

async function readState(path: string): Promise<TyrantInstallState> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) throw new Error("install_state_file_not_regular");
    return parseState(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema_version: 1, dsh_profile: "desktop", projects: [] };
    if (error instanceof SyntaxError) throw new Error("install_state_invalid");
    throw error;
  }
}

async function writeState(path: string, state: TyrantInstallState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
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
        const lockInfo = await lstat(lockPath);
        if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) throw new Error("install_state_lock_unsafe");
        const [pidText, createdText] = (await readFile(lockPath, "utf8")).trim().split(/\s+/);
        const pid = Number(pidText);
        const createdAt = Number(createdText);
        let alive = true;
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (processError) { alive = (processError as NodeJS.ErrnoException).code === "EPERM"; }
        }
        if (!alive && Date.now() - createdAt > 1_000) await unlink(lockPath).catch(() => undefined);
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
      }
      if (Date.now() >= deadline) throw new Error("install_state_lock_timeout");
      await Bun.sleep(25);
    }
  }
  try { return await action(); }
  finally {
    await handle?.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function loadInstallState(options: InstallStateOptions = {}): Promise<TyrantInstallState> {
  return readState(statePath(options));
}

export async function saveDshProfile(profile: string, options: InstallStateOptions = {}): Promise<TyrantInstallState> {
  if (!validProfile(profile)) throw new Error("dsh_profile_name_invalid");
  const path = statePath(options);
  return withLock(path, async () => {
    const state = await readState(path);
    const updated = { ...state, dsh_profile: profile };
    await writeState(path, updated);
    return updated;
  });
}

export async function registerInstalledProject(
  projectRoot: string,
  hosts: ProjectAdapterHost[],
  options: InstallStateOptions = {},
): Promise<TyrantInstallState> {
  if (!hosts.length || hosts.some((host) => !ALLOWED_HOSTS.has(host))) throw new Error("install_state_host_invalid");
  let canonicalRoot: string;
  try { canonicalRoot = await realpath(resolve(projectRoot)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("project_root_missing");
    throw error;
  }
  const info = await lstat(canonicalRoot);
  if (!info.isDirectory()) throw new Error("project_root_not_directory");
  const path = statePath(options);
  return withLock(path, async () => {
    const state = await readState(path);
    const key = projectKey(canonicalRoot);
    const projects = state.projects.filter((item) => projectKey(item.project_root) !== key);
    if (projects.length >= MAX_REGISTERED_PROJECTS) throw new Error("install_state_project_limit_reached");
    projects.push({ project_root: canonicalRoot, hosts: [...new Set(hosts)] });
    const updated = { ...state, projects };
    await writeState(path, updated);
    return updated;
  });
}
