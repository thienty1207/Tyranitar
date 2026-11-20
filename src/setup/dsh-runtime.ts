import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_NAME = "tyrant-engine";

export type DshRuntimeCommandResult = { exitCode: number; stdout: string; stderr: string };
export type DshRuntimeOptions = {
  tyrantRoot: string;
  profile?: string;
  command?: string | null;
  env?: Record<string, string | undefined>;
  runCommand?: (command: string, args: string[], cwd: string, env: Record<string, string>) => Promise<DshRuntimeCommandResult>;
};
export type DshPluginResult = {
  status: "installed" | "ready" | "not_detected";
  profile: string;
  package_root?: string;
};

function profileName(options: DshRuntimeOptions, env: Record<string, string | undefined>): string {
  const selected = options.profile?.trim() || env.TYRANT_DSH_PROFILE?.trim() || "desktop";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(selected)) throw new Error("dsh_profile_name_invalid");
  return selected;
}

function dshHome(env: Record<string, string | undefined>): string {
  const explicit = env.DSH_HOME?.trim();
  if (explicit) return resolve(explicit);
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();
  return join(resolve(home), ".dsh");
}

function fileSpec(root: string): string {
  return `file:${root.replaceAll("\\", "/")}`;
}

function sameFileSpec(value: unknown, root: string): boolean {
  if (typeof value !== "string" || !value.startsWith("file:")) return false;
  const installedPath = value.slice("file:".length);
  const normalizedInstalled = resolve(installedPath).replaceAll("\\", "/");
  const normalizedRoot = resolve(root).replaceAll("\\", "/");
  return process.platform === "win32"
    ? normalizedInstalled.toLocaleLowerCase("en-US") === normalizedRoot.toLocaleLowerCase("en-US")
    : normalizedInstalled === normalizedRoot;
}

async function readInstalledSpec(profileRoot: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(profileRoot, "package.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("dsh_profile_config_unreadable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("dsh_profile_config_invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("dsh_profile_config_invalid");
  const value = parsed as Record<string, unknown>;
  const dependencies = value.dependencies;
  if (dependencies !== undefined && (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies))) {
    throw new Error("dsh_profile_config_invalid");
  }
  const devDependencies = value.devDependencies;
  if (devDependencies !== undefined && (typeof devDependencies !== "object" || devDependencies === null || Array.isArray(devDependencies))) {
    throw new Error("dsh_profile_config_invalid");
  }
  return (dependencies as Record<string, unknown> | undefined)?.[PACKAGE_NAME] as string | undefined
    ?? (devDependencies as Record<string, unknown> | undefined)?.[PACKAGE_NAME] as string | undefined;
}

async function installedPluginMatches(profileRoot: string, packageRoot: string): Promise<boolean> {
  try {
    const [source, installed] = await Promise.all([
      readFile(join(packageRoot, "integrations", "dsh", "index.js")),
      readFile(join(profileRoot, "node_modules", PACKAGE_NAME, "integrations", "dsh", "index.js")),
    ]);
    return createHash("sha256").update(installed).digest("hex") === createHash("sha256").update(source).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("dsh_plugin_verification_failed");
  }
}

async function refreshCopiedPluginBundle(profileRoot: string, packageRoot: string): Promise<boolean> {
  const packagePath = join(profileRoot, "node_modules", PACKAGE_NAME);
  const integrationPath = join(packagePath, "integrations");
  const dshPath = join(integrationPath, "dsh");
  const bundlePath = join(dshPath, "index.js");
  const sourcePath = join(packageRoot, "integrations", "dsh", "index.js");

  try {
    const packageInfo = await lstat(packagePath);
    const integrationInfo = await lstat(integrationPath);
    const dshInfo = await lstat(dshPath);
    const bundleInfo = await lstat(bundlePath);
    if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()
      || !integrationInfo.isDirectory() || integrationInfo.isSymbolicLink()
      || !dshInfo.isDirectory() || dshInfo.isSymbolicLink()
      || !bundleInfo.isFile() || bundleInfo.isSymbolicLink()) return false;

    const installedManifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")) as unknown;
    if (typeof installedManifest !== "object" || installedManifest === null
      || (installedManifest as Record<string, unknown>).name !== PACKAGE_NAME) return false;

    const source = await readFile(sourcePath);
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const installed = await readFile(bundlePath);
    if (createHash("sha256").update(installed).digest("hex") === sourceHash) return true;

    const temporaryPath = `${bundlePath}.tyrant-update-${randomUUID()}.tmp`;
    const backupPath = `${bundlePath}.tyrant-backup-${randomUUID()}`;
    let previousMoved = false;
    try {
      await writeFile(temporaryPath, source, { flag: "wx" });
      const staged = await readFile(temporaryPath);
      if (createHash("sha256").update(staged).digest("hex") !== sourceHash) throw new Error("dsh_plugin_install_unverified");
      await rename(bundlePath, backupPath);
      previousMoved = true;
      try {
        await rename(temporaryPath, bundlePath);
      } catch {
        await rename(backupPath, bundlePath).catch(() => { throw new Error("dsh_profile_rollback_incomplete"); });
        previousMoved = false;
        return false;
      }

      const updated = await readFile(bundlePath);
      if (createHash("sha256").update(updated).digest("hex") !== sourceHash) {
        await unlink(bundlePath).catch(() => undefined);
        await rename(backupPath, bundlePath).catch(() => { throw new Error("dsh_profile_rollback_incomplete"); });
        previousMoved = false;
        throw new Error("dsh_plugin_install_unverified");
      }
      await unlink(backupPath).catch(() => undefined);
      previousMoved = false;
      return true;
    } catch (error) {
      if (previousMoved) {
        await lstat(bundlePath).then(
          () => { throw new Error("dsh_profile_rollback_incomplete"); },
          async (statError) => {
            if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
            await rename(backupPath, bundlePath).catch(() => { throw new Error("dsh_profile_rollback_incomplete"); });
          },
        );
      }
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof Error && ["dsh_plugin_install_unverified", "dsh_profile_rollback_incomplete"].includes(error.message)) throw error;
      return false;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "dsh_profile_rollback_incomplete") throw error;
    return false;
  }
}

