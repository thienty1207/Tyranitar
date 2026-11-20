import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const api = await import("../src/adapters/dsh-mcp-client").catch(() => undefined);
const profiles = await import("../src/setup/profiles");

test("DSH child env binds the project root and only forwards Tyrant provider settings", async () => {
  expect(api?.createDshTyrantChildEnvironment).toBeDefined();
  if (!api) return;

  const root = await mkdtemp(join(tmpdir(), "tyrant-dsh-child-env-"));
  const projectRoot = join(root, "project-login");
  await mkdir(projectRoot);
  try {
    const childEnv = api.createDshTyrantChildEnvironment(projectRoot, {
      TYRANT_PROJECT_ROOT: "D:/Working/Tyrant-Healthcheck",
      TYRANT_AI_MEMORY_AUTH_TOKEN: "test-token",
      AI_MEMORY_DATA_DIR: "D:/AI-MEMORY",
      TYRANT_GRAPHIFY_BIN: "C:/tools/graphify.exe",
      UNRELATED_SECRET: "must-not-be-forwarded",
    }, { PATH: "safe-path" });

    expect(childEnv.PATH).toBe("safe-path");
    expect(childEnv.TYRANT_PROJECT_ROOT).toBe(resolve(projectRoot));
    expect(childEnv.TYRANT_AI_MEMORY_AUTH_TOKEN).toBe("test-token");
    expect(childEnv.AI_MEMORY_DATA_DIR).toBe("D:/AI-MEMORY");
    expect(childEnv.TYRANT_GRAPHIFY_BIN).toBe("C:/tools/graphify.exe");
    expect(childEnv.UNRELATED_SECRET).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bound DSH projects use their saved AI-Memory vault instead of global DSH auth overrides", async () => {
  expect(api?.createDshTyrantChildEnvironment).toBeDefined();
  const root = await mkdtemp(join(tmpdir(), "tyrant-dsh-bound-env-"));
  const projectRoot = join(root, "project");
  const stateDirectory = join(root, "state");
  const vaultPath = join(root, "vault");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(vaultPath, { recursive: true });
  try {
    const profile = await profiles.activateVaultProfile({
      vaultPath,
      name: "Bound vault",
      endpoint: "http://127.0.0.1:52352/mcp",
      configPath: join(vaultPath, "config.toml"),
      tokenFile: join(vaultPath, "auth-tokens", "default"),
    }, { stateDirectory });
    await profiles.bindProjectProfile({ projectRoot, profile }, { stateDirectory });

    const childEnv = api!.createDshTyrantChildEnvironment(projectRoot, {
      TYRANT_STATE_DIR: stateDirectory,
      TYRANT_AI_MEMORY_AUTH_TOKEN: "global-dsh-token",
      AI_MEMORY_AUTH_TOKEN: "legacy-global-token",
      TYRANT_AI_MEMORY_TOKEN_FILE: "D:/AI-MEMORY/auth-tokens/default",
      AI_MEMORY_TOKEN_FILE: "D:/AI-MEMORY/auth-tokens/default",
      TYRANT_AI_MEMORY_URL: "http://127.0.0.1:52352/mcp",
      AI_MEMORY_SERVER_URL: "http://127.0.0.1:52352/mcp",
      TYRANT_AI_MEMORY_WORKSPACE: "global-workspace",
      TYRANT_AI_MEMORY_PROJECT: "global-project",
      AI_MEMORY_DATA_DIR: "D:/AI-MEMORY",
      AI_MEMORY_CONFIG_PATH: "D:/AI-MEMORY/config.toml",
      TYRANT_AI_MEMORY_TIMEOUT_MS: "12000",
      TYRANT_GRAPHIFY_BIN: "C:/tools/graphify.exe",
    }, { PATH: "safe-path" });

    expect(childEnv.TYRANT_PROJECT_ROOT).toBe(resolve(projectRoot));
    expect(childEnv.TYRANT_STATE_DIR).toBe(stateDirectory);
    expect(childEnv.TYRANT_AI_MEMORY_AUTH_TOKEN).toBeUndefined();
    expect(childEnv.AI_MEMORY_AUTH_TOKEN).toBeUndefined();
    expect(childEnv.TYRANT_AI_MEMORY_TOKEN_FILE).toBeUndefined();
    expect(childEnv.AI_MEMORY_TOKEN_FILE).toBeUndefined();
    expect(childEnv.TYRANT_AI_MEMORY_URL).toBeUndefined();
    expect(childEnv.AI_MEMORY_SERVER_URL).toBeUndefined();
    expect(childEnv.TYRANT_AI_MEMORY_WORKSPACE).toBeUndefined();
    expect(childEnv.TYRANT_AI_MEMORY_PROJECT).toBeUndefined();
    expect(childEnv.AI_MEMORY_DATA_DIR).toBeUndefined();
    expect(childEnv.AI_MEMORY_CONFIG_PATH).toBeUndefined();
    expect(childEnv.TYRANT_AI_MEMORY_TIMEOUT_MS).toBe("12000");
    expect(childEnv.TYRANT_GRAPHIFY_BIN).toBe("C:/tools/graphify.exe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH connects to Tyrant through a Bun stdio process and discovers real tools", async () => {
  expect(api?.openDshTyrantMcpClient).toBeDefined();
  if (!api) return;

  const workspace = await mkdtemp(join(tmpdir(), "tyrant-dsh-stdio-"));
  const client = await api.openDshTyrantMcpClient(workspace, { engineRoot: process.cwd() });
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("tyrant_prepare_task");
    expect(tools.map((tool) => tool.name)).toContain("tyrant_list_skills");
    expect(tools).toHaveLength(36);
  } finally {
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
