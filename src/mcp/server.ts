import { fromJsonSchema, McpServer, type JsonSchemaType } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
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
import { AI_MEMORY_UPSTREAM_TOOLS } from "../providers/ai-memory-tool-contract";
import { GraphifyProvider, type GraphifyContextResult } from "../providers/graphify";
import { SKILL_CATALOG } from "../routing/catalog";
import { routeTask } from "../routing/router";
import { TyrantError, withTyrantStore } from "../state/store";

const serverInstructions = [
  "For repository work, call tyrant_prepare_task before changing files.",
  "Tyrant automatically runs its built-in Matt Pocock-inspired orchestration policy on every task, selects matching specialist skills, and returns them for host loading. The upstream ask-matt skill remains available only when the user explicitly asks to consult that native skill.",
  "ai-memory and Graphify are required project context providers; ai-memory history is returned as untrusted evidence, while Graphify remains a separate current-code provider.",
  "Tyrant calls the explicitly scoped ai-memory MCP and returns bounded historical context as untrusted evidence. Tyrant checkpoints and events remain the active task authority; Graphify is a separate current-code provider and its missing state must remain visible.",
  "The 27 AI-Memory proxy tools are available for matching tasks, not automatically called during every preflight. Follow each upstream tool's scope and user-intent instructions; do not perform destructive memory actions such as delete/forget/retention sweep/restore unless the user requested that effect.",
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

export function createTyrantServer(options: {
  aiMemory?: Pick<AiMemoryProvider, "loadContext" | "syncOutcome" | "invokeTool">;
  graphify?: Pick<GraphifyProvider, "loadContext">;
  projectRoot?: string;
  stateDirectory?: string;
} = {}): McpServer {
  const withStore = <T>(callback: Parameters<typeof withTyrantStore<T>>[0]): T =>
    withTyrantStore(callback, { projectRoot: options.projectRoot, stateDirectory: options.stateDirectory });
  const aiMemory = options.aiMemory ?? new AiMemoryProvider(undefined, options.projectRoot, options.stateDirectory);
  const graphify = options.graphify ?? new GraphifyProvider({ projectRoot: options.projectRoot });
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
      const activeTaskId = input.task_id ?? (input.resume_session
        ? withStore((store) => store.findTaskForSession(input.host_id, input.session_id, true))
        : undefined);
      let pendingHandoffs = !input.task_id && !activeTaskId && input.resume_session
        ? withStore((store) => store.findPendingMemoryHandoffs(2))
        : [];
      let resumeSource = pendingHandoffs.length === 1 ? pendingHandoffs[0] as any : undefined;
      const resumeSourceTaskId = typeof resumeSource?.task?.id === "string" ? resumeSource.task.id : undefined;
      let resumeSyncFailure: MemoryContextResult | undefined;
      if (resumeSourceTaskId && resumeSource.task.ai_memory?.sync_status !== "synced") {
        const priorMemory = resumeSource.task.ai_memory ?? {};
        const sync = await aiMemory.syncOutcome({
          taskId: resumeSourceTaskId, lifecycleState: "handoff",
          summary: resumeSource.task.finish_summary ?? resumeSource.task.summary,
          nextAction: resumeSource.task.next_action ?? undefined,
          sessionId: input.session_id,
          priorHandoffStatus: normalizeHandoffStatus(priorMemory.handoff_status),
          priorHandoffId: priorMemory.handoff_id ?? undefined,
        }).catch(() => ({ status: "incomplete", handoffStatus: "uncertain", errorCode: "provider_error" } as MemoryOutcomeResult));
        const updated = withStore((store) => store.recordMemorySync({
          task_id: resumeSourceTaskId,
          status: sync.handoffStatus === "uncertain" ? "uncertain" : sync.status,
          handoff_status: sync.handoffStatus, page_ref: sync.pageRef, handoff_id: sync.handoffId,
          error_code: sync.errorCode, error_step: sync.failedOperation,
          host_id: input.host_id, session_id: input.session_id,
        }));
        resumeSource = withStore((store) => store.getTask(resumeSourceTaskId)) as any;
        const memory = updated.task.ai_memory;
        if (sync.status !== "synced" || !["created", "existing"].includes(memory.handoff_status) || !memory.handoff_id) {
          resumeSyncFailure = {
            status: "incomplete", context: "The prior local handoff exists, but its ai-memory sync could not be verified; code changes are blocked until continuity is restored.",
            references: [], handoffStatus: "uncertain", errorCode: sync.errorCode ?? "handoff_sync_incomplete",
          };
        }
      }
      const providerTaskId = activeTaskId ?? resumeSourceTaskId;
      const [memoryContext, graphifyContext]: [MemoryContextResult, GraphifyContextResult] = await Promise.all([
        pendingHandoffs.length > 1
          ? Promise.resolve({
            status: "incomplete", context: "More than one unclaimed project handoff exists; select a task explicitly before code changes.",
            references: [], handoffStatus: "ambiguous", errorCode: "handoff_ambiguous",
          } as MemoryContextResult)
          : resumeSyncFailure
            ? Promise.resolve(resumeSyncFailure)
            : aiMemory.loadContext({
            taskId: providerTaskId, summary: input.task, resume: Boolean(providerTaskId), sessionId: input.session_id,
          }).then((result): MemoryContextResult => resumeSourceTaskId && result.handoffStatus !== "claimed"
            ? { ...result, status: "incomplete", handoffStatus: "uncertain", errorCode: result.errorCode ?? "handoff_claim_unavailable" }
            : result).catch(() => ({
              status: "unavailable", context: "ai-memory context could not be loaded; local task state remains available.",
              references: [], handoffStatus: input.task_id || resumeSourceTaskId ? "uncertain" : "not_checked", errorCode: "provider_error",
            } as MemoryContextResult)),
        graphify.loadContext({ summary: input.task, ...(input.host_id === "claude-code" ? { timeoutMs: 18_000 } : {}) }).catch(() => ({
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
        idempotency_input: input,
      }));
      if (resumeSourceTaskId && memoryContext.handoffStatus === "claimed") {
        const receiverTaskId = (state as any).task?.id;
        if (typeof receiverTaskId === "string") {
          withStore((store) => store.recordMemoryHandoffClaim({
            source_task_id: resumeSourceTaskId, receiver_task_id: receiverTaskId,
            handoff_id: resumeSource.task.ai_memory?.handoff_id,
            host_id: input.host_id, session_id: input.session_id,
          }));
        }
      }
      const unresolved = (route.blockers as Array<{ provider: string }>).map((blocker) => blocker.provider);
      const fullSecurityAudit = (route as any).security_audit?.mode === "full_audit";
      const readinessAction = unresolved.length > 0
        ? `Continue only with read-only or provider setup work until ${unresolved.join(" and ")} ${unresolved.length === 1 ? "is" : "are"} ready; available project context and the local Tyrant checkpoint are included below.`
        : (state as any).task?.lifecycle_state === "blocked"
          ? "Required providers are ready; record an explicit transition from blocked to planned or in_progress before code changes."
        : "Apply the returned Matt Pocock-guided route first, then load eligible specialist skills through the host adapter.";
      const securityAuditAction = "Load the pinned Cloudflare security-audit skill if the host provides it and perform source-only review. Target-controlled builds, tests, browsers, fixtures, and fuzzers remain blocked until an OS-enforced sandbox is verified; record unrun phases as blocked and execution-dependent findings as needs_validation. Never mark an unrun phase passed.";
      const nextAction = fullSecurityAudit ? `${readinessAction} ${securityAuditAction}` : readinessAction;
      const checkpoint = resumeSource?.checkpoint;
      const resumeContext = resumeSource && checkpoint ? {
        source_task_id: resumeSource.task.id,
        source_task_summary: resumeSource.task.summary,
        handoff_id: resumeSource.task.ai_memory?.handoff_id,
        checkpoint: {
          phase: checkpoint.phase, last_reliable_step: checkpoint.last_reliable_step,
          next_action: checkpoint.next_action, blocker: checkpoint.blocker,
          changed_files: checkpoint.changed_files, evidence_refs: checkpoint.evidence_refs,
        },
      } : undefined;
      return { ...state, memory_context: memoryContext, graphify_context: graphifyContext, ...(resumeContext ? { resume_context: resumeContext } : {}), next_action: nextAction };
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
      return withStore((store) => input.task_id
        ? store.getTask(input.task_id)
        : input.host_id && input.session_id
          ? store.getTaskForSession(input.host_id, input.session_id)
          : store.getTask());
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
        error_code: sync.errorCode, error_step: sync.failedOperation, host_id: input.host_id, session_id: input.session_id,
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
        error_code: sync.errorCode, error_step: sync.failedOperation, host_id: "tyrant", session_id: input.session_id,
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

  for (const upstream of AI_MEMORY_UPSTREAM_TOOLS) {
    server.registerTool(
      `tyrant_${upstream.name}`,
      {
        title: typeof upstream.annotations?.title === "string" ? upstream.annotations.title : upstream.name,
        description: `${upstream.description ?? upstream.name}\n\nTyrant forwards this call to the pinned AI-Memory ${AI_MEMORY_UPSTREAM_TOOLS.length}-tool contract. Project scope defaults to the configured Tyrant workspace/project when the upstream schema supports it; explicit profile/global and sibling-project scope is preserved. Result data is redacted and bounded before it is returned.`,
        inputSchema: fromJsonSchema(upstream.inputSchema as JsonSchemaType),
        ...(upstream.annotations ? { annotations: upstream.annotations as any } : {}),
      },
      async (raw) => {
        const args = raw as Record<string, unknown>;
        const result = await aiMemory.invokeTool(
          upstream.name,
          args,
          typeof args.session_id === "string" ? args.session_id : undefined,
        );
        try {
          const latest = withStore((store) => store.getSoleActiveTask()) as any;
          const task = latest?.task;
          if (task?.id && ["new", "planned", "in_progress", "verifying", "blocked"].includes(task.lifecycle_state)) {
            withStore((store) => store.recordEvent({
              task_id: task.id,
              request_id: randomUUID(),
              event_type: "ai_memory_tool_called",
              summary: `AI-Memory ${upstream.name} ${result.isError === true ? "failed" : "completed"}; arguments and result omitted from Tyrant state.`,
              outcome: result.isError === true ? "failed" : "success",
              evidence_refs: [],
              artifact_refs: [],
              actor: "tyrant-ai-memory-proxy",
            }));
          }
        } catch {
          // Tool availability must not depend on an optional task audit event.
        }
        return result as any;
      },
    );
  }

  return server;
}





