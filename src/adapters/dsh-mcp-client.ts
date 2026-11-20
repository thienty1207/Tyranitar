import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InProcessTyrantTool } from "./local-tools";
import { resolveProjectProfileSync } from "../setup/profiles";

const TYRANT_ENVIRONMENT_KEYS = [
  "AI_MEMORY_DATA_DIR",
  "AI_MEMORY_CONFIG_PATH",
  "AI_MEMORY_SERVER_URL",
  "AI_MEMORY_AUTH_TOKEN",
  "AI_MEMORY_TOKEN_FILE",
  "TYRANT_AI_MEMORY_URL",
  "TYRANT_AI_MEMORY_AUTH_TOKEN",
  "TYRANT_AI_MEMORY_TOKEN_FILE",
  "TYRANT_AI_MEMORY_WORKSPACE",
  "TYRANT_AI_MEMORY_PROJECT",
  "TYRANT_AI_MEMORY_TIMEOUT_MS",
  "TYRANT_GRAPHIFY_BIN",
  "TYRANT_GRAPHIFY_TIMEOUT_MS",
  "TYRANT_STATE_DIR",
  "DSH_HOME",
  "CODEX_HOME",
  "OPENCODE_CONFIG_DIR",
  "BUN_INSTALL",
] as const;

const PROJECT_BOUND_AI_MEMORY_OVERRIDES = [
  "AI_MEMORY_DATA_DIR",
  "AI_MEMORY_CONFIG_PATH",
  "AI_MEMORY_SERVER_URL",
  "AI_MEMORY_AUTH_TOKEN",
  "AI_MEMORY_TOKEN_FILE",
  "TYRANT_AI_MEMORY_URL",
  "TYRANT_AI_MEMORY_AUTH_TOKEN",
  "TYRANT_AI_MEMORY_TOKEN_FILE",
  "TYRANT_AI_MEMORY_WORKSPACE",
  "TYRANT_AI_MEMORY_PROJECT",
] as const;

export type DshTyrantMcpClient = {
  listTools(): Promise<{ tools: InProcessTyrantTool[] }>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
};

export function createDshTyrantChildEnvironment(
  projectRoot: string,
  sourceEnvironment: Record<string, string | undefined> = process.env,
  safeHostEnvironment: Record<string, string> = getDefaultEnvironment(),
): Record<string, string> {
  const childEnvironment = { ...safeHostEnvironment };
  for (const key of TYRANT_ENVIRONMENT_KEYS) {
    const value = sourceEnvironment[key];
    if (typeof value === "string") childEnvironment[key] = value;
  }
  childEnvironment.TYRANT_PROJECT_ROOT = resolve(projectRoot);

  // DSH may load ~/.dsh/.env into its process environment. A bound project
  // must get its endpoint, credential and scope only from its saved vault
  // profile; forwarding global AI-Memory overrides makes the provider fail
  // closed with profile_auth_override_blocked (or risk cross-vault routing).
  const binding = resolveProjectProfileSync(projectRoot, {
    stateDirectory: sourceEnvironment.TYRANT_STATE_DIR,
    env: sourceEnvironment,
  });
  if (binding) {
    for (const key of PROJECT_BOUND_AI_MEMORY_OVERRIDES) delete childEnvironment[key];
  }
  return childEnvironment;
}

function defaultEngineRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

export async function openDshTyrantMcpClient(
  projectRoot: string,
  options: { engineRoot?: string; bunCommand?: string; env?: Record<string, string | undefined> } = {},
): Promise<DshTyrantMcpClient> {
  const engineRoot = resolve(options.engineRoot ?? defaultEngineRoot());
  const environment = options.env ?? process.env;
  const command = options.bunCommand?.trim() || environment.TYRANT_BUN_PATH?.trim() || "bun";
  const transport = new StdioClientTransport({
    command,
    args: ["run", "src/index.ts"],
    cwd: engineRoot,
    env: createDshTyrantChildEnvironment(projectRoot, environment),
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "tyrant-dsh-adapter", version: "0.1.0" });

  try {
    await client.connect(transport);
    return {
      listTools: async () => await client.listTools() as { tools: InProcessTyrantTool[] },
      callTool: (name, args, signal) => client.callTool({ name, arguments: args }, signal ? { signal } : undefined),
      close: async () => {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    throw error;
  }
}
