import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { ensureDshPlugin, type DshRuntimeOptions } from "../src/setup/dsh-runtime";

const root = await mkdtemp(join(tmpdir(), "tyrant-dsh-runtime-"));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture(name: string) {
  const base = join(root, name);
  const engine = join(base, "engine");
  const dshHome = join(base, ".dsh");
  const profileRoot = join(dshHome, "profiles", "desktop");
  await mkdir(engine, { recursive: true });
  await mkdir(join(engine, "integrations", "dsh"), { recursive: true });
  await mkdir(profileRoot, { recursive: true });
  await writeFile(join(engine, "package.json"), JSON.stringify({ name: "tyrant-engine", version: "0.1.0" }));
  await writeFile(join(engine, "integrations", "dsh", "index.js"), "export const tyrantIntegrationVersion = 'fixture';\n");
  return { base, engine, dshHome, profileRoot, env: { DSH_HOME: dshHome } };
}

async function writeProfile(profileRoot: string, value: unknown) {
  await writeFile(join(profileRoot, "package.json"), JSON.stringify(value));
}

async function writeInstalledBundle(profileRoot: string, engine: string, value?: string) {
  const installed = join(profileRoot, "node_modules", "tyrant-engine", "integrations", "dsh");
  await mkdir(installed, { recursive: true });
  await writeFile(join(profileRoot, "node_modules", "tyrant-engine", "package.json"), JSON.stringify({ name: "tyrant-engine", version: "0.1.0" }));
  await writeFile(join(installed, "index.js"), value ?? await readFile(join(engine, "integrations", "dsh", "index.js"), "utf8"));
}

async function createOldEngine(f: Awaited<ReturnType<typeof fixture>>) {
  const oldEngine = join(f.base, "old-engine");
  await mkdir(join(oldEngine, "integrations", "dsh"), { recursive: true });
  await writeFile(join(oldEngine, "package.json"), JSON.stringify({ name: "tyrant-engine", version: "0.0.1" }));
  await writeFile(join(oldEngine, "integrations", "dsh", "index.js"), "old Tyrant bundle\n");
  const linkPath = join(f.profileRoot, "node_modules", "tyrant-engine");
  await mkdir(join(f.profileRoot, "node_modules"), { recursive: true });
  await symlink(oldEngine, linkPath, process.platform === "win32" ? "junction" : "dir");
  return { oldEngine, linkPath };
}

function options(f: Awaited<ReturnType<typeof fixture>>, extra: Partial<DshRuntimeOptions> = {}): DshRuntimeOptions {
  return { tyrantRoot: f.engine, profile: "desktop", env: f.env, command: "dsh-test", ...extra };
}

test("installs Tyrant into the selected DSH profile without running package scripts", async () => {
  const f = await fixture("install");
  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await ensureDshPlugin(options(f, {
    runCommand: async (command, args) => {
      calls.push({ command, args });
      await writeProfile(f.profileRoot, { dependencies: { "tyrant-engine": `file:${f.engine.replaceAll("\\", "/")}` } });
      await writeInstalledBundle(f.profileRoot, f.engine);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  }));

  expect(result).toMatchObject({ status: "installed", profile: "desktop" });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    command: "dsh-test",
    args: ["plugin", "--profile", "desktop", "add", "--ignore-scripts", `file:${f.engine.replaceAll("\\", "/")}`],
  });
  expect(JSON.parse(await readFile(join(f.profileRoot, "package.json"), "utf8")).dependencies["tyrant-engine"])
    .toBe(`file:${f.engine.replaceAll("\\", "/")}`);
});

test("does not reinstall the plugin when its installed path already matches", async () => {
  const f = await fixture("already-installed");
  const packageSpec = `file:${f.engine.replaceAll("\\", "/")}`;
  await writeProfile(f.profileRoot, { dependencies: { "tyrant-engine": packageSpec } });
  await writeInstalledBundle(f.profileRoot, f.engine);
  let calls = 0;

  const result = await ensureDshPlugin(options(f, {
    runCommand: async () => { calls += 1; return { exitCode: 0, stdout: "", stderr: "" }; },
  }));

  expect(result).toMatchObject({ status: "ready", profile: "desktop" });
  expect(calls).toBe(0);
});