type DetachedPluginEntry = { linkPath: string; backupPath: string; kind: "link" | "directory" };

async function moveAsideStalePluginEntry(profileRoot: string, packageRoot: string): Promise<DetachedPluginEntry | undefined> {
  const linkPath = join(profileRoot, "node_modules", PACKAGE_NAME);
  let info;
  try {
    info = await lstat(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("dsh_profile_config_unreadable");
  }
  let kind: DetachedPluginEntry["kind"];
  if (info.isSymbolicLink()) {
    let target: string;
    try {
      const rawTarget = await readlink(linkPath);
      target = resolve(linkPath, "..", rawTarget);
    } catch {
      throw new Error("dsh_plugin_verification_failed");
    }
    if (sameFileSpec(`file:${target}`, packageRoot)) return undefined;
    try {
      const targetManifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as unknown;
      if (typeof targetManifest !== "object" || targetManifest === null || (targetManifest as Record<string, unknown>).name !== PACKAGE_NAME) return undefined;
    } catch {
      return undefined;
    }
    kind = "link";
  } else if (info.isDirectory()) {
    // DSH/pnpm may copy a local file dependency into node_modules instead of
    // creating a junction. Only move a directory whose manifest identifies it
    // as Tyrant; never displace an unrelated package or user directory.
    try {
      const installedManifest = JSON.parse(await readFile(join(linkPath, "package.json"), "utf8")) as unknown;
      if (typeof installedManifest !== "object" || installedManifest === null || (installedManifest as Record<string, unknown>).name !== PACKAGE_NAME) return undefined;
    } catch {
      return undefined;
    }
    kind = "directory";
  } else {
    return undefined;
  }

  const backupPath = `${linkPath}.tyrant-backup-${randomUUID()}`;
  try {
    await rename(linkPath, backupPath);
  } catch {
    throw new Error("dsh_profile_busy");
  }
  return { linkPath, backupPath, kind };
}

async function restorePluginEntry(detached: DetachedPluginEntry | undefined): Promise<void> {
  if (!detached) return;
  try {
    await lstat(detached.linkPath);
    throw new Error("dsh_profile_rollback_incomplete");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(detached.backupPath, detached.linkPath);
  } catch {
    throw new Error("dsh_profile_rollback_incomplete");
  }
}

async function runDsh(command: string, args: string[], cwd: string, env: Record<string, string>): Promise<DshRuntimeCommandResult> {
  try {
    const child = Bun.spawn([command, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(code && ["EPERM", "EACCES", "EBUSY"].includes(code) ? "dsh_profile_busy" : "dsh_plugin_install_failed");
  }
}

export async function ensureDshPlugin(options: DshRuntimeOptions): Promise<DshPluginResult> {
  const env = options.env ?? process.env;
  const selectedProfile = profileName(options, env);
  const command = options.command === undefined
    ? env.TYRANT_DSH_BIN?.trim() || Bun.which("dsh") || null
    : options.command?.trim() || null;
  if (!command) return { status: "not_detected", profile: selectedProfile };

  const packageRoot = resolve(options.tyrantRoot);
  const profileRoot = join(dshHome(env), "profiles", selectedProfile);
  const installedSpec = await readInstalledSpec(profileRoot);
  if (sameFileSpec(installedSpec, packageRoot)) {
    if (await installedPluginMatches(profileRoot, packageRoot)) {
      return { status: "ready", profile: selectedProfile, package_root: packageRoot };
    }
    if (await refreshCopiedPluginBundle(profileRoot, packageRoot)) {
      return { status: "installed", profile: selectedProfile, package_root: packageRoot };
    }
  }

  await mkdir(profileRoot, { recursive: true });
  const detached = await moveAsideStalePluginEntry(profileRoot, packageRoot);
  const args = ["plugin", "--profile", selectedProfile, "add", "--ignore-scripts", fileSpec(packageRoot)];
  try {
    const result = await (options.runCommand ?? runDsh)(command, args, profileRoot, { ...process.env, ...env } as Record<string, string>);
    if (result.exitCode !== 0) {
      const errorText = `${result.stdout}\n${result.stderr}`;
      if (/\b(?:EPERM|EACCES|EBUSY|resource busy|permission denied)\b/i.test(errorText)) throw new Error("dsh_profile_busy");
      throw new Error("dsh_plugin_install_failed");
    }
    const verifiedSpec = await readInstalledSpec(profileRoot);
    if (!sameFileSpec(verifiedSpec, packageRoot) || !await installedPluginMatches(profileRoot, packageRoot)) {
      throw new Error("dsh_plugin_install_unverified");
    }
  } catch (error) {
    await restorePluginEntry(detached);
    throw error;
  }
  if (detached) {
    if (detached.kind === "link") await unlink(detached.backupPath).catch(() => undefined);
    else await rm(detached.backupPath, { recursive: true, force: true }).catch(() => undefined);
  }
  return { status: "installed", profile: selectedProfile, package_root: packageRoot };
}
