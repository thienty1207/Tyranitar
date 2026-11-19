import type { InProcessTyrantTool } from "./local-tools";

type JsonRecord = Record<string, unknown>;
type DshToolExecution = { signal: AbortSignal };
type DshToolDefinitionOptions = {
  name: string;
  rawName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: unknown;
  taskRequired?: boolean;
  call(args: Record<string, unknown>, execution: DshToolExecution): Promise<unknown>;
};

export type DshAgentToolClient = {
  listTools(): Promise<{ tools: InProcessTyrantTool[] }>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
};

export type DshAgentToolSetup = {
  openClient(projectRoot: string): Promise<DshAgentToolClient>;
  createToolDefinition(scope: unknown, options: DshToolDefinitionOptions): unknown;
};

type DshAgentLike = {
  id?: string;
  session?: { id?: string; header?: { cwd?: string } };
  ctx?: { tools?: { register(definition: unknown): unknown } };
};

function disposerOf(value: unknown): (() => void) | undefined {
  if (typeof value === "function") return value as () => void;
  if (typeof value === "object" && value !== null && "dispose" in value && typeof value.dispose === "function") {
    const dispose = (value as { dispose(): unknown }).dispose;
    return () => { dispose.call(value); };
  }
  return undefined;
}

export function createDshTyrantToolDefinition(options: DshToolDefinitionOptions): JsonRecord {
  return {
    name: options.name,
    description: options.description,
    parameters: options.inputSchema,
    output: {
      schema: {
        type: "object",
        properties: {
          content: { type: "array", items: { type: "object", additionalProperties: true } },
          structuredContent: { type: "object", additionalProperties: true },
        },
        required: ["content"],
        additionalProperties: false,
      },
      render(_args: unknown, value: unknown) {
        const response = value && typeof value === "object" ? value as JsonRecord : {};
        const text = Array.isArray(response.content)
          ? response.content.filter((item: unknown): item is { type: "text"; text: string } => !!item && typeof item === "object" && (item as JsonRecord).type === "text" && typeof (item as JsonRecord).text === "string")
            .map((item) => ({ type: "text", text: item.text }))
          : [];
        return text.length ? text : [{ type: "text", text: JSON.stringify(response.structuredContent ?? {}) }];
      },
    },
    async execute(args: unknown, execution: DshToolExecution) {
      const input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
      const result = await options.call(input, execution);
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("tyrant_mcp_tool_invalid_result");
      const response = result as JsonRecord;
      if (response.isError === true) throw new Error("tyrant_mcp_tool_failed");
      const content = Array.isArray(response.content) ? response.content : [];
      const structuredContent = response.structuredContent;
      return {
        content,
        ...(structuredContent && typeof structuredContent === "object" && !Array.isArray(structuredContent) ? { structuredContent } : {}),
      };
    },
  };
}

export function dshAgentIdentity(agent: DshAgentLike): { sessionId: string; projectRoot: string } {
  const sessionId = typeof agent.session?.id === "string" ? agent.session.id.trim() : typeof agent.id === "string" ? agent.id.trim() : "";
  const projectRoot = typeof agent.session?.header?.cwd === "string" ? agent.session.header.cwd.trim() : "";
  if (!sessionId || !projectRoot) throw new Error("dsh_agent_identity_missing");
  return { sessionId, projectRoot };
}

export async function registerTyrantToolsForDshAgent(agent: DshAgentLike, setup: DshAgentToolSetup): Promise<{
  toolNames: string[];
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  dispose(): Promise<void>;
}> {
  const identity = dshAgentIdentity(agent);
  const registry = agent.ctx?.tools;
  if (!registry || typeof registry.register !== "function") throw new Error("dsh_agent_tool_scope_missing");

  let client: DshAgentToolClient;
  try {
    client = await setup.openClient(identity.projectRoot);
  } catch {
    throw new Error("dsh_agent_mcp_client_failed");
  }

  const disposers: Array<() => void> = [];
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    for (const unregister of disposers.reverse()) {
      try { unregister(); } catch { /* Agent scope disposal still owns its registrations. */ }
    }
    await client.close().catch(() => undefined);
  };

  try {
    const response = await client.listTools();
    if (!Array.isArray(response.tools)) throw new Error("invalid_tool_list");
    const tools = response.tools;
    const names = new Set<string>();
    for (const tool of tools) {
      if (!tool || typeof tool.name !== "string" || !/^tyrant_[a-z0-9_]+$/.test(tool.name)
        || !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)
        || names.has(tool.name)) throw new Error("invalid_tool_definition");
      names.add(tool.name);
    }
    if (!names.has("tyrant_prepare_task") || !names.has("tyrant_list_skills")) throw new Error("required_tools_missing");

    for (const tool of tools) {
      const definition = setup.createToolDefinition(agent.ctx, {
        name: tool.name,
        rawName: tool.name,
        description: typeof tool.description === "string" ? tool.description : "Tyrant project orchestrator tool.",
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        taskRequired: tool.execution?.taskSupport === "required",
        call: (args, execution) => client.callTool(tool.name, args, execution.signal),
      });
      const unregister = disposerOf(registry.register(definition));
      if (!unregister) throw new Error("registration_disposer_missing");
      disposers.push(unregister);
    }
    return {
      toolNames: tools.map((tool) => tool.name),
      callTool: (name, args, signal) => client.callTool(name, args, signal),
      dispose,
    };
  } catch {
    await dispose();
    throw new Error("dsh_agent_tool_registration_failed");
  }
}
