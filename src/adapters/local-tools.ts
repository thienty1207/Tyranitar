import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { resolve } from "node:path";
import { createTyrantServer } from "../mcp/server";
import { TYRANT_VERSION } from "../version";
import type { TyrantToolCaller } from "./auto-preflight";

export type InProcessTyrantTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: unknown;
  execution?: { taskSupport?: string };
};

export type InProcessTyrantMcpClient = {
  listTools(): Promise<{ tools: InProcessTyrantTool[] }>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
};

export async function openInProcessTyrantMcpClient(
  projectRoot: string,
  options: { stateDirectory?: string } = {},
): Promise<InProcessTyrantMcpClient> {
  const server = createTyrantServer({
    projectRoot: resolve(projectRoot),
    ...(options.stateDirectory ? { stateDirectory: resolve(options.stateDirectory) } : {}),
  });
  const client = new Client({ name: "tyrant-host-adapter", version: TYRANT_VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      listTools: () => client.listTools(),
      callTool: (name, args, signal) => client.callTool({ name, arguments: args }, signal ? { signal } : undefined),
      close: async () => {
        await client.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    throw error;
  }
}

export async function withInProcessTyrantTools<T>(
  projectRoot: string,
  callback: (callTool: TyrantToolCaller) => Promise<T>,
  options: { stateDirectory?: string } = {},
): Promise<T> {
  const client = await openInProcessTyrantMcpClient(projectRoot, options);
  try {
    return await callback(async (name, args) => client.callTool(name, args));
  } finally {
    await client.close();
  }
}
