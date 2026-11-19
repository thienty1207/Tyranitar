import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const api = await import("../src/adapters/dsh-agent-tools").catch(() => undefined);
const { AI_MEMORY_UPSTREAM_TOOLS } = await import("../src/providers/ai-memory-tool-contract");

function registry() {
  const definitions = new Map<string, any>();
  const disposed: string[] = [];
  return {
    definitions,
    disposed,
    tools: {
      register(definition: any) {
        definitions.set(definition.name, definition);
        return () => { disposed.push(definition.name); definitions.delete(definition.name); };
      },
    },
  };
}

test("DSH gets every real Tyrant MCP tool in the agent scope and calls the project-bound MCP server", async () => {
  expect(api?.registerTyrantToolsForDshAgent).toBeDefined();
  if (!api) return;

  const scope = registry();
  const calls: Array<{ name: string; args: Record<string, unknown>; signal?: AbortSignal }> = [];
  const closed: string[] = [];
  const result = await api.registerTyrantToolsForDshAgent({
    id: "agent-a", session: { id: "session-a", header: { cwd: "D:/project-a" } }, ctx: { tools: scope.tools },
  }, {
    openClient: async (root: string) => {
      expect(root).toBe("D:/project-a");
      return {
        listTools: async () => ({ tools: [
          { name: "tyrant_prepare_task", description: "Prepare", inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] } },
          { name: "tyrant_list_skills", description: "List skills", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
        ] }),
        callTool: async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
          calls.push({ name, args, signal });
          return { content: [{ type: "text", text: "ok" }] };
        },
        close: async () => { closed.push(root); },
      };
    },
    createToolDefinition: (_ctx, options) => ({
      name: options.name,
      description: options.description,
      parameters: options.inputSchema,
      call: options.call,
    }),
  });

  expect(result.toolNames).toEqual(["tyrant_prepare_task", "tyrant_list_skills"]);
  expect(result.callTool).toBeFunction();
  expect([...scope.definitions.keys()]).toEqual(result.toolNames);
  const signal = new AbortController().signal;
  await scope.definitions.get("tyrant_list_skills").call({ schema_version: 1 }, { signal });
  await result.callTool("tyrant_prepare_task", { task: "shared per-agent client" }, signal);
  expect(calls).toEqual([
    { name: "tyrant_list_skills", args: { schema_version: 1 }, signal },
    { name: "tyrant_prepare_task", args: { task: "shared per-agent client" }, signal },
  ]);
  await result.dispose();
  expect(scope.definitions.size).toBe(0);
  expect(scope.disposed).toEqual(["tyrant_list_skills", "tyrant_prepare_task"]);
  expect(closed).toEqual(["D:/project-a"]);
});

test("DSH tool registration is isolated between agent projects", async () => {
  expect(api?.registerTyrantToolsForDshAgent).toBeDefined();
  if (!api) return;
  const a = registry();
  const b = registry();
  const makeAgent = (id: string, cwd: string, tools: any) => ({ id, session: { id, header: { cwd } }, ctx: { tools } });
  const setup = (root: string) => ({
    openClient: async () => ({
      listTools: async () => ({ tools: [
        { name: "tyrant_prepare_task", inputSchema: { type: "object", properties: {} } },
        { name: "tyrant_list_skills", inputSchema: { type: "object", properties: {} } },
      ] }),
      callTool: async () => ({ content: [{ type: "text", text: root }] }), close: async () => {},
    }),
    createToolDefinition: (_ctx: unknown, options: any) => ({ name: options.name, call: options.call }),
  });
  const toolsA = await api.registerTyrantToolsForDshAgent(makeAgent("a", "D:/a", a.tools), setup("D:/a"));
  const toolsB = await api.registerTyrantToolsForDshAgent(makeAgent("b", "D:/b", b.tools), setup("D:/b"));

  expect([...a.definitions.keys()]).toEqual(["tyrant_prepare_task", "tyrant_list_skills"]);
  expect([...b.definitions.keys()]).toEqual(["tyrant_prepare_task", "tyrant_list_skills"]);
  expect(await a.definitions.get("tyrant_list_skills").call({}, { signal: new AbortController().signal })).toMatchObject({ content: [{ text: "D:/a" }] });
  expect(await b.definitions.get("tyrant_list_skills").call({}, { signal: new AbortController().signal })).toMatchObject({ content: [{ text: "D:/b" }] });
  await toolsA.dispose();
  expect(a.definitions.size).toBe(0);
  expect(b.definitions.size).toBe(2);
  await toolsB.dispose();
});