test("updates a stale Tyrant path once and then remains idempotent", async () => {
  const f = await fixture("stale-install");
  await writeProfile(f.profileRoot, { dependencies: { "tyrant-engine": "file:D:/Working/Tyrant-Engine" } });
  let calls = 0;
  const setup = options(f, {
    runCommand: async () => {
      calls += 1;
      await writeProfile(f.profileRoot, { dependencies: { "tyrant-engine": `file:${f.engine.replaceAll("\\", "/")}` } });
      await writeInstalledBundle(f.profileRoot, f.engine);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const first = await ensureDshPlugin(setup);
  const second = await ensureDshPlugin(setup);

  expect(first.status).toBe("installed");
  expect(second.status).toBe("ready");
  expect(calls).toBe(1);
});

test("refreshes only a stale copied integration bundle when the DSH package already points at this checkout", async () => {
  const f = await fixture("stale-bundle");
  await writeProfile(f.profileRoot, { dependencies: { "tyrant-engine": `file:${f.engine.replaceAll("\\", "/")}` } });
  await writeInstalledBundle(f.profileRoot, f.engine, "old bundled integration\n");
  const packageRoot = join(f.profileRoot, "node_modules", "tyrant-engine");
  await writeFile(join(packageRoot, "preserve-me.txt"), "package files stay intact\n");
  let calls = 0;

  const result = await ensureDshPlugin(options(f, {
    runCommand: async () => {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  }));

  expect(result.status).toBe("installed");
  expect(calls).toBe(0);
  expect(await readFile(join(packageRoot, "integrations", "dsh", "index.js"), "utf8"))
    .toBe(await readFile(join(f.engine, "integrations", "dsh", "index.js"), "utf8"));
  expect(await readFile(join(packageRoot, "preserve-me.txt"), "utf8")).toBe("package files stay intact\n");
  expect(await readdir(join(f.profileRoot, "node_modules"))).toEqual(["tyrant-engine"]);
});

test("moves aside only the stale Tyrant junction before DSH replaces its package link", async () => {
  const f = await fixture("stale-junction");
  const { oldEngine, linkPath } = await createOldEngine(f);
  await writeProfile(f.profileRoot, { dependencies: { "tyrant-engine": `file:${f.engine.replaceAll("\\", "/")}` } });
  let staleLinkDetached = false;

  const result = await ensureDshPlugin(options(f, {
    runCommand: async (_command, _args, cwd) => {
      staleLinkDetached = cwd === f.profileRoot && await lstat(linkPath).then(() => false, () => true);
      await writeProfile(f.profileRoot, { dependencies: { "tyrant-engine": `file:${f.engine.replaceAll("\\", "/")}` } });
      await symlink(f.engine, linkPath, process.platform === "win32" ? "junction" : "dir");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  }));

  expect(staleLinkDetached).toBe(true);
  expect(result.status).toBe("installed");
  expect(await realpath(linkPath)).toBe(await realpath(f.engine));
  expect(await readdir(join(f.profileRoot, "node_modules"))).toEqual(["tyrant-engine"]);
  expect(await realpath(oldEngine)).toBe(oldEngine);
});

test("restores the previous DSH plugin junction when package replacement fails", async () => {
  const f = await fixture("stale-junction-rollback");
  const { oldEngine, linkPath } = await createOldEngine(f);
  await writeProfile(f.profileRoot, { dependencies: { "tyrant-engine": `file:${oldEngine.replaceAll("\\", "/")}` } });

  await expect(ensureDshPlugin(options(f, {
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "[ERR_PNPM_EPERM] EPERM: operation not permitted" }),
  }))).rejects.toThrow("dsh_profile_busy");

  expect(await realpath(linkPath)).toBe(await realpath(oldEngine));
});

test("restores a stale copied Tyrant package when DSH replacement fails", async () => {
  const f = await fixture("stale-copy-rollback");
  const { oldEngine, linkPath } = await createOldEngine(f);
  await rm(linkPath, { recursive: true, force: true });
  await writeProfile(f.profileRoot, { dependencies: { "tyrant-engine": `file:${oldEngine.replaceAll("\\", "/")}` } });
  await writeInstalledBundle(f.profileRoot, f.engine, "previous Tyrant bundle\n");
  const installedPath = join(f.profileRoot, "node_modules", "tyrant-engine");

  await expect(ensureDshPlugin(options(f, {
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "install failed" }),
  }))).rejects.toThrow("dsh_plugin_install_failed");

  expect(await readFile(join(installedPath, "integrations", "dsh", "index.js"), "utf8")).toBe("previous Tyrant bundle\n");
  expect(await readdir(join(f.profileRoot, "node_modules"))).toEqual(["tyrant-engine"]);
});

test("reports DSH as not detected without claiming setup succeeded", async () => {
  const f = await fixture("not-detected");
  const result = await ensureDshPlugin(options(f, { command: null }));
  expect(result).toMatchObject({ status: "not_detected", profile: "desktop" });
});

test("creates a missing selected DSH profile directory before asking DSH to install the plugin", async () => {
  const f = await fixture("new-profile");
  await rm(f.profileRoot, { recursive: true, force: true });
  let cwdExistedAtInstall = false;

  const result = await ensureDshPlugin(options(f, {
    runCommand: async (_command, _args, cwd) => {
      cwdExistedAtInstall = cwd === f.profileRoot && (await readFile(join(cwd, "package.json")).catch(() => undefined)) === undefined;
      await writeProfile(f.profileRoot, { dependencies: { "tyrant-engine": `file:${f.engine.replaceAll("\\", "/")}` } });
      await writeInstalledBundle(f.profileRoot, f.engine);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  }));

  expect(cwdExistedAtInstall).toBe(true);
  expect(result.status).toBe("installed");
});

test("rejects malformed DSH profile metadata without attempting an install", async () => {
  const f = await fixture("malformed-profile");
  await writeFile(join(f.profileRoot, "package.json"), "{broken");
  let calls = 0;

  await expect(ensureDshPlugin(options(f, {
    runCommand: async () => { calls += 1; return { exitCode: 0, stdout: "", stderr: "" }; },
  }))).rejects.toThrow("dsh_profile_config_invalid");
  expect(calls).toBe(0);
});
