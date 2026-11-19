import { createHash } from "node:crypto";
import type { TyrantToolCaller } from "./auto-preflight";

export type AutomaticSessionEndInput = {
  host_id: "codex" | "claude-code" | "dsh" | "opencode";
  cwd: string;
  session_id: string;
  event: string;
};

export type AutomaticSessionEndResult = {
  status: "unsupported_event" | "no_task" | "terminal_noop" | "already_handed_off" | "handed_off" | "synced" | "pending_sync" | "lookup_failed";
  task_id?: string;
  sync_status?: string;
  handoff_status?: string;
  error_code?: string;
  failed_operation?: string;
};

const reliableEndEvents: Record<AutomaticSessionEndInput["host_id"], string> = {
  codex: "SessionEnd",
  "claude-code": "SessionEnd",
  dsh: "agent/disposed",
  opencode: "session.deleted",
};

export function getSessionEndCapability(hostId: string) {
  const event = isRecord(reliableEndEvents) && Object.hasOwn(reliableEndEvents, hostId)
    ? reliableEndEvents[hostId as AutomaticSessionEndInput["host_id"]]
    : undefined;
  return event
    ? { status: "automatic" as const, event }
    : { status: "explicit_only" as const, event: null };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolErrorCode(response: unknown): string | undefined {
  if (!isRecord(response) || response.isError !== true || !Array.isArray(response.content)) return undefined;
  const text = response.content.find((item: unknown) => isRecord(item) && item.type === "text")?.text;
  if (typeof text !== "string") return undefined;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.code === "string" ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
}

function readToolResult(response: unknown): Record<string, any> {
  if (!isRecord(response)) throw new Error("invalid_tool_response");
  if (response.isError === true) {
    const code = toolErrorCode(response);
    const error = new Error(code ?? "tool_call_failed");
    Object.assign(error, { code });
    throw error;
  }
  if (isRecord(response.structuredContent)) return response.structuredContent;
  const text = Array.isArray(response.content)
    ? response.content.find((item: unknown) => isRecord(item) && item.type === "text")?.text
    : undefined;
  if (typeof text === "string") {
    try {
      const parsed = JSON.parse(text);
      if (isRecord(parsed)) return parsed;
    } catch {
      // The caller receives a bounded internal status, not provider or transport text.
    }
  }
  return response;
}

function requestId(input: AutomaticSessionEndInput, taskId: string, operation: "finish" | "sync"): string {
  const key = [input.host_id, input.session_id, input.event, taskId, operation].join("\n");
  return `session-end-${createHash("sha256").update(key).digest("hex").slice(0, 56)}`;
}

function ownedHandoff(task: Record<string, any>, input: AutomaticSessionEndInput): boolean {
  return Array.isArray(task.events) && task.events.some((event: unknown) =>
    isRecord(event)
      && event.event_type === "handoff_created"
      && event.actor === "tyrant-session-end"
      && event.host_id === input.host_id
      && event.session_id === input.session_id,
  );
}

function syncResult(result: Record<string, any>, fallbackStatus: string, successStatus: "handed_off" | "synced" = "synced"): AutomaticSessionEndResult {
  const sync = isRecord(result.ai_memory_sync) ? result.ai_memory_sync : {};
  const taskMemory = isRecord(result.task?.ai_memory) ? result.task.ai_memory : {};
  const status = typeof sync.status === "string" ? sync.status : typeof taskMemory.sync_status === "string" ? taskMemory.sync_status : fallbackStatus;
  const handoffStatus = typeof sync.handoffStatus === "string"
    ? sync.handoffStatus
    : typeof taskMemory.handoff_status === "string" ? taskMemory.handoff_status : undefined;
  return {
    status: status === "synced" && handoffStatus !== "uncertain" ? successStatus : "pending_sync",
    ...(typeof result.task_id === "string" ? { task_id: result.task_id } : typeof result.task?.id === "string" ? { task_id: result.task.id } : {}),
    sync_status: status,
    ...(handoffStatus ? { handoff_status: handoffStatus } : {}),
    ...(typeof sync.errorCode === "string" ? { error_code: sync.errorCode } : typeof taskMemory.error_code === "string" ? { error_code: taskMemory.error_code } : {}),
    ...(typeof sync.failedOperation === "string" ? { failed_operation: sync.failedOperation } : typeof taskMemory.error_step === "string" ? { failed_operation: taskMemory.error_step } : {}),
  };
}

export async function runAutomaticSessionEnd(
  input: AutomaticSessionEndInput,
  callTool: TyrantToolCaller,
): Promise<AutomaticSessionEndResult> {
  if (reliableEndEvents[input.host_id] !== input.event || !input.cwd.trim() || !input.session_id.trim()) {
    return { status: "unsupported_event" };
  }

  let task: Record<string, any>;
  try {
    task = readToolResult(await callTool("tyrant_get_task", {
      schema_version: 1,
      host_id: input.host_id,
      session_id: input.session_id,
    }));
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    return code === "NOT_FOUND" ? { status: "no_task" } : { status: "lookup_failed", error_code: code ?? "tyrant_lookup_failed" };
  }

  const taskId = typeof task.task?.id === "string" ? task.task.id : "";
  const lifecycle = task.task?.lifecycle_state;
  if (!taskId) return { status: "no_task" };
  if (lifecycle === "completed") return { status: "terminal_noop", task_id: taskId };

  if (lifecycle === "handoff") {
    if (!ownedHandoff(task, input)) return { status: "terminal_noop", task_id: taskId };
    const memory = isRecord(task.task.ai_memory) ? task.task.ai_memory : {};
    if (memory.sync_status === "synced" && memory.handoff_status !== "uncertain") {
      return { status: "already_handed_off", task_id: taskId, sync_status: "synced", handoff_status: String(memory.handoff_status ?? "created") };
    }
    try {
      const retry = readToolResult(await callTool("tyrant_sync_memory", {
        schema_version: 1,
        task_id: taskId,
        request_id: requestId(input, taskId, "sync"),
        session_id: input.session_id,
      }));
      return { task_id: taskId, ...syncResult(retry, "incomplete") };
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      return { status: "pending_sync", task_id: taskId, sync_status: "incomplete", error_code: code ?? "memory_sync_failed" };
    }
  }

  const checkpoint = isRecord(task.checkpoint) ? task.checkpoint : {};
  const nextAction = typeof checkpoint.next_action === "string" && checkpoint.next_action.trim()
    ? checkpoint.next_action.trim().slice(0, 500)
    : typeof task.task.next_action === "string" && task.task.next_action.trim()
      ? task.task.next_action.trim().slice(0, 500)
      : "Resume from the latest Tyrant checkpoint and verify the current repository state.";
  try {
    const finished = readToolResult(await callTool("tyrant_finish_task", {
      schema_version: 1,
      task_id: taskId,
      request_id: requestId(input, taskId, "finish"),
      status: "handoff",
      summary: "The host agent was disposed before Tyrant received explicit completion evidence. A handoff was saved from the latest checkpoint; no completion was inferred.",
      next_action: nextAction,
      actor: "tyrant-session-end",
      host_id: input.host_id,
      session_id: input.session_id,
    }));
    return { task_id: taskId, ...syncResult(finished, "incomplete", "handed_off") };
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    return { status: "pending_sync", task_id: taskId, sync_status: "incomplete", error_code: code ?? "session_handoff_failed" };
  }
}
