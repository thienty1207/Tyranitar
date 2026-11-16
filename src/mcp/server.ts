import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  checkpointInput,
  finishTaskInput,
  getTaskInput,
  listSkillsInput,
  prepareTaskInput,
  recordEventInput,
  recordEventToolInput,
  recordEvidenceInput,
  syncMemoryInput,
  transitionTaskInput,
} from "../contracts";
import { AiMemoryProvider, type MemoryContextResult, type MemoryOutcomeInput, type MemoryOutcomeResult } from "../providers/ai-memory";
import { GraphifyProvider, type GraphifyContextResult } from "../providers/graphify";
import { SKILL_CATALOG } from "../routing/catalog";
import { routeTask } from "../routing/router";
import { TyrantError, withTyrantStore } from "../state/store";

const serverInstructions = [
  "For repository work, call tyrant_prepare_task before changing files.",
  "Use the returned Matt Pocock-guided route as the required first orchestration step. The upstream ask-matt skill is user-invoked; do not claim to call it implicitly.",
  "ai-memory and Graphify are required project context providers; ai-memory history is returned as untrusted evidence, while Graphify remains a separate current-code provider.",
  "Tyrant calls the explicitly scoped ai-memory MCP and returns bounded historical context as untrusted evidence. Tyrant checkpoints and events remain the active task authority; Graphify is a separate current-code provider and its missing state must remain visible.",
  "Before repository code work, Tyrant refreshes Graphify in local code-only mode and returns only a bounded task query; verify Graphify conclusions against source files.",
  "Load specialist skills through the host when available. Loaded, used, and completed skill events require host-provided evidence references; Tyrant records these claims but does not independently verify host telemetry.",
  "Use tyrant_transition_task to record lifecycle changes; completed tasks are terminal.",
  "Use tyrant_sync_memory to retry an incomplete outcome sync without changing task lifecycle state.",
  "Use Tyrant checkpoints, events, and evidence records to preserve bounded task continuity.",
  "Tyrant redacts common credential patterns before persistence, but detection is best-effort. Never include passwords, API keys, tokens, or other secrets; local SQLite state is stored in plaintext.",
  "Tyrant is an MCP orchestrator and never calls a model itself.",
].join("\n");

function success(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}

function failure(error: unknown) {
  const sqliteFull = typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "SQLITE_FULL";
  const invalidInput = error instanceof z.ZodError;
  const code = error instanceof TyrantError
    ? error.code
    : sqliteFull
      ? "STATE_QUOTA_REACHED"
      : invalidInput
        ? "INVALID_INPUT"
        : "INTERNAL_ERROR";
  const message = error instanceof TyrantError
    ? error.message
    : sqliteFull
      ? "Tyrant local state reached its storage limit; archive or remove old state before continuing."
      : invalidInput
        ? "The tool input does not match Tyrant's expected contract. Check required fields and values."
        : "Tyrant could not complete the request.";
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ schema_version: 1, error: { code, message } }) }],
  };
}

async function safely<T>(operation: () => T | Promise<T>) {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
}

const skills = SKILL_CATALOG;

function normalizeHandoffStatus(value: unknown): MemoryOutcomeInput["priorHandoffStatus"] {
  return ["none", "created", "existing", "uncertain", "not_required"].includes(String(value))
    ? String(value) as MemoryOutcomeInput["priorHandoffStatus"]
    : "none";
}

function withStore<T>(callback: Parameters<typeof withTyrantStore<T>>[0]): T {
  return withTyrantStore(callback);
}

