import { afterAll, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTyrantCli, type TyrantCliDependencies } from "../src/cli";
import { loadInstallState } from "../src/setup/install-state";
import { activateVaultProfile, bindProjectProfile, loadProfileRegistry } from "../src/setup/profiles";

const root = await mkdtemp(join(tmpdir(), "tyrant-cli-setup-"));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture(name: string) {
  const directory = join(root, name);
  const stateDirectory = join(directory, "state");
  const vaultA = join(directory, "vault alpha");
  const vaultB = join(directory, "vault beta");
  const project = join(directory, "project");
  await Promise.all([mkdir(vaultA, { recursive: true }), mkdir(vaultB, { recursive: true }), mkdir(project, { recursive: true })]);
  return { directory, stateDirectory, vaultA, vaultB, project };
}

function dependencies(f: Awaited<ReturnType<typeof fixture>>, extra: Partial<TyrantCliDependencies> = {}) {
  const output: string[] = [];
  const calls: Array<{ kind: string; value: unknown }> = [];
  const deps: TyrantCliDependencies = {
    cwd: f.project,
    tyrantRoot: f.directory,
    stateDirectory: f.stateDirectory,
    env: {},
    ensureAiMemory: async (profile) => {
      calls.push({ kind: "memory", value: profile });
      return { endpoint: profile.endpoint.replace(":0/", ":55001/"), authStatus: "ready", version: "3.4.7" };
    },
    ensureGraphify: async () => { calls.push({ kind: "graphify", value: null }); return { status: "ready", source: "system", version: "0.9.109", executable: "graphify.exe" }; },
    ensureDshPlugin: async (options) => { calls.push({ kind: "dsh", value: options }); return { status: "installed", profile: options.profile ?? "desktop", package_root: options.tyrantRoot }; },
    graphifyStatus: async () => ({ status: "ready", source: "system", version: "0.9.109", executable: "graphify.exe" }),
    previewAdapters: async (options) => ({ status: "ready", project_root: options.projectRoot, changes: [], hosts: {}, manual_actions: [], conflicts: [] }),
    installAdapters: async (options) => { calls.push({ kind: "adapters", value: options }); return { status: "installed", project_root: options.projectRoot, manual_actions: [], conflicts: [], hosts: {} }; },
    adapterStatus: async () => ({ status: "installed", hosts: {}, conflicts: [], installation_id: "fixture-installation" }),
    write: (_stream, value) => output.push(value),
    ...extra,
  };
  return { deps, output, calls };
}

test("setup uses a user-supplied label and changes the default only after providers are ready", async () => {
  const f = await fixture("setup-label");
  const { deps, output, calls } = dependencies(f);
  expect(await runTyrantCli(["setup", f.vaultA, "--name", "Workshop / whatever"], deps)).toBe(0);
  const registry = await loadProfileRegistry({ stateDirectory: f.stateDirectory });
  expect(registry.profiles[0]?.name).toBe("Workshop / whatever");
  expect(registry.defaultProfileId).toBe(registry.profiles[0]?.id);
  expect(calls.map((call) => call.kind)).toEqual(["graphify", "memory", "dsh"]);
  expect(JSON.parse(output.join("")).dsh_plugin).toMatchObject({ status: "installed", profile: "desktop" });
  expect(JSON.parse(output.join("")).active_default.name).toBe("Workshop / whatever");
  expect((await loadInstallState({ stateDirectory: f.stateDirectory })).dsh_profile).toBe("desktop");
});

test("setup persists a selected DSH profile for future update refreshes", async () => {
  const f = await fixture("setup-custom-dsh-profile");
  const { deps } = dependencies(f);
  expect(await runTyrantCli(["setup", f.vaultA, "--dsh-profile", "workstation"], deps)).toBe(0);
  expect((await loadInstallState({ stateDirectory: f.stateDirectory })).dsh_profile).toBe("workstation");
});

test("update delegates release installation and returns a structured version result", async () => {
  const f = await fixture("update-command");
  const { deps, output, calls } = dependencies(f);
  deps.updateTyrant = async () => ({
    status: "updated",
    previous_version: "0.1.0",
    version: "0.1.1",
    dsh_plugin: { status: "installed", profile: "desktop" },
    projects: [{ project_root: f.project, status: "updated" }],
  });

  expect(await runTyrantCli(["update"], deps)).toBe(0);
  expect(JSON.parse(output.join(""))).toMatchObject({ status: "updated", previous_version: "0.1.0", version: "0.1.1" });
  expect(calls).toEqual([]);
});

