import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const stateDirectory = await mkdtemp(join(tmpdir(), "tyrant-mcp-state-"));

function startServer() {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      TYRANT_PROJECT_ROOT: projectRoot,
      TYRANT_STATE_DIR: stateDirectory,
      TYRANT_GRAPHIFY_BIN: join(stateDirectory, "graphify-not-installed.exe"),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function readMessage(timeoutMs = 3_000): Promise<Record<string, any> | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          return JSON.parse(line) as Record<string, any>;
        } catch {
          return { malformed_stdout: line };
        }
      }

      const remaining = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = await Promise.race([
        reader.read(),
        new Promise<null>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(null), remaining); }),
      ]);
      if (timer) clearTimeout(timer);
      if (read === null || read.done) return null;
      buffer += decoder.decode(read.value, { stream: true });
    }
    return null;
  }

  async function send(message: Record<string, unknown>): Promise<void> {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    await child.stdin.flush();
  }

  return {
    child,
    async request(message: Record<string, unknown>) {
      await send(message);
      return readMessage();
    },
    async initialize() {
      const response = await this.request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "tyrant-contract-test", version: "0.1.0" },
        },
      });
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return response;
    },
    async stop() {
      try {
        child.kill();
      } catch {
        // The child may already have exited on a protocol error.
      }
      await Promise.race([child.exited, new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000))]);
    },
  };
}

afterAll(async () => {
  await rm(stateDirectory, { recursive: true, force: true });
});

test("stdio tool discovery, calls, stdout purity, and checkpoint recovery survive process restart", async () => {
  const first = startServer();
  let taskId = "";
  try {
    const initialized = await first.initialize();
    expect(initialized).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "tyrant" } } });

    const tools = await first.request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(tools?.result?.tools?.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "tyrant_checkpoint",
      "tyrant_finish_task",
      "tyrant_get_task",
      "tyrant_list_skills",
      "tyrant_prepare_task",
      "tyrant_record_event",
      "tyrant_record_evidence",
      "tyrant_sync_memory",
      "tyrant_transition_task",
    ]);

    const prepared = await first.request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "tyrant_prepare_task",
        arguments: { schema_version: 1, task: "Exercise stdio persistence", request_id: "stdio-prepare-001" },
      },
    });
    expect(prepared).toMatchObject({ jsonrpc: "2.0", id: 3, result: {} });
    expect(prepared?.result?.isError).toBeFalsy();
    const preparedText = prepared?.result?.content?.find((item: { type: string }) => item.type === "text")?.text;
    const preparedData = JSON.parse(preparedText);
    taskId = preparedData.task.id;

    const checkpoint = await first.request({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "tyrant_checkpoint",
        arguments: {
          schema_version: 1,
          task_id: taskId,
          request_id: "stdio-checkpoint-001",
          phase: "verification",
          last_reliable_step: "Completed MCP initialization and tool discovery",
          next_action: "Recover this checkpoint in a new server process",
        },
      },
    });
    expect(checkpoint?.result?.isError).toBeFalsy();
  } finally {
    await first.stop();
  }

  const restarted = startServer();
  try {
    const initialized = await restarted.initialize();
    expect(initialized?.result?.serverInfo?.name).toBe("tyrant");
    const recovered = await restarted.request({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "tyrant_get_task", arguments: { schema_version: 1, task_id: taskId } },
    });
    expect(recovered?.result?.isError).toBeFalsy();
    const recoveredText = recovered?.result?.content?.find((item: { type: string }) => item.type === "text")?.text;
    const recoveredData = JSON.parse(recoveredText);
    expect(recoveredData.task.id).toBe(taskId);
    expect(recoveredData.checkpoint.next_action).toBe("Recover this checkpoint in a new server process");
    expect(recoveredData.events[0].event_type).toBe("checkpoint_saved");
  } finally {
    await restarted.stop();
  }
});


