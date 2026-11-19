import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createTyrantServer } from "../src/mcp/server";
import { AI_MEMORY_UPSTREAM_TOOLS } from "../src/providers/ai-memory-tool-contract";

const contractPath = join(import.meta.dir, "..", "vendor", "ai-memory", "tools.json");

test("pinned AI-Memory tool contract covers every tool in v3.4.7", () => {
  const exists = existsSync(contractPath);
  expect(exists).toBe(true);
  if (!exists) return;

  const contract = JSON.parse(readFileSync(contractPath, "utf8")) as {
    schema_version: number;
    upstream: { name: string; version: string; commit: string };
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  };
  expect(contract.schema_version).toBe(1);
  expect(contract.upstream).toEqual({ name: "ai-memory", version: "3.4.7", commit: "fa0ec25dbe987b7574a7487ecf92f0873040c2f2" });
  expect(contract.tools).toHaveLength(27);
  expect(new Set(contract.tools.map((tool) => tool.name)).size).toBe(27);
  expect(contract.tools.every((tool) => /^memory_[a-z0-9_]+$/.test(tool.name))).toBe(true);
  expect(contract.tools.every((tool) => tool.description.trim().length > 0)).toBe(true);
  expect(contract.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
});

test("Tyrant exposes every AI-Memory tool with its upstream schema and forwards calls", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const server = createTyrantServer({
    aiMemory: {
      async loadContext() { return { status: "ready", context: "", references: [], handoffStatus: "not_checked" }; },
      async syncOutcome() { return { status: "synced", handoffStatus: "not_required" }; },
      async invokeTool(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return { content: [{ type: "text" as const, text: "upstream-result" }] };
      },
    } as any,
    graphify: { async loadContext() { return { status: "ready", mapStatus: "current", context: "", references: [] }; } },
    projectRoot: import.meta.dir,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tyrant-ai-memory-tools-test", version: "0.1.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const exposed = listed.tools.filter((tool) => tool.name.startsWith("tyrant_memory_"));
    expect(exposed).toHaveLength(27);
    expect(listed.tools).toHaveLength(36);
    for (const upstream of AI_MEMORY_UPSTREAM_TOOLS) {
      const wrapper = exposed.find((tool) => tool.name === `tyrant_${upstream.name}`);
      expect(wrapper).toBeDefined();
      expect(wrapper?.inputSchema).toEqual(upstream.inputSchema as any);
      expect(wrapper?.description).toContain(upstream.description);
      expect(wrapper?.annotations).toEqual(upstream.annotations);
    }

    const result = await client.callTool({
      name: "tyrant_memory_briefing",
      arguments: { settled_first: true },
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{ name: "memory_briefing", args: { settled_first: true } }]);

    await client.callTool({
      name: "tyrant_memory_write_pages_batch",
      arguments: {
        workspace: "tyrant-test",
        project: "sample",
        pages: [{ path: "decisions/proxy.md", body: "# Proxy", create_only: true, source_files: [{ path: "src/index.ts", commit: "1234567" }] }],
      },
    });
    expect(calls.at(-1)).toEqual({
      name: "memory_write_pages_batch",
      args: { workspace: "tyrant-test", project: "sample", pages: [{ path: "decisions/proxy.md", body: "# Proxy", create_only: true, source_files: [{ path: "src/index.ts", commit: "1234567" }] }] },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("proxied AI-Memory operations add outcome-only events to the active task", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "tyrant-ai-memory-proxy-audit-"));
  const server = createTyrantServer({
    aiMemory: {
      async loadContext() { return { status: "ready", context: "", references: [], handoffStatus: "not_checked" }; },
      async syncOutcome() { return { status: "synced", handoffStatus: "not_required" }; },
      async invokeTool() { return { content: [{ type: "text" as const, text: "private-memory-body" }] }; },
    } as any,
    graphify: { async loadContext() { return { status: "ready", mapStatus: "current", context: "", references: [] }; } },
    projectRoot: sandbox,
    stateDirectory: join(sandbox, "state"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tyrant-ai-memory-proxy-audit-test", version: "0.1.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const prepared = await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Inspect AI-Memory tool routing", request_id: "prepare-proxy-audit-1" },
    });
    const prepareText = prepared.content.find((item) => item.type === "text");
    if (!prepareText || prepareText.type !== "text") throw new Error("prepare response omitted text");
    const taskId = JSON.parse(prepareText.text).task.id as string;

    await client.callTool({ name: "tyrant_memory_briefing", arguments: { settled_first: true } });
    const task = await client.callTool({ name: "tyrant_get_task", arguments: { schema_version: 1, task_id: taskId } });
    const taskText = task.content.find((item) => item.type === "text");
    if (!taskText || taskText.type !== "text") throw new Error("task response omitted text");
    const events = JSON.parse(taskText.text).events as Array<Record<string, unknown>>;
    const proxyEvent = events.find((event) => event.event_type === "ai_memory_tool_called");
    expect(proxyEvent).toMatchObject({ outcome: "success", summary: "AI-Memory memory_briefing completed; arguments and result omitted from Tyrant state." });
    expect(JSON.stringify(proxyEvent)).not.toContain("private-memory-body");
    expect(JSON.stringify(proxyEvent)).not.toContain("settled_first");
  } finally {
    await client.close();
    await server.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