test("DSH rejects missing agent tool scope and rolls back partial registration", async () => {
  expect(api?.registerTyrantToolsForDshAgent).toBeDefined();
  if (!api) return;
  const setup = {
    openClient: async () => ({
      listTools: async () => ({ tools: [
        { name: "tyrant_prepare_task", inputSchema: { type: "object", properties: {} } },
        { name: "tyrant_list_skills", inputSchema: { type: "object", properties: {} } },
      ] }),
      callTool: async () => ({}), close: async () => {},
    }),
    createToolDefinition: (_ctx: unknown, options: any) => ({ name: options.name }),
  };
  await expect(api.registerTyrantToolsForDshAgent({ id: "no-scope", session: { id: "no-scope", header: { cwd: "D:/no-scope" } } }, setup)).rejects.toThrow("dsh_agent_tool_scope_missing");

  const scope = registry();
  let registered = 0;
  const broken = {
    ...setup,
    createToolDefinition: (_ctx: unknown, options: any) => ({ name: options.name }),
  };
  scope.tools.register = (definition: any) => {
    registered += 1;
    if (registered === 2) throw new Error("registry failure");
    return () => { scope.disposed.push(definition.name); scope.definitions.delete(definition.name); };
  };
  await expect(api.registerTyrantToolsForDshAgent({ id: "partial", session: { id: "partial", header: { cwd: "D:/partial" } }, ctx: { tools: scope.tools } }, broken)).rejects.toThrow("dsh_agent_tool_registration_failed");
  expect(scope.disposed).toEqual(["tyrant_prepare_task"]);
  expect(scope.definitions.size).toBe(0);
});

test("DSH tool definitions preserve real MCP schemas and return bounded canonical results", async () => {
  expect(api?.createDshTyrantToolDefinition).toBeDefined();
  if (!api) return;
  const signal = new AbortController().signal;
  const definition = api.createDshTyrantToolDefinition({
    name: "tyrant_list_skills", rawName: "tyrant_list_skills", description: "List skills",
    inputSchema: { type: "object", properties: { schema_version: { type: "integer" } }, required: ["schema_version"] },
    async call(args: Record<string, unknown>, execution: { signal?: AbortSignal }) {
      expect(args).toEqual({ schema_version: 1 });
      expect(execution.signal).toBe(signal);
      return { content: [{ type: "text", text: "safe result" }], structuredContent: { skills: [{ id: "ask-matt" }] } };
    },
  }) as any;
  expect(definition.parameters).toEqual({ type: "object", properties: { schema_version: { type: "integer" } }, required: ["schema_version"] });
  const result = await definition.execute({ schema_version: 1 }, { signal });
  expect(result).toEqual({ content: [{ type: "text", text: "safe result" }], structuredContent: { skills: [{ id: "ask-matt" }] } });
  expect(definition.output.render({}, result)).toEqual([{ type: "text", text: "safe result" }]);
});

test("DSH-visible tyrant_list_skills executes against Tyrant's real local MCP server", async () => {
  expect(api?.registerTyrantToolsForDshAgent).toBeDefined();
  if (!api) return;
  const stdio = await import("../src/adapters/dsh-mcp-client");
  const workspace = await mkdtemp(join(tmpdir(), "tyrant-dsh-mcp-"));
  await mkdir(workspace, { recursive: true });
  const scope = registry();
  const handle = await api.registerTyrantToolsForDshAgent({
    id: "live-mcp-agent", session: { id: "live-mcp-session", header: { cwd: workspace } }, ctx: { tools: scope.tools },
  }, {
    openClient: (root: string) => stdio.openDshTyrantMcpClient(root, { engineRoot: process.cwd() }),
    createToolDefinition: (_ctx, options) => api.createDshTyrantToolDefinition(options),
  });
  try {
    expect(handle.toolNames).toContain("tyrant_prepare_task");
    expect(handle.toolNames).toHaveLength(36);
    for (const upstream of AI_MEMORY_UPSTREAM_TOOLS) {
      expect(handle.toolNames).toContain(`tyrant_${upstream.name}`);
      expect(scope.definitions.get(`tyrant_${upstream.name}`)?.parameters).toEqual(upstream.inputSchema);
    }
    const visibleTool = scope.definitions.get("tyrant_list_skills") as any;
    expect(visibleTool).toBeDefined();
    const result = await visibleTool.execute({ schema_version: 1 }, { signal: new AbortController().signal });
    expect(result.structuredContent.skills.map((skill: { id: string }) => skill.id)).toContain("matt-pocock-main-flow");
    expect(result.structuredContent.skills.map((skill: { id: string }) => skill.id)).toContain("design-taste-frontend");
    expect(result.structuredContent.skills.map((skill: { id: string }) => skill.id)).toContain("security-audit");
  } finally {
    await handle.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});
