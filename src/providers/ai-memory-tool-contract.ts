import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_MEMORY_UPSTREAM_PIN } from "../routing/catalog";

export type AiMemoryToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  icons?: Array<Record<string, unknown>>;
};

type AiMemoryToolContract = {
  schema_version: 1;
  upstream: typeof AI_MEMORY_UPSTREAM_PIN;
  tools: AiMemoryToolDefinition[];
};

const contractPath = join(import.meta.dir, "../../vendor/ai-memory/tools.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as AiMemoryToolContract;

if (JSON.stringify(contract.upstream) !== JSON.stringify(AI_MEMORY_UPSTREAM_PIN)) {
  throw new Error("ai_memory_tool_contract_pin_mismatch");
}
if (!Array.isArray(contract.tools) || contract.tools.length === 0) {
  throw new Error("ai_memory_tool_contract_empty");
}
const names = contract.tools.map((tool) => tool.name);
if (new Set(names).size !== names.length || names.some((name) => !/^memory_[a-z0-9_]+$/.test(name))) {
  throw new Error("ai_memory_tool_contract_invalid_names");
}
if (contract.tools.some((tool) => !tool.inputSchema || tool.inputSchema.type !== "object")) {
  throw new Error("ai_memory_tool_contract_invalid_schema");
}

export const AI_MEMORY_UPSTREAM_TOOLS = contract.tools;
