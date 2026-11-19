import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAiMemoryConfig } from "../src/providers/ai-memory";
import { AI_MEMORY_UPSTREAM_PIN } from "../src/routing/catalog";

const config = getAiMemoryConfig(process.cwd());
if (!config.authToken) throw new Error("ai_memory_auth_token_missing");
const client = new Client({ name: "tyrant-contract-sync", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(config.url), {
  requestInit: { headers: { Authorization: `Bearer ${config.authToken}` }, redirect: "error" },
});

try {
  await client.connect(transport, { timeout: config.timeoutMs });
  const server = client.getServerVersion();
  if (server?.name !== AI_MEMORY_UPSTREAM_PIN.name || server.version !== AI_MEMORY_UPSTREAM_PIN.version) {
    throw new Error("ai_memory_server_version_does_not_match_reviewed_pin");
  }
  const discovered = await client.listTools();
  const tools = discovered.tools
    .filter((tool) => tool.name.startsWith("memory_"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (tools.length === 0 || tools.length !== discovered.tools.length) {
    throw new Error("ai_memory_tool_list_contains_unexpected_names");
  }
  if (tools.some((tool) => !tool.description?.trim() || tool.inputSchema.type !== "object")) {
    throw new Error("ai_memory_tool_schema_invalid");
  }

  const outputPath = join(import.meta.dir, "../vendor/ai-memory/tools.json");
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify({ schema_version: 1, upstream: AI_MEMORY_UPSTREAM_PIN, tools }, null, 2)}\n`, "utf8");
  await rename(temporaryPath, outputPath);
  console.log(`Updated ${tools.length} AI-Memory tool schemas from ${server.name} ${server.version}.`);
} finally {
  await client.close().catch(() => undefined);
}
