import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const api = await import("../src/adapters/dsh-mcp-client").catch(() => undefined);

test("DSH child env binds the project root and only forwards Tyrant provider settings", () => {
  expect(api?.createDshTyrantChildEnvironment).toBeDefined();
  if (!api) return;

  const childEnv = api.createDshTyrantChildEnvironment("D:/project-login", {
    TYRANT_PROJECT_ROOT: "D:/Working/Tyrant-Healthcheck",
    TYRANT_AI_MEMORY_AUTH_TOKEN: "test-token",
    AI_MEMORY_DATA_DIR: "D:/AI-MEMORY",
    TYRANT_GRAPHIFY_BIN: "C:/tools/graphify.exe",
    UNRELATED_SECRET: "must-not-be-forwarded",
  }, { PATH: "safe-path" });

  expect(childEnv.PATH).toBe("safe-path");
  expect(childEnv.TYRANT_PROJECT_ROOT).toBe(resolve("D:/project-login"));
  expect(childEnv.TYRANT_AI_MEMORY_AUTH_TOKEN).toBe("test-token");
  expect(childEnv.AI_MEMORY_DATA_DIR).toBe("D:/AI-MEMORY");
  expect(childEnv.TYRANT_GRAPHIFY_BIN).toBe("C:/tools/graphify.exe");
  expect(childEnv.UNRELATED_SECRET).toBeUndefined();
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
