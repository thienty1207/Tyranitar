import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const profilesApi = await import("../src/setup/profiles").catch(() => undefined);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tyrant-vault-profiles-"));
  const userState = join(root, "user-state");
  const vaultA = join(root, "vault-a");
  const vaultB = join(root, "vault-b");
  await Promise.all([mkdir(vaultA), mkdir(vaultB)]);
  return { root, userState, vaultA, vaultB };
}

test("user state directory and omitted setup path resolve from platform defaults and cwd", () => {
  expect(profilesApi?.getTyrantUserDirectory).toBeDefined();
  expect(profilesApi?.resolveVaultPath).toBeDefined();
  if (!profilesApi) return;

  expect(profilesApi.getTyrantUserDirectory({ LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" }, "win32"))
    .toBe("C:\\Users\\tester\\AppData\\Local\\Tyrant");
  expect(profilesApi.getTyrantUserDirectory({ XDG_STATE_HOME: "/tmp/state" }, "linux"))
    .toBe("/tmp/state/tyrant");
  expect(profilesApi.resolveVaultPath(undefined, "D:\\Work\\vault"))
    .toBe("D:\\Work\\vault");
  expect(profilesApi.resolveVaultPath("..\\shared", "D:\\Work\\project"))
    .toBe("D:\\Work\\shared");
});

test("profile registry starts empty, selects an arbitrary label, and reuses a canonical vault path", async () => {
  expect(profilesApi?.loadProfileRegistry).toBeDefined();
  expect(profilesApi?.activateVaultProfile).toBeDefined();
  if (!profilesApi) return;
  const f = await fixture();
  try {
    const empty = await profilesApi.loadProfileRegistry({ stateDirectory: f.userState });
    expect(empty).toEqual({ schemaVersion: 1, defaultProfileId: null, profiles: [] });

    const first = await profilesApi.activateVaultProfile({
      vaultPath: f.vaultA,
      name: "Research & Tools",
      endpoint: "http://127.0.0.1:49375/mcp",
      configPath: join(f.vaultA, "config.toml"),
      tokenFile: join(f.vaultA, "auth-tokens", "default"),
    }, { stateDirectory: f.userState });
    const reused = await profilesApi.activateVaultProfile({
      vaultPath: join(f.root, "unused", "..", "vault-a"),
      name: "Research & Tools",
      endpoint: "http://127.0.0.1:49376/mcp",
      configPath: join(f.vaultA, "config.toml"),
    }, { stateDirectory: f.userState });
    const registry = await profilesApi.loadProfileRegistry({ stateDirectory: f.userState });

    expect(reused.id).toBe(first.id);
    expect(reused.endpoint).toBe("http://127.0.0.1:49376/mcp");
    expect(registry.defaultProfileId).toBe(first.id);
    expect(registry.profiles).toHaveLength(1);
    expect(registry.profiles[0].name).toBe("Research & Tools");
    expect(registry.profiles[0].tokenFile).toContain("auth-tokens");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("profile names are unique labels and never persist supplied secret-shaped fields", async () => {
  expect(profilesApi?.activateVaultProfile).toBeDefined();
  if (!profilesApi) return;
  const f = await fixture();
  try {
    await profilesApi.activateVaultProfile({
      vaultPath: f.vaultA, name: "Shared Label", endpoint: "http://127.0.0.1:49375/mcp",
      configPath: join(f.vaultA, "config.toml"), authToken: "must-not-persist",
    } as any, { stateDirectory: f.userState });
    await expect(profilesApi.activateVaultProfile({
      vaultPath: f.vaultB, name: "shared label", endpoint: "http://127.0.0.1:49376/mcp",
      configPath: join(f.vaultB, "config.toml"),
    }, { stateDirectory: f.userState })).rejects.toThrow("profile_name_conflict");

    const saved = await readFile(join(f.userState, "profiles.json"), "utf8");
    expect(saved).not.toContain("must-not-persist");
    expect(saved).not.toContain("authToken");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("default switching affects new bindings while an existing project remains pinned until explicit rebind", async () => {
  expect(profilesApi?.activateVaultProfile).toBeDefined();
  expect(profilesApi?.bindProjectProfile).toBeDefined();
  expect(profilesApi?.resolveProjectProfile).toBeDefined();
  if (!profilesApi) return;
  const f = await fixture();
  const project = join(f.root, "project-a");
  await mkdir(project);
  try {
    const profileA = await profilesApi.activateVaultProfile({
      vaultPath: f.vaultA, name: "Profile A", endpoint: "http://127.0.0.1:49375/mcp",
      configPath: join(f.vaultA, "config.toml"),
    }, { stateDirectory: f.userState });
    await profilesApi.bindProjectProfile({ projectRoot: project, profile: profileA });

    const profileB = await profilesApi.activateVaultProfile({
      vaultPath: f.vaultB, name: "Profile B", endpoint: "http://127.0.0.1:49376/mcp",
      configPath: join(f.vaultB, "config.toml"),
    }, { stateDirectory: f.userState });
    const preserved = await profilesApi.bindProjectProfile({ projectRoot: project, profile: profileB });
    expect(preserved.profileId).toBe(profileA.id);
    expect((await profilesApi.resolveProjectProfile(project, { stateDirectory: f.userState }))?.profile.id).toBe(profileA.id);

    const rebound = await profilesApi.bindProjectProfile({ projectRoot: project, profile: profileB, explicitRebind: true });
    expect(rebound.profileId).toBe(profileB.id);
    expect((await profilesApi.resolveProjectProfile(project, { stateDirectory: f.userState }))?.profile.id).toBe(profileB.id);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("projects sharing a folder basename receive distinct stable scopes", async () => {
  expect(profilesApi?.activateVaultProfile).toBeDefined();
  expect(profilesApi?.bindProjectProfile).toBeDefined();
  if (!profilesApi) return;
  const f = await fixture();
  const firstRoot = join(f.root, "one", "service");
  const secondRoot = join(f.root, "two", "service");
  await Promise.all([mkdir(firstRoot, { recursive: true }), mkdir(secondRoot, { recursive: true })]);
  try {
    const profile = await profilesApi.activateVaultProfile({
      vaultPath: f.vaultA, name: "Profile A", endpoint: "http://127.0.0.1:49375/mcp",
      configPath: join(f.vaultA, "config.toml"),
    }, { stateDirectory: f.userState });
    const first = await profilesApi.bindProjectProfile({ projectRoot: firstRoot, profile });
    const second = await profilesApi.bindProjectProfile({ projectRoot: secondRoot, profile });
    const repeated = await profilesApi.bindProjectProfile({ projectRoot: firstRoot, profile });

    expect(first.scope.workspace).toBe(second.scope.workspace);
    expect(first.scope.project).not.toBe(second.scope.project);
    expect(repeated.scope).toEqual(first.scope);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("missing default and dangling project profile fail closed instead of falling back", async () => {
  expect(profilesApi?.getDefaultVaultProfile).toBeDefined();
  expect(profilesApi?.resolveProjectProfile).toBeDefined();
  if (!profilesApi) return;
  const f = await fixture();
  const project = join(f.root, "project");
  await mkdir(project);
  try {
    const empty = await profilesApi.loadProfileRegistry({ stateDirectory: f.userState });
    expect(() => profilesApi.getDefaultVaultProfile(empty)).toThrow("profile_default_missing");

    await profilesApi.bindProjectProfile({
      projectRoot: project,
      profile: { id: "missing-profile", name: "removed", vaultPath: f.vaultA, endpoint: "http://127.0.0.1:49375/mcp", configPath: "x" },
    } as any);
    await expect(profilesApi.resolveProjectProfile(project, { stateDirectory: f.userState }))
      .rejects.toThrow("profile_not_found");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("prepares an arbitrary profile label without changing the active default", async () => {
  expect(profilesApi?.prepareVaultProfileIdentity).toBeDefined();
  if (!profilesApi) return;
  const f = await fixture();
  try {
    const active = await profilesApi.activateVaultProfile({
      vaultPath: f.vaultA, name: "First label", endpoint: "http://127.0.0.1:49375/mcp", configPath: join(f.vaultA, "config.toml"),
    }, { stateDirectory: f.userState });
    const candidate = await profilesApi.prepareVaultProfileIdentity({ vaultPath: f.vaultB, name: "Kitchen sink / whatever" }, { stateDirectory: f.userState });
    const registry = await profilesApi.loadProfileRegistry({ stateDirectory: f.userState });
    expect(candidate.name).toBe("Kitchen sink / whatever");
    expect(candidate.id).not.toBe(active.id);
    expect(registry.defaultProfileId).toBe(active.id);
    expect(registry.profiles).toHaveLength(1);

    const reused = await profilesApi.prepareVaultProfileIdentity({ vaultPath: f.vaultA, name: "Renamed label" }, { stateDirectory: f.userState });
    expect(reused.id).toBe(active.id);
    expect(reused.existingProfile?.name).toBe("First label");
    await expect(profilesApi.prepareVaultProfileIdentity({ vaultPath: f.vaultB, name: "first LABEL" }, { stateDirectory: f.userState }))
      .rejects.toThrow("profile_name_conflict");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("copied project bindings fail closed until an explicit profile rebind", async () => {
  expect(profilesApi?.bindProjectProfile).toBeDefined();
  expect(profilesApi?.resolveProjectProfile).toBeDefined();
  if (!profilesApi) return;
  const f = await fixture();
  const source = join(f.root, "source-project");
  const copied = join(f.root, "copied-project");
  await Promise.all([mkdir(source), mkdir(join(copied, ".tyrant"), { recursive: true })]);
  try {
    const profile = await profilesApi.activateVaultProfile({
      vaultPath: f.vaultA, name: "Profile A", endpoint: "http://127.0.0.1:49375/mcp", configPath: join(f.vaultA, "config.toml"),
    }, { stateDirectory: f.userState });
    const original = await profilesApi.bindProjectProfile({ projectRoot: source, profile });
    await writeFile(join(copied, ".tyrant", "project.json"), JSON.stringify(original));
    await expect(profilesApi.resolveProjectProfile(copied, { stateDirectory: f.userState })).rejects.toThrow("project_binding_root_mismatch");
    await expect(profilesApi.bindProjectProfile({ projectRoot: copied, profile })).rejects.toThrow("project_binding_root_mismatch");
    const rebound = await profilesApi.bindProjectProfile({ projectRoot: copied, profile, explicitRebind: true });
    expect(rebound.projectRoot).toBe(copied);
    expect(rebound.projectId).not.toBe(original.projectId);
    expect((await profilesApi.resolveProjectProfile(copied, { stateDirectory: f.userState }))?.binding.projectId).toBe(rebound.projectId);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("profile selector prefers an exact profile id over a colliding display label", async () => {
  expect(profilesApi?.resolveVaultProfile).toBeDefined();
  if (!profilesApi) return;
  const f = await fixture();
  try {
    const older = await profilesApi.activateVaultProfile({
      id: "profile-a", vaultPath: f.vaultA, name: "profile-b", endpoint: "http://127.0.0.1:49375/mcp", configPath: join(f.vaultA, "config.toml"),
    }, { stateDirectory: f.userState });
    const newer = await profilesApi.activateVaultProfile({
      id: "profile-b", vaultPath: f.vaultB, name: "Second vault", endpoint: "http://127.0.0.1:49376/mcp", configPath: join(f.vaultB, "config.toml"),
    }, { stateDirectory: f.userState });
    const resolved = profilesApi.resolveVaultProfile(await profilesApi.loadProfileRegistry({ stateDirectory: f.userState }), newer.id);
    expect(older.id).not.toBe(newer.id);
    expect(resolved.id).toBe(newer.id);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("concurrent vault setup keeps every successfully activated profile", async () => {
  expect(profilesApi?.activateVaultProfile).toBeDefined();
  if (!profilesApi) return;
  const f = await fixture();
  try {
    await Promise.all([
      profilesApi.activateVaultProfile({ vaultPath: f.vaultA, name: "Profile A", endpoint: "http://127.0.0.1:49375/mcp", configPath: join(f.vaultA, "config.toml") }, { stateDirectory: f.userState }),
      profilesApi.activateVaultProfile({ vaultPath: f.vaultB, name: "Profile B", endpoint: "http://127.0.0.1:49376/mcp", configPath: join(f.vaultB, "config.toml") }, { stateDirectory: f.userState }),
    ]);
    const registry = await profilesApi.loadProfileRegistry({ stateDirectory: f.userState });
    expect(registry.profiles.map((profile) => profile.name).sort()).toEqual(["Profile A", "Profile B"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("binding loaders reject scope fields copied from a different project", async () => {
  expect(profilesApi?.resolveProjectProfile).toBeDefined();
  expect(profilesApi?.resolveProjectProfileSync).toBeDefined();
  if (!profilesApi) return;
  const f = await fixture();
  const project = join(f.root, "project");
  await mkdir(project);
  try {
    const profile = await profilesApi.activateVaultProfile({
      vaultPath: f.vaultA, name: "Profile A", endpoint: "http://127.0.0.1:49375/mcp", configPath: join(f.vaultA, "config.toml"),
    }, { stateDirectory: f.userState });
    const binding = await profilesApi.bindProjectProfile({ projectRoot: project, profile });
    const bindingPath = join(project, ".tyrant", "project.json");
    await writeFile(bindingPath, JSON.stringify({ ...binding, scope: { workspace: "tyrant-profile-other", project: "project-from-another-checkout" } }));
    await expect(profilesApi.resolveProjectProfile(project, { stateDirectory: f.userState })).rejects.toThrow("project_binding_scope_mismatch");
    expect(() => profilesApi.resolveProjectProfileSync(project, { stateDirectory: f.userState })).toThrow("project_binding_scope_mismatch");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