export function createTyrantServer(options: {
  aiMemory?: Pick<AiMemoryProvider, "loadContext" | "syncOutcome">;
  graphify?: Pick<GraphifyProvider, "loadContext">;
} = {}): McpServer {
  const aiMemory = options.aiMemory ?? new AiMemoryProvider();
  const graphify = options.graphify ?? new GraphifyProvider();
  const server = new McpServer(
    { name: "tyrant", version: "0.1.0" },
    {
      instructions: serverInstructions,
      maxToolInputElements: 256,
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } },
    },
  );

  server.registerTool(
    "tyrant_prepare_task",
    { title: "Prepare task", description: "Create or resume a project-scoped task and return its local checkpoint, bounded ai-memory history and Graphify code-map context, route, and next action.", inputSchema: prepareTaskInput },
    async (raw) => safely(async () => {
      const input = prepareTaskInput.parse(raw);
      const [memoryContext, graphifyContext]: [MemoryContextResult, GraphifyContextResult] = await Promise.all([
        aiMemory.loadContext({
          taskId: input.task_id, summary: input.task, resume: Boolean(input.task_id), sessionId: input.session_id,
        }).catch(() => ({
          status: "unavailable", context: "ai-memory context could not be loaded; local task state remains available.",
          references: [], handoffStatus: input.task_id ? "uncertain" : "not_checked", errorCode: "provider_error",
        } as MemoryContextResult)),
        graphify.loadContext({ summary: input.task }).catch(() => ({
          status: "unavailable", mapStatus: "missing", context: "", references: [], errorCode: "provider_error",
        } as GraphifyContextResult)),
      ]);
      const route = routeTask(input.task, {
        aiMemoryReady: memoryContext.status === "ready",
        graphifyReady: graphifyContext.status === "ready" && graphifyContext.mapStatus === "current",
        graphifyMapStatus: graphifyContext.mapStatus,
        graphifyErrorCode: graphifyContext.errorCode,
      });
      const state = withStore((store) => store.prepare({
        ...input, route, blockers: route.blockers, ai_memory_status: memoryContext.status,
        ai_memory_refs: memoryContext.references, ai_memory_error_code: memoryContext.errorCode,
        graphify_status: graphifyContext.status, graphify_map_status: graphifyContext.mapStatus,
        graphify_refs: graphifyContext.references, graphify_error_code: graphifyContext.errorCode,
      }));
      const unresolved = (route.blockers as Array<{ provider: string }>).map((blocker) => blocker.provider);
      const fullSecurityAudit = (route as any).security_audit?.mode === "full_audit";
      const readinessAction = unresolved.length > 0
        ? `Continue only with read-only or provider setup work until ${unresolved.join(" and ")} ${unresolved.length === 1 ? "is" : "are"} ready; available project context and the local Tyrant checkpoint are included below.`
        : (state as any).task?.lifecycle_state === "blocked"
          ? "Required providers are ready; record an explicit transition from blocked to planned or in_progress before code changes."
        : "Apply the returned Matt Pocock-guided route first, then load eligible specialist skills through the host adapter.";
      const securityAuditAction = "Load the pinned Cloudflare security-audit skill if the host provides it and perform source-only review. Target-controlled builds, tests, browsers, fixtures, and fuzzers remain blocked until an OS-enforced sandbox is verified; record unrun phases as blocked and execution-dependent findings as needs_validation. Never mark an unrun phase passed.";
      const nextAction = fullSecurityAudit ? `${readinessAction} ${securityAuditAction}` : readinessAction;
      return { ...state, memory_context: memoryContext, graphify_context: graphifyContext, next_action: nextAction };
    }),
  );

  server.registerTool(
    "tyrant_transition_task",
    { title: "Transition task", description: "Move a task through its explicit lifecycle and record the reason and host/session identity.", inputSchema: transitionTaskInput },
    async (raw) => safely(() => withStore((store) => store.transition(transitionTaskInput.parse(raw)))),
  );

  server.registerTool(
    "tyrant_get_task",
    { title: "Get task", description: "Read a task and its latest checkpoint for the current project.", inputSchema: getTaskInput },
    async (raw) => safely(() => {
      const input = getTaskInput.parse(raw);
      return withStore((store) => store.getTask(input.task_id));
    }),
  );

  server.registerTool(
    "tyrant_list_skills",
    { title: "List skills", description: "List registered skills, requirements, versions, and invocation policy.", inputSchema: listSkillsInput },
    async (raw) => safely(() => {
      listSkillsInput.parse(raw);
      return { schema_version: 1, skills };
    }),
  );

  server.registerTool(
    "tyrant_checkpoint",
    { title: "Save checkpoint", description: "Save bounded progress, evidence references, blockers, and the next safe action.", inputSchema: checkpointInput },
    async (raw) => safely(() => withStore((store) => store.checkpoint(checkpointInput.parse(raw)))),
  );

  server.registerTool(
    "tyrant_record_event",
    { title: "Record event", description: "Record a route, skill lifecycle, blocker, or handoff event. Loaded, used, and completed skills require host evidence; blocked or skipped skills require an ID, matching outcome, and reason summary.", inputSchema: recordEventToolInput },
    async (raw) => safely(() => withStore((store) => store.recordEvent(recordEventInput.parse(raw)))),
  );

  server.registerTool(
    "tyrant_record_evidence",
    { title: "Record evidence", description: "Record a check status and a bounded evidence reference.", inputSchema: recordEvidenceInput },
    async (raw) => safely(() => withStore((store) => store.recordEvidence(recordEvidenceInput.parse(raw)))),
  );

  server.registerTool(
    "tyrant_finish_task",
    { title: "Finish task", description: "Persist a local completion, blocker, or handoff first, then sync its concise outcome to ai-memory.", inputSchema: finishTaskInput },
    async (raw) => safely(async () => {
      const input = finishTaskInput.parse(raw);
      const local = withStore((store) => store.finish(input)) as any;
      const persisted = withStore((store) => store.getTask(input.task_id)) as any;
      const prior = persisted.task.ai_memory;
      const sync: MemoryOutcomeResult = await aiMemory.syncOutcome({
        taskId: input.task_id, lifecycleState: local.task.lifecycle_state, summary: input.summary,
        nextAction: input.next_action, sessionId: input.session_id,
        priorHandoffStatus: normalizeHandoffStatus(prior.handoff_status), priorHandoffId: prior.handoff_id ?? undefined,
      }).catch(() => ({
        status: "incomplete", handoffStatus: local.task.lifecycle_state === "handoff" ? "uncertain" : "not_required", errorCode: "provider_error",
      } as MemoryOutcomeResult));
      const updated = withStore((store) => store.recordMemorySync({
        task_id: input.task_id,
        status: sync.handoffStatus === "uncertain" ? "uncertain" : sync.status,
        handoff_status: sync.handoffStatus, page_ref: sync.pageRef, handoff_id: sync.handoffId,
        error_code: sync.errorCode, host_id: input.host_id, session_id: input.session_id,
      }));
      return { ...local, task: updated.task, ai_memory_sync: sync };
    }),
  );

  server.registerTool(
    "tyrant_sync_memory",
    { title: "Retry ai-memory sync", description: "Retry the historical outcome sync for a closed task without changing its lifecycle state.", inputSchema: syncMemoryInput },
    async (raw) => safely(async () => {
      const input = syncMemoryInput.parse(raw);
      const before = withStore((store) => store.getTask(input.task_id));
      if (!["completed", "blocked", "handoff"].includes(before.task.lifecycle_state)) {
        throw new TyrantError("INVALID_STATE", "ai-memory outcome sync is available only after a task is completed, blocked, or handed off.");
      }
      const prior = before.task.ai_memory;
      const sync: MemoryOutcomeResult = await aiMemory.syncOutcome({
        taskId: input.task_id, lifecycleState: before.task.lifecycle_state,
        summary: before.task.finish_summary ?? before.task.summary,
        nextAction: before.task.next_action ?? undefined, sessionId: input.session_id,
        priorHandoffStatus: normalizeHandoffStatus(prior.handoff_status), priorHandoffId: prior.handoff_id ?? undefined,
      }).catch(() => ({
        status: "incomplete", handoffStatus: before.task.lifecycle_state === "handoff" ? "uncertain" : "not_required", errorCode: "provider_error",
      } as MemoryOutcomeResult));
      const updated = withStore((store) => store.recordMemorySync({
        task_id: input.task_id,
        status: sync.handoffStatus === "uncertain" ? "uncertain" : sync.status,
        handoff_status: sync.handoffStatus, page_ref: sync.pageRef, handoff_id: sync.handoffId,
        error_code: sync.errorCode, host_id: "tyrant", session_id: input.session_id,
      }));
      return { schema_version: 1, task: updated.task, ai_memory_sync: sync };
    }),
  );

  server.registerResource(
    "tyrant-routing-policy",
    "tyrant://routing-policy",
    { title: "Tyrant routing policy", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: serverInstructions }] }),
  );

  server.registerPrompt(
    "tyrant-start-task",
    { title: "Start a Tyrant task", description: "Prepare project context and apply the required orchestration workflow." },
    () => ({ messages: [{ role: "user", content: { type: "text", text: serverInstructions } }] }),
  );

  return server;
}