test("prints the installed release version in a copyable CLI format", async () => {
  const f = await fixture("version-command");
  const { deps, output } = dependencies(f);
  expect(await runTyrantCli(["--version"], deps)).toBe(0);
  expect(output.join("")).toBe("tyrant 0.1.1\n");
});

test("setup without a vault path uses the current directory label and switches future project default", async () => {
  const f = await fixture("setup-cwd");
  const { deps } = dependencies(f);
  expect(await runTyrantCli(["setup", f.vaultA, "--name", "Profile A"], deps)).toBe(0);
  expect(await runTyrantCli(["setup", "--name", "Profile B"], { ...dependencies(f).deps, cwd: f.vaultB })).toBe(0);
  const registry = await loadProfileRegistry({ stateDirectory: f.stateDirectory });
  expect(registry.profiles.map((profile) => profile.name).sort()).toEqual(["Profile A", "Profile B"]);
  expect(registry.profiles.find((profile) => profile.id === registry.defaultProfileId)?.name).toBe("Profile B");
});

test("setup creates a new vault path when it does not already exist", async () => {
  const f = await fixture("setup-new-vault-path");
  const selected = join(f.directory, "vaults", "brand-new", "knowledge");
  const { deps } = dependencies(f);
  expect(await runTyrantCli(["setup", selected, "--name", "Any label"], deps)).toBe(0);
  expect((await lstat(selected)).isDirectory()).toBe(true);
  const registry = await loadProfileRegistry({ stateDirectory: f.stateDirectory });
  expect(registry.profiles[0]?.vaultPath).toBe(selected);
});

test("init fails without a default profile and does not install adapters", async () => {
  const f = await fixture("init-no-default");
  const { deps, output, calls } = dependencies(f);
  expect(await runTyrantCli(["init"], deps)).toBe(2);
  expect(output.join("")).toContain("profile_default_missing");
  expect(calls).toEqual([]);
});

test("init preserves a project's bound profile after the user changes the default", async () => {
  const f = await fixture("init-preserve");
  const a = await activateVaultProfile({ vaultPath: f.vaultA, name: "Profile A", endpoint: "http://127.0.0.1:49375/mcp", configPath: join(f.vaultA, "config.toml") }, { stateDirectory: f.stateDirectory });
  await bindProjectProfile({ projectRoot: f.project, profile: a });
  await activateVaultProfile({ vaultPath: f.vaultB, name: "Profile B", endpoint: "http://127.0.0.1:49376/mcp", configPath: join(f.vaultB, "config.toml") }, { stateDirectory: f.stateDirectory });
  const { deps, output, calls } = dependencies(f);
  expect(await runTyrantCli(["init"], deps)).toBe(0);
  const binding = JSON.parse(await readFile(join(f.project, ".tyrant", "project.json"), "utf8"));
  expect(binding.profileId).toBe(a.id);
  expect(calls.find((call) => call.kind === "memory")?.value).toMatchObject({ id: a.id });
  expect(JSON.parse(output.join("")).binding.profile_id).toBe(a.id);
  const installed = await loadInstallState({ stateDirectory: f.stateDirectory });
  expect(installed.projects).toEqual([{ project_root: f.project, hosts: ["codex", "claude-code", "opencode", "dsh", "claude-desktop"] }]);
});

test("explicit init profile is the only rebind path and delegates adapter installation", async () => {
  const f = await fixture("init-rebind");
  const a = await activateVaultProfile({ vaultPath: f.vaultA, name: "Alpha label", endpoint: "http://127.0.0.1:49375/mcp", configPath: join(f.vaultA, "config.toml") }, { stateDirectory: f.stateDirectory });
  const b = await activateVaultProfile({ vaultPath: f.vaultB, name: "Beta label", endpoint: "http://127.0.0.1:49376/mcp", configPath: join(f.vaultB, "config.toml") }, { stateDirectory: f.stateDirectory });
  await bindProjectProfile({ projectRoot: f.project, profile: a });
  const { deps, calls } = dependencies(f);
  expect(await runTyrantCli(["init", "--vault", "Beta label", "--hosts", "codex,dsh"], deps)).toBe(0);
  const binding = JSON.parse(await readFile(join(f.project, ".tyrant", "project.json"), "utf8"));
  expect(binding.profileId).toBe(b.id);
  expect(calls.map((call) => call.kind)).toEqual(["graphify", "memory", "dsh", "adapters"]);
  expect(calls.find((call) => call.kind === "adapters")?.value).toMatchObject({ hosts: ["codex", "dsh"], projectRoot: f.project });
  expect(calls.find((call) => call.kind === "adapters")?.value).toMatchObject({ profileGuidance: { profileName: "Beta label", workspace: expect.stringMatching(/^tyrant-profile-/), project: expect.stringMatching(/^project-/) } });
});

