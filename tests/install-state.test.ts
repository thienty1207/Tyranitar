import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateApi = await import("../src/setup/install-state").catch(() => undefined);
const root = await mkdtemp(join(tmpdir(), "tyrant-install-state-"));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("stores the DSH profile and registers canonical projects for safe update refresh", async () => {
  expect(stateApi?.loadInstallState).toBeDefined();
  expect(stateApi?.registerInstalledProject).toBeDefined();
  expect(stateApi?.saveDshProfile).toBeDefined();
  if (!stateApi) return;
  const stateDirectory = join(root, "state");
  const project = join(root, "project");
  await mkdir(project, { recursive: true });

  expect(await stateApi.loadInstallState({ stateDirectory })).toEqual({ schema_version: 1, dsh_profile: "desktop", projects: [] });
  await stateApi.saveDshProfile("workstation", { stateDirectory });
  await stateApi.registerInstalledProject(project, ["codex", "dsh"], { stateDirectory });
  await stateApi.registerInstalledProject(project, ["codex", "claude-code"], { stateDirectory });

  const state = await stateApi.loadInstallState({ stateDirectory });
  expect(state.dsh_profile).toBe("workstation");
  expect(state.projects).toHaveLength(1);
  expect(state.projects[0]?.project_root).toBe(project);
  expect(state.projects[0]?.hosts).toEqual(["codex", "claude-code"]);
});

test("rejects non-file install state and unsupported host IDs", async () => {
  if (!stateApi) throw new Error("install_state_module_missing");
  const stateDirectory = join(root, "unsafe-state");
  const project = join(root, "unsafe-project");
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(join(stateDirectory, "installation.json"));
  await expect(stateApi.loadInstallState({ stateDirectory })).rejects.toThrow("install_state_file_not_regular");
  await rm(join(stateDirectory, "installation.json"), { recursive: true });
  await expect(stateApi.registerInstalledProject(project, ["codex", "unknown"] as never, { stateDirectory })).rejects.toThrow("install_state_host_invalid");
});
