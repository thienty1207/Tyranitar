import * as z from "zod/v4";

const schemaVersion = z.literal(1).describe("Tyrant contract version.");
const requestId = z.string().trim().min(1).max(128).describe("Retry-safe ID unique to this mutation request.");
const taskId = z.string().trim().min(1).max(128).describe("Tyrant task identifier.");
const shortText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();
const evidenceReference = z.string().trim().min(1).max(512);
const boundedTextList = (maxItems: number, maxLength: number) =>
  z.array(z.string().trim().min(1).max(maxLength)).max(maxItems).default([]);
const taskLifecycleState = z.enum(["new", "planned", "in_progress", "verifying", "blocked", "handoff", "completed"]);
const transitionTarget = z.enum(["planned", "in_progress", "verifying", "blocked", "handoff"]);
const checkStatus = z.enum(["pass", "fail", "blocked", "skipped", "not_run", "needs_validation"]);
const checkpointCheck = z.object({
  check_id: shortText(128),
  status: checkStatus,
  summary: shortText(400),
  evidence_ref: evidenceReference.optional(),
});

export const prepareTaskInput = z.object({
  schema_version: schemaVersion,
  task: shortText(8_000).describe("A bounded task summary. Never include passwords, API keys, tokens, or other secrets; summaries are persisted locally in plaintext."),
  request_id: requestId,
  task_id: taskId.optional().describe("Existing task to resume; omit to create a task."),
  host_id: optionalText(128),
  session_id: optionalText(256),
});

export const getTaskInput = z.object({
  schema_version: schemaVersion,
  task_id: taskId.optional().describe("Task to read; omit to read the latest task for this project."),
});

export const transitionTaskInput = z.object({
  schema_version: schemaVersion,
  task_id: taskId,
  request_id: requestId,
  next_state: transitionTarget,
  reason: shortText(400),
  actor: optionalText(80),
  host_id: optionalText(128),
  session_id: optionalText(256),
});

export const listSkillsInput = z.object({ schema_version: schemaVersion });

export const checkpointInput = z.object({
  schema_version: schemaVersion,
  task_id: taskId,
  request_id: requestId,
  phase: shortText(80),
  last_reliable_step: shortText(500),
  next_action: shortText(500),
  blocker: z.string().trim().max(500).optional(),
  changed_files: z.array(z.string().trim().min(1).max(512)).max(10).default([]),
  evidence_refs: z.array(evidenceReference).max(10).default([]),
  intent: optionalText(800),
  constraints: boundedTextList(10, 300),
  non_goals: boundedTextList(10, 300),
  plan_progress: boundedTextList(20, 300),
  checks: z.array(checkpointCheck).max(10).default([]),
  ai_memory_refs: z.array(evidenceReference).max(10).default([]),
  graphify_refs: z.array(evidenceReference).max(10).default([]),
  actor: optionalText(80),
  host_id: optionalText(128),
  session_id: optionalText(256),
});

export const recordEventToolInput = z.object({
  schema_version: schemaVersion,
  task_id: taskId,
  request_id: requestId,
  event_type: z.enum([
    "task_created",
    "task_state_changed",
    "route_selected",
    "checkpoint_saved",
    "evidence_recorded",
    "memory_context_loaded",
    "graphify_context_loaded",
    "memory_sync_succeeded",
    "memory_sync_failed",
    "skill_loaded",
    "skill_used",
    "skill_completed",
    "skill_blocked",
    "skill_skipped",
    "task_completed",
    "task_blocked",
    "handoff_created",
  ]),
  summary: shortText(400),
  skill_id: z.string().trim().min(1).max(128).optional(),
  outcome: z.enum(["success", "failed", "blocked", "skipped", "incomplete", "uncertain"]).optional(),
  evidence_refs: z.array(evidenceReference).max(10).default([]),
  artifact_refs: z.array(evidenceReference).max(10).default([]),
  actor: optionalText(80),
  host_id: optionalText(128),
  session_id: optionalText(256),
  previous_state: taskLifecycleState.optional(),
  new_state: taskLifecycleState.optional(),
});

export const recordEventInput = recordEventToolInput.superRefine((input, context) => {
  if (input.event_type.startsWith("skill_")) {
    if (!input.skill_id) {
      context.addIssue({ code: "custom", path: ["skill_id"], message: "Skill lifecycle events require a skill_id." });
    }
    if (["skill_loaded", "skill_used", "skill_completed"].includes(input.event_type) && input.evidence_refs.length === 0) {
      context.addIssue({ code: "custom", path: ["evidence_refs"], message: "Loaded, used, and completed skill claims require host evidence." });
    }
    if (input.event_type === "skill_blocked" && input.outcome !== "blocked") {
      context.addIssue({ code: "custom", path: ["outcome"], message: "skill_blocked events require outcome=blocked." });
    }
    if (input.event_type === "skill_skipped" && input.outcome !== "skipped") {
      context.addIssue({ code: "custom", path: ["outcome"], message: "skill_skipped events require outcome=skipped." });
    }
  }
  if (input.event_type === "task_state_changed" && (!input.previous_state || !input.new_state)) {
    context.addIssue({ code: "custom", path: ["new_state"], message: "Task state events require both previous_state and new_state." });
  }
});

export const recordEvidenceInput = z.object({
  schema_version: schemaVersion,
  task_id: taskId,
  request_id: requestId,
  check_id: shortText(128),
  status: checkStatus,
  summary: shortText(500),
  evidence_ref: evidenceReference.optional(),
  actor: optionalText(80),
  host_id: optionalText(128),
  session_id: optionalText(256),
});

export const syncMemoryInput = z.object({
  schema_version: schemaVersion,
  task_id: taskId,
  request_id: requestId,
  session_id: optionalText(256),
});
export const finishTaskInput = z.object({
  schema_version: schemaVersion,
  task_id: taskId,
  request_id: requestId,
  status: z.enum(["completed", "blocked", "handoff"]),
  summary: shortText(800),
  next_action: z.string().trim().max(500).optional(),
  actor: optionalText(80),
  host_id: optionalText(128),
  session_id: optionalText(256),
});

export type PrepareTaskInput = z.infer<typeof prepareTaskInput>;
export type GetTaskInput = z.infer<typeof getTaskInput>;
export type TransitionTaskInput = z.infer<typeof transitionTaskInput>;
export type CheckpointInput = z.infer<typeof checkpointInput>;
export type RecordEventInput = z.infer<typeof recordEventInput>;
export type RecordEvidenceInput = z.infer<typeof recordEvidenceInput>;
export type FinishTaskInput = z.infer<typeof finishTaskInput>;
export type SyncMemoryInput = z.infer<typeof syncMemoryInput>;

