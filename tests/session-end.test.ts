import { expect, test } from "bun:test";

const sessionEndApi = await import("../src/adapters/session-end").catch(() => undefined);

function toolResult(value: unknown) {
  return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
}

function taskResult(overrides: Record<string, unknown> = {}) {
  return toolResult({
    task: {
      id: "task-1",
      summary: "Implement list endpoint",
      lifecycle_state: "in_progress",
      next_action: null,
      ai_memory: { sync_status: "not_started", handoff_status: "not_required" },
    },
    checkpoint: { next_action: "Run the endpoint checks", phase: "implementation" },
    events: [],
    ...overrides,
  });
}

test("session end looks up a task using the exact host and session and does nothing when absent", async () => {
  expect(sessionEndApi?.runAutomaticSessionEnd).toBeDefined();
  if (!sessionEndApi) return;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const result = await sessionEndApi.runAutomaticSessionEnd(
    { host_id: "codex", cwd: "D:/project", session_id: "session-1", event: "SessionEnd" },
    async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "NOT_FOUND" } }) }] };
    },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ name: "tyrant_get_task", args: { host_id: "codex", session_id: "session-1" } });
  expect(result.status).toBe("no_task");
});

test("session end leaves terminal tasks unchanged", async () => {
  expect(sessionEndApi?.runAutomaticSessionEnd).toBeDefined();
  if (!sessionEndApi) return;
  const calls: string[] = [];
  const result = await sessionEndApi.runAutomaticSessionEnd(
    { host_id: "claude-code", cwd: "D:/project", session_id: "session-2", event: "SessionEnd" },
    async (name: string) => {
      calls.push(name);
      return taskResult({ task: { id: "task-done", lifecycle_state: "completed", ai_memory: { sync_status: "synced" } } });
    },
  );
  expect(calls).toEqual(["tyrant_get_task"]);
  expect(result.status).toBe("terminal_noop");
});

test("a reliable session end hands off from the latest checkpoint and syncs once", async () => {
  expect(sessionEndApi?.runAutomaticSessionEnd).toBeDefined();
  if (!sessionEndApi) return;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const result = await sessionEndApi.runAutomaticSessionEnd(
    { host_id: "dsh", cwd: "D:/project", session_id: "session-3", event: "agent/disposed" },
    async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "tyrant_get_task") return taskResult();
      if (name === "tyrant_finish_task") return toolResult({ task: { id: "task-1", lifecycle_state: "handoff", ai_memory: { sync_status: "synced", handoff_status: "created" } }, ai_memory_sync: { status: "synced", handoffStatus: "created" } });
      throw new Error(`unexpected tool ${name}`);
    },
  );
  expect(calls.map((call) => call.name)).toEqual(["tyrant_get_task", "tyrant_finish_task"]);
  expect(calls[1].args).toMatchObject({ status: "handoff", host_id: "dsh", session_id: "session-3", actor: "tyrant-session-end", next_action: "Run the endpoint checks" });
  expect(String(calls[1].args.summary)).not.toContain("transcript");
  expect(result.status).toBe("handed_off");
  expect(result.sync_status).toBe("synced");
});

test("a repeated close retries only an incomplete handoff sync with a stable request ID", async () => {
  expect(sessionEndApi?.runAutomaticSessionEnd).toBeDefined();
  if (!sessionEndApi) return;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const input = { host_id: "opencode", cwd: "D:/project", session_id: "session-4", event: "session.deleted" } as const;
  const handler = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "tyrant_get_task") return taskResult({
      task: { id: "task-1", lifecycle_state: "handoff", ai_memory: { sync_status: "incomplete", handoff_status: "uncertain" } },
      events: [{ event_type: "handoff_created", actor: "tyrant-session-end", host_id: "opencode", session_id: "session-4" }],
    });
    if (name === "tyrant_sync_memory") return toolResult({ task: { id: "task-1", lifecycle_state: "handoff", ai_memory: { sync_status: "synced", handoff_status: "existing" } }, ai_memory_sync: { status: "synced", handoffStatus: "existing" } });
    throw new Error(`unexpected tool ${name}`);
  };
  const first = await sessionEndApi.runAutomaticSessionEnd(input, handler);
  const second = await sessionEndApi.runAutomaticSessionEnd(input, handler);
  const syncCalls = calls.filter((call) => call.name === "tyrant_sync_memory");
  expect(syncCalls).toHaveLength(2);
  expect(syncCalls[0].args.request_id).toBe(syncCalls[1].args.request_id);
  expect(calls.filter((call) => call.name === "tyrant_finish_task")).toHaveLength(0);
  expect(first.status).toBe("synced");
  expect(second.status).toBe("synced");
});

test("ordinary idle and step events are rejected as session close signals", async () => {
  expect(sessionEndApi?.runAutomaticSessionEnd).toBeDefined();
  if (!sessionEndApi) return;
  let calls = 0;
  const result = await sessionEndApi.runAutomaticSessionEnd(
    { host_id: "opencode", cwd: "D:/project", session_id: "session-5", event: "session.idle" },
    async () => { calls += 1; return taskResult(); },
  );
  expect(result.status).toBe("unsupported_event");
  expect(calls).toBe(0);
});

test("hosts without a reliable close event expose the explicit-only handoff capability", () => {
  expect(sessionEndApi?.getSessionEndCapability).toBeDefined();
  if (!sessionEndApi) return;
  expect(sessionEndApi.getSessionEndCapability("claude-desktop")).toEqual({ status: "explicit_only", event: null });
  expect(sessionEndApi.getSessionEndCapability("opencode")).toEqual({ status: "automatic", event: "session.deleted" });
});

test("an unsuccessful AI-Memory handoff is surfaced with a safe retry diagnostic", async () => {
  expect(sessionEndApi?.runAutomaticSessionEnd).toBeDefined();
  if (!sessionEndApi) return;
  const result = await sessionEndApi.runAutomaticSessionEnd(
    { host_id: "codex", cwd: "D:/project", session_id: "session-6", event: "SessionEnd" },
    async (name: string) => {
      if (name === "tyrant_get_task") return taskResult();
      if (name === "tyrant_finish_task") return toolResult({
        task_id: "task-1",
        task: { id: "task-1", lifecycle_state: "handoff", ai_memory: { sync_status: "incomplete", error_code: "provider_error", error_step: "memory_handoff_begin" } },
        ai_memory_sync: { status: "incomplete", handoffStatus: "uncertain", errorCode: "provider_error", failedOperation: "memory_handoff_begin" },
      });
      throw new Error(`unexpected tool ${name}`);
    },
  );
  expect(result).toMatchObject({
    status: "pending_sync", task_id: "task-1", sync_status: "incomplete",
    handoff_status: "uncertain", error_code: "provider_error", failed_operation: "memory_handoff_begin",
  });
});