test("init uses a complete explicit ai-memory scope and blocks a partial scope before side effects", async () => {
  const f = await fixture("init-existing-scope");
  await writeFile(join(f.project, ".ai-memory.toml"), 'workspace = "team-alpha"\nproject = "catalog-api"\n');
  const setup = dependencies(f);
  await runTyrantCli(["setup", f.vaultA, "--name", "General"], setup.deps);
  const { deps, calls, output } = dependencies(f);
  expect(await runTyrantCli(["init"], deps)).toBe(0);
  const binding = JSON.parse(await readFile(join(f.project, ".tyrant", "project.json"), "utf8"));
  expect(binding.scope).toEqual({ workspace: "team-alpha", project: "catalog-api" });
  expect(binding.scopeSource).toBe("ai-memory-config");
  expect(calls.some((call) => call.kind === "adapters")).toBe(true);

  const partial = await fixture("init-partial-scope");
  await writeFile(join(partial.project, ".ai-memory.toml"), 'workspace = "team-alpha"\n');
  await runTyrantCli(["setup", partial.vaultA, "--name", "General"], dependencies(partial).deps);
  const failed = dependencies(partial);
  expect(await runTyrantCli(["init"], failed.deps)).toBe(2);
  expect(failed.output.join("")).toContain("project_scope_incomplete");
  expect(failed.calls.some((call) => call.kind === "adapters")).toBe(false);
  expect(await Bun.file(join(partial.project, "AGENTS.md")).exists()).toBe(false);
});

test("explicit init refuses a malformed binding before it installs project adapters", async () => {
  const f = await fixture("init-malformed-binding");
  await activateVaultProfile({ vaultPath: f.vaultA, name: "Profile A", endpoint: "http://127.0.0.1:49375/mcp", configPath: join(f.vaultA, "config.toml") }, { stateDirectory: f.stateDirectory });
  await mkdir(join(f.project, ".tyrant"), { recursive: true });
  await writeFile(join(f.project, ".tyrant", "project.json"), "{ malformed");
  const { deps, calls, output } = dependencies(f);
  expect(await runTyrantCli(["init", "--vault", "Profile A"], deps)).toBe(2);
  expect(output.join("")).toContain("project_binding_invalid");
  expect(calls.some((call) => call.kind === "adapters")).toBe(false);
  expect(await Bun.file(join(f.project, "AGENTS.md")).exists()).toBe(false);
});

test("status never prints configured token bytes", async () => {
  const f = await fixture("status-redaction");
  const token = "do-not-print-this-token-value";
  await writeFile(join(f.vaultA, "config.toml"), '[auth]\nbearer_token_file = "auth-tokens/default"\n');
  await mkdir(join(f.vaultA, "auth-tokens"), { recursive: true });
  await writeFile(join(f.vaultA, "auth-tokens", "default"), token);
  await activateVaultProfile({ vaultPath: f.vaultA, name: "private label", endpoint: "http://127.0.0.1:49375/mcp", configPath: join(f.vaultA, "config.toml") }, { stateDirectory: f.stateDirectory });
  const { deps, output } = dependencies(f);
  expect(await runTyrantCli(["status"], deps)).toBe(0);
  expect(output.join("")).not.toContain(token);
  expect(output.join("")).toContain("private label");
});

test("a failed provider validation leaves the previous active default unchanged", async () => {
  const f = await fixture("setup-failure-keeps-default");
  const { deps } = dependencies(f);
  expect(await runTyrantCli(["setup", f.vaultA, "--name", "Existing default"], deps)).toBe(0);
  const before = await loadProfileRegistry({ stateDirectory: f.stateDirectory });
  const failing = dependencies(f, { ensureAiMemory: async () => { throw new Error("ai_memory_auth_failed"); } });
  expect(await runTyrantCli(["setup", f.vaultB, "--name", "New choice"], failing.deps)).toBe(2);
  const after = await loadProfileRegistry({ stateDirectory: f.stateDirectory });
  expect(after.defaultProfileId).toBe(before.defaultProfileId);
  expect(after.profiles.map((profile) => profile.name)).toEqual(["Existing default"]);
});
