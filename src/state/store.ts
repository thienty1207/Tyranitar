import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { redactSensitiveText, redactTextArray } from "./redaction";

export type TaskStatus = "active" | "blocked" | "completed" | "handoff";
export type TaskLifecycleState = "new" | "planned" | "in_progress" | "verifying" | "blocked" | "handoff" | "completed";
const MAX_TASKS_PER_PROJECT = 250;
const MAX_STORED_MUTATIONS = 1_000;
const MAX_STATE_BYTES = 64 * 1024 * 1024;

export class TyrantError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "REQUEST_CONFLICT" | "INVALID_STATE" | "STATE_QUOTA_REACHED",
    message: string,
  ) {
    super(message);
    this.name = "TyrantError";
  }
}

type StoredTask = {
  id: string;
  project_id: string;
  task: string;
  status: TaskStatus;
  lifecycle_state: TaskLifecycleState;
  ai_memory_status: string;
  graphify_status: string;
  graphify_map_status: string;
  graphify_refs_json: string;
  graphify_error_code: string | null;
  memory_sync_status: string;
  memory_handoff_status: string;
  memory_page_ref: string | null;
  memory_handoff_id: string | null;
  memory_error_code: string | null;
  memory_error_step: string | null;
  finish_summary: string | null;
  next_action: string | null;
  finished_at: string | null;
  route_json: string;
  blockers_json: string;
  created_at: string;
  updated_at: string;
};

function stateDirectory(override?: string): string {
  if (override?.trim()) return resolve(override);
  if (process.env.TYRANT_STATE_DIR?.trim()) return resolve(process.env.TYRANT_STATE_DIR);
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Tyrant");
  }
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "tyrant");
}

function canonicalProjectRoot(projectRoot?: string): string {
  const candidate = resolve(projectRoot?.trim() || process.env.TYRANT_PROJECT_ROOT?.trim() || process.cwd());
  try {
    return realpathSync(candidate);
  } catch {
    throw new TyrantError("INVALID_STATE", "The configured project directory is unavailable.");
  }
}

function projectId(root: string): string {
  const normalized = process.platform === "win32" ? root.toLocaleLowerCase("en-US") : root;
  return createHash("sha256").update(normalized).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function now(): string {
  return new Date().toISOString();
}

export class TyrantStore {
  readonly projectId: string;
  readonly projectRoot: string;
  private readonly db: Database;

  constructor(options: { projectRoot?: string; stateDirectory?: string } = {}) {
    this.projectRoot = canonicalProjectRoot(options.projectRoot);
    this.projectId = projectId(this.projectRoot);
    const directory = stateDirectory(options.stateDirectory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dbPath = join(directory, "tyrant.sqlite3");
    this.db = new Database(dbPath, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const pageSize = this.db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 4_096;
    const maxPageCount = Math.max(1, Math.floor(MAX_STATE_BYTES / pageSize));
    this.db.exec(`PRAGMA max_page_count = ${maxPageCount};`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','blocked','completed','handoff')),
        lifecycle_state TEXT NOT NULL DEFAULT 'new' CHECK (lifecycle_state IN ('new','planned','in_progress','verifying','blocked','handoff','completed')),
        ai_memory_status TEXT NOT NULL DEFAULT 'unavailable',
        graphify_status TEXT NOT NULL DEFAULT 'unavailable',
        graphify_map_status TEXT NOT NULL DEFAULT 'missing',
        graphify_refs_json TEXT NOT NULL DEFAULT '[]',
        graphify_error_code TEXT,
        memory_sync_status TEXT NOT NULL DEFAULT 'not_started',
        memory_handoff_status TEXT NOT NULL DEFAULT 'not_required',
        memory_page_ref TEXT,
        memory_handoff_id TEXT,
        memory_error_code TEXT,
        memory_error_step TEXT,
        finish_summary TEXT,
        next_action TEXT,
        finished_at TEXT,
        route_json TEXT NOT NULL,
        blockers_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_project_updated ON tasks(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        phase TEXT NOT NULL,
        last_reliable_step TEXT NOT NULL,
        next_action TEXT NOT NULL,
        blocker TEXT,
        changed_files_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS checkpoints_task_created ON checkpoints(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        skill_id TEXT,
        outcome TEXT,
        next_action TEXT,
        evidence_refs_json TEXT NOT NULL,
        artifact_refs_json TEXT NOT NULL DEFAULT '[]',
        actor TEXT,
        host_id TEXT,
        session_id TEXT,
        previous_state TEXT,
        new_state TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task_created ON events(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        check_id TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence_ref TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evidence_task_created ON evidence(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS idempotency (
        scope TEXT NOT NULL,
        request_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope, request_id)
      );
    `);
    let taskColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
    if (!taskColumns.some((column) => column.name === "lifecycle_state")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'new';");
      this.db.exec("UPDATE tasks SET lifecycle_state = CASE status WHEN 'active' THEN 'in_progress' WHEN 'blocked' THEN 'blocked' WHEN 'handoff' THEN 'handoff' WHEN 'completed' THEN 'completed' ELSE 'new' END;");
      taskColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
    }
    const addTaskColumn = (name: string, definition: string) => {
      if (!taskColumns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition};`);
      taskColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
    };
    addTaskColumn("ai_memory_status", "TEXT NOT NULL DEFAULT 'unavailable'");
    addTaskColumn("graphify_status", "TEXT NOT NULL DEFAULT 'unavailable'");
    addTaskColumn("graphify_map_status", "TEXT NOT NULL DEFAULT 'missing'");
    addTaskColumn("graphify_refs_json", "TEXT NOT NULL DEFAULT '[]'");
    addTaskColumn("graphify_error_code", "TEXT");
    addTaskColumn("memory_sync_status", "TEXT NOT NULL DEFAULT 'not_started'");
    addTaskColumn("memory_handoff_status", "TEXT NOT NULL DEFAULT 'not_required'");
    addTaskColumn("memory_page_ref", "TEXT");
    addTaskColumn("memory_handoff_id", "TEXT");
    addTaskColumn("memory_error_code", "TEXT");
    addTaskColumn("memory_error_step", "TEXT");
    if (!taskColumns.some((column) => column.name === "finish_summary")) this.db.exec("ALTER TABLE tasks ADD COLUMN finish_summary TEXT;");
    if (!taskColumns.some((column) => column.name === "next_action")) this.db.exec("ALTER TABLE tasks ADD COLUMN next_action TEXT;");
    if (!taskColumns.some((column) => column.name === "finished_at")) this.db.exec("ALTER TABLE tasks ADD COLUMN finished_at TEXT;");
    const checkpointColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(checkpoints)").all();
    if (!checkpointColumns.some((column) => column.name === "details_json")) this.db.exec("ALTER TABLE checkpoints ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}';");
    let eventColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(events)").all();
    const addEventColumn = (name: string, definition: string) => {
      if (!eventColumns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition};`);
      eventColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(events)").all();
    };
    addEventColumn("artifact_refs_json", "TEXT NOT NULL DEFAULT '[]'");
    addEventColumn("actor", "TEXT");
    addEventColumn("host_id", "TEXT");
    addEventColumn("session_id", "TEXT");
    addEventColumn("previous_state", "TEXT");
    addEventColumn("new_state", "TEXT");
    addEventColumn("metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    if (!eventColumns.some((column) => column.name === "next_action")) {
      this.db.exec("ALTER TABLE events ADD COLUMN next_action TEXT;");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS events_host_session ON events(host_id, session_id, created_at DESC);");
    if (process.platform !== "win32") {
      try {
        chmodSync(directory, 0o700);
        chmodSync(dbPath, 0o600);
      } catch {
        // File mode enforcement is best-effort on filesystems that do not support it.
      }
    }
  }

  close(): void {
    this.db.close();
  }

  private ensureTask(taskId: string): StoredTask {
    const task = this.db.query<StoredTask, [string, string]>(
      "SELECT * FROM tasks WHERE id = ? AND project_id = ?",
    ).get(taskId, this.projectId);
    if (!task) throw new TyrantError("NOT_FOUND", "Task was not found in this project.");
    return task;
  }

  findTaskForSession(hostId?: string, sessionId?: string, activeOnly = false): string | undefined {
    if (!hostId || !sessionId) return undefined;
    const lifecycleFilter = activeOnly ? "AND t.lifecycle_state NOT IN ('completed', 'handoff')" : "";
    const row = this.db.query<{ id: string }, [string, string, string]>(
      `SELECT t.id FROM tasks t
       WHERE t.project_id = ? ${lifecycleFilter}
         AND EXISTS (
           SELECT 1 FROM events e
           WHERE e.task_id = t.id AND e.host_id = ? AND e.session_id = ?
         )
       ORDER BY t.updated_at DESC LIMIT 1`,
    ).get(this.projectId, hostId, sessionId);
    return row?.id;
  }

  findPendingMemoryHandoffs(limit = 2): Array<Record<string, any>> {
    const boundedLimit = Math.max(1, Math.min(2, Math.floor(limit)));
    const rows = this.db.query<{ id: string }, [string, number]>(
      "SELECT t.id FROM tasks t WHERE t.project_id = ? AND t.lifecycle_state = 'handoff' AND (t.memory_sync_status != 'synced' OR (t.memory_handoff_status IN ('created', 'existing') AND t.memory_handoff_id IS NOT NULL)) AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.event_type = 'memory_handoff_claimed') ORDER BY t.updated_at DESC LIMIT ?",
    ).all(this.projectId, boundedLimit);
    return rows.map(({ id }) => this.getTask(id));
  }

  recordMemoryHandoffClaim(input: { source_task_id: string; receiver_task_id: string; handoff_id?: string; host_id?: string; session_id?: string }) {
    const transaction = this.db.transaction(() => {
      this.ensureTask(input.source_task_id);
      this.ensureTask(input.receiver_task_id);
      const alreadyClaimed = this.db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM events WHERE task_id = ? AND event_type = 'memory_handoff_claimed'",
      ).get(input.source_task_id)?.count ?? 0;
      if (alreadyClaimed > 0) return false;
      this.insertEvent({
        task_id: input.source_task_id, event_type: "memory_handoff_claimed",
        summary: "Claimed the prior ai-memory handoff for a new host task.", outcome: "success",
        evidence_refs: [
          ...(input.handoff_id ? [`ai-memory:handoff:${input.handoff_id}`] : []),
          `tyrant-task:${input.receiver_task_id}`,
        ], actor: "tyrant", host_id: input.host_id, session_id: input.session_id,
      });
      return true;
    });
    return transaction();
  }

  getTaskForSession(hostId: string, sessionId: string) {
    const taskId = this.findTaskForSession(hostId, sessionId);
    if (!taskId) throw new TyrantError("NOT_FOUND", "No task was found for this host session in this project.");
    return this.getTask(taskId);
  }

  private replay<T>(scope: string, requestId: string, payload: unknown): T | undefined {
    const row = this.db.query<{ payload_hash: string; response_json: string }, [string, string]>(
      "SELECT payload_hash, response_json FROM idempotency WHERE scope = ? AND request_id = ?",
    ).get(scope, this.requestKey(requestId));
    if (!row) return undefined;
    const hash = createHash("sha256").update(canonicalJson(payload)).digest("hex");
    if (row.payload_hash !== hash) {
      throw new TyrantError("REQUEST_CONFLICT", "This request_id was already used with different data.");
    }
    return JSON.parse(row.response_json) as T;
  }

  private saveReplay(scope: string, requestId: string, payload: unknown, response: unknown): void {
    const row = this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM idempotency").get();
    if ((row?.count ?? 0) >= MAX_STORED_MUTATIONS) {
      throw new TyrantError("STATE_QUOTA_REACHED", "Tyrant local state reached its write limit; archive or remove old state before continuing.");
    }
    const hash = createHash("sha256").update(canonicalJson(payload)).digest("hex");
    this.db.query(
      "INSERT INTO idempotency(scope, request_id, payload_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(scope, this.requestKey(requestId), hash, JSON.stringify(response), now());
  }

  private requestKey(requestId: string): string {
    return createHash("sha256").update(requestId).digest("hex");
  }

  private insertEvent(input: {
    task_id: string; event_type: string; summary: string; skill_id?: string; outcome?: string;
    next_action?: string; evidence_refs?: string[]; artifact_refs?: string[]; actor?: string; host_id?: string;
    session_id?: string; previous_state?: TaskLifecycleState; new_state?: TaskLifecycleState;
  }) {
    const event = {
      id: randomUUID(), task_id: input.task_id, event_type: input.event_type,
      summary: redactSensitiveText(input.summary), skill_id: input.skill_id ? redactSensitiveText(input.skill_id) : null,
      outcome: input.outcome ?? null, next_action: input.next_action ? redactSensitiveText(input.next_action) : null,
      evidence_refs: redactTextArray(input.evidence_refs ?? []), artifact_refs: redactTextArray(input.artifact_refs ?? []),
      actor: input.actor ? redactSensitiveText(input.actor) : null, host_id: input.host_id ? redactSensitiveText(input.host_id) : null,
      session_id: input.session_id ? redactSensitiveText(input.session_id) : null,
      previous_state: input.previous_state ?? null, new_state: input.new_state ?? null, created_at: now(),
    };
    this.db.query(
      "INSERT INTO events(id,task_id,event_type,summary,skill_id,outcome,next_action,evidence_refs_json,artifact_refs_json,actor,host_id,session_id,previous_state,new_state,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(event.id, event.task_id, event.event_type, event.summary, event.skill_id, event.outcome, event.next_action,
      JSON.stringify(event.evidence_refs), JSON.stringify(event.artifact_refs), event.actor, event.host_id, event.session_id,
      event.previous_state, event.new_state, "{}", event.created_at);
    return event;
  }

  private insertGraphifyContextEvent(
    taskId: string,
    status: "ready" | "incomplete" | "unavailable",
    mapStatus: "current" | "stale" | "missing" | "unsafe",
    references: string[],
    errorCode?: string,
    hostId?: string,
    sessionId?: string,
  ) {
    this.insertEvent({
      task_id: taskId,
      event_type: "graphify_context_loaded",
      summary: status === "ready"
        ? "Loaded a current Graphify map and bounded query; verify important claims against source."
        : `Graphify context is ${status}; map is ${mapStatus}${errorCode ? ` (${errorCode})` : ""}.`,
      outcome: status === "ready" ? "success" : status === "incomplete" ? "incomplete" : "blocked",
      evidence_refs: references,
      actor: "tyrant",
      host_id: hostId,
      session_id: sessionId,
    });
  }

  getTask(taskId?: string) {
    const row = taskId
      ? this.db.query<StoredTask, [string, string]>("SELECT * FROM tasks WHERE id = ? AND project_id = ?").get(taskId, this.projectId)
      : this.db.query<StoredTask, [string]>("SELECT * FROM tasks WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1").get(this.projectId);
    if (!row) throw new TyrantError("NOT_FOUND", "No task was found for this project.");
    const checkpoint = this.db.query<Record<string, unknown>, [string]>(
      `SELECT id, phase, last_reliable_step, next_action, blocker, changed_files_json, evidence_refs_json, details_json, created_at
       FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(row.id);
    const events = this.db.query<Record<string, unknown>, [string]>(
      "SELECT id, task_id, event_type, summary, skill_id, outcome, next_action, evidence_refs_json, artifact_refs_json, actor, host_id, session_id, previous_state, new_state, metadata_json, created_at FROM events WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20",
    ).all(row.id);
    const latestBlockEvent = this.db.query<Record<string, unknown>, [string]>(
      "SELECT id, event_type, summary, new_state, actor, host_id, session_id, created_at FROM events WHERE task_id = ? AND (event_type = 'task_blocked' OR (event_type = 'task_state_changed' AND new_state = 'blocked')) ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(row.id);
    const evidence = this.db.query<Record<string, unknown>, [string]>(
      "SELECT id, check_id, status, summary, evidence_ref, created_at FROM evidence WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20",
    ).all(row.id);
    const jsonArray = (value: unknown) => JSON.parse(String(value)) as unknown[];
    const jsonObject = (value: unknown) => JSON.parse(String(value)) as Record<string, unknown>;
    return {
      schema_version: 1,
      task: {
        id: row.id, summary: row.task, status: row.status, lifecycle_state: row.lifecycle_state,
        finish_summary: row.finish_summary, next_action: row.next_action, finished_at: row.finished_at,
        project_id: row.project_id, created_at: row.created_at, updated_at: row.updated_at,
        ai_memory: { context_status: row.ai_memory_status, sync_status: row.memory_sync_status, handoff_status: row.memory_handoff_status, page_ref: row.memory_page_ref, handoff_id: row.memory_handoff_id, error_code: row.memory_error_code, error_step: row.memory_error_step },
        graphify: { context_status: row.graphify_status, map_status: row.graphify_map_status, references: jsonArray(row.graphify_refs_json), error_code: row.graphify_error_code },
      },
      route: JSON.parse(row.route_json), blockers: JSON.parse(row.blockers_json),
      latest_block_event: latestBlockEvent ?? null,
      checkpoint: checkpoint ? {
        id: checkpoint.id, phase: checkpoint.phase, last_reliable_step: checkpoint.last_reliable_step,
        next_action: checkpoint.next_action, blocker: checkpoint.blocker,
        changed_files: jsonArray(checkpoint.changed_files_json), evidence_refs: jsonArray(checkpoint.evidence_refs_json),
        ...jsonObject(checkpoint.details_json), created_at: checkpoint.created_at,
      } : null,
      events: events.map((event) => ({
        id: event.id, task_id: event.task_id, event_type: event.event_type, summary: event.summary,
        skill_id: event.skill_id, outcome: event.outcome, next_action: event.next_action,
        evidence_refs: jsonArray(event.evidence_refs_json), artifact_refs: jsonArray(event.artifact_refs_json),
        actor: event.actor, host_id: event.host_id, session_id: event.session_id,
        previous_state: event.previous_state, new_state: event.new_state,
        metadata: jsonObject(event.metadata_json), created_at: event.created_at,
      })), evidence,
    };
  }

  getSoleActiveTask() {
    const active = this.db.query<{ id: string }, [string]>(
      "SELECT id FROM tasks WHERE project_id = ? AND lifecycle_state NOT IN ('completed', 'handoff') ORDER BY updated_at DESC LIMIT 2",
    ).all(this.projectId);
    if (active.length !== 1) return undefined;
    return this.getTask(active[0].id);
  }
  prepare(input: {
    task: string; request_id: string; task_id?: string; resume_session?: boolean; route: unknown; blockers: unknown[]; host_id?: string; session_id?: string;
    idempotency_input?: unknown;
    ai_memory_status?: "ready" | "incomplete" | "unavailable"; ai_memory_refs?: string[]; ai_memory_error_code?: string;
    graphify_status?: "ready" | "incomplete" | "unavailable"; graphify_map_status?: "current" | "stale" | "missing" | "unsafe";
    graphify_refs?: string[]; graphify_error_code?: string;
  }) {
    const safeTask = redactSensitiveText(input.task);
    const replayInput = input.idempotency_input ?? input;
    const transaction = this.db.transaction(() => {
      const existingReplay = this.replay<Record<string, unknown>>(this.projectId, input.request_id, replayInput);
      if (existingReplay) return existingReplay;
      const selectedTaskId = input.task_id ?? (input.resume_session
        ? this.findTaskForSession(input.host_id, input.session_id, true)
        : undefined);
      if (selectedTaskId) {
        const existing = this.ensureTask(selectedTaskId);
        const memoryStatus = input.ai_memory_status ?? "unavailable";
        const graphifyStatus = input.graphify_status ?? "unavailable";
        const graphifyMapStatus = input.graphify_map_status ?? "missing";
        const graphifyRefs = redactTextArray(input.graphify_refs ?? []).slice(0, 10);
        this.db.query("UPDATE tasks SET ai_memory_status = ?, memory_error_code = ?, graphify_status = ?, graphify_map_status = ?, graphify_refs_json = ?, graphify_error_code = ?, route_json = ?, blockers_json = ?, updated_at = ? WHERE id = ? AND project_id = ?")
          .run(memoryStatus, input.ai_memory_error_code ?? null, graphifyStatus, graphifyMapStatus, JSON.stringify(graphifyRefs), input.graphify_error_code ?? null, JSON.stringify(input.route), JSON.stringify(input.blockers), now(), existing.id, this.projectId);
        this.insertEvent({
          task_id: existing.id, event_type: "memory_context_loaded",
          summary: memoryStatus === "ready" ? "Loaded bounded ai-memory context; verify it against current source." : `ai-memory context is ${memoryStatus}.`,
          outcome: memoryStatus === "ready" ? "success" : memoryStatus === "incomplete" ? "incomplete" : "blocked",
          evidence_refs: input.ai_memory_refs ?? [], actor: "tyrant", host_id: input.host_id, session_id: input.session_id,
        });
        this.insertGraphifyContextEvent(existing.id, graphifyStatus, graphifyMapStatus, graphifyRefs, input.graphify_error_code, input.host_id, input.session_id);
        const result = this.getTask(existing.id);
        this.saveReplay(this.projectId, input.request_id, replayInput, result);
        return result;
      }

      const taskCount = this.db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?",
      ).get(this.projectId)?.count ?? 0;
      if (taskCount >= MAX_TASKS_PER_PROJECT) {
        throw new TyrantError("STATE_QUOTA_REACHED", "This project reached Tyrant's task limit; archive or remove old project state before creating another task.");
      }

      const id = randomUUID();
      const timestamp = now();
      const graphifyStatus = input.graphify_status ?? "unavailable";
      const graphifyMapStatus = input.graphify_map_status ?? "missing";
      const graphifyRefs = redactTextArray(input.graphify_refs ?? []).slice(0, 10);
      const initialState: TaskLifecycleState = input.blockers.length > 0 ? "blocked" : "planned";
      const initialStatus: TaskStatus = initialState === "blocked" ? "blocked" : "active";
      const initialNext = initialState === "blocked"
        ? "Resolve the required project-context providers before repository work."
        : "Begin the planned task through the selected skill route.";
      const blockerSummary = input.blockers.length > 0 ? "Required project context is not ready." : null;
      this.db.query(
        "INSERT INTO tasks(id,project_id,task,status,lifecycle_state,ai_memory_status,graphify_status,graphify_map_status,graphify_refs_json,graphify_error_code,route_json,blockers_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(id, this.projectId, safeTask, initialStatus, initialState, input.ai_memory_status ?? "unavailable", graphifyStatus, graphifyMapStatus, JSON.stringify(graphifyRefs), input.graphify_error_code ?? null, JSON.stringify(input.route), JSON.stringify(input.blockers), timestamp, timestamp);
      this.db.query(
        "INSERT INTO checkpoints(id,task_id,phase,last_reliable_step,next_action,blocker,changed_files_json,evidence_refs_json,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(randomUUID(), id, "preflight", "Recorded task intent and selected the required workflow.", initialNext,
        blockerSummary, "[]", "[]", JSON.stringify({
          intent: safeTask, constraints: [], non_goals: [], plan_progress: [], checks: [],
          ai_memory_refs: redactTextArray(input.ai_memory_refs ?? []).slice(0, 10), graphify_refs: graphifyRefs, actor: null, host_id: input.host_id ?? null, session_id: input.session_id ?? null,
        }), timestamp);
      this.insertEvent({
        task_id: id, event_type: "task_created", summary: "Created a project-scoped Tyrant task.",
        outcome: initialState === "blocked" ? "blocked" : "success", actor: "tyrant", host_id: input.host_id, session_id: input.session_id,
        new_state: initialState,
      });
      this.insertEvent({
        task_id: id, event_type: "route_selected", summary: "Selected the Matt Pocock workflow and required project-context providers.",
        skill_id: "matt-pocock-main-flow", outcome: "success", actor: "tyrant", host_id: input.host_id, session_id: input.session_id,
      });
      this.insertEvent({
        task_id: id, event_type: "checkpoint_saved", summary: "Saved the initial preflight checkpoint.", next_action: initialNext,
        outcome: initialState === "blocked" ? "blocked" : "success", actor: "tyrant", host_id: input.host_id, session_id: input.session_id,
      });
      const memoryStatus = input.ai_memory_status ?? "unavailable";
      this.insertEvent({
        task_id: id, event_type: "memory_context_loaded",
        summary: memoryStatus === "ready" ? "Loaded bounded ai-memory context; verify it against current source." : `ai-memory context is ${memoryStatus}.`,
        outcome: memoryStatus === "ready" ? "success" : memoryStatus === "incomplete" ? "incomplete" : "blocked",
        evidence_refs: input.ai_memory_refs ?? [], actor: "tyrant", host_id: input.host_id, session_id: input.session_id,
      });
      this.insertGraphifyContextEvent(id, graphifyStatus, graphifyMapStatus, graphifyRefs, input.graphify_error_code, input.host_id, input.session_id);
      const result = this.getTask(id);
      this.saveReplay(this.projectId, input.request_id, replayInput, result);
      return result;
    });
    return transaction();
  }
  transition(input: {
    task_id: string; request_id: string; next_state: Exclude<TaskLifecycleState, "new" | "completed">; reason: string;
    actor?: string; host_id?: string; session_id?: string;
  }) {
    const transaction = this.db.transaction(() => {
      const current = this.ensureTask(input.task_id);
      const replayed = this.replay<Record<string, unknown>>(input.task_id, input.request_id, input);
      if (replayed) return replayed;
      const allowed: Record<TaskLifecycleState, TaskLifecycleState[]> = {
        new: ["planned", "blocked"], planned: ["in_progress", "blocked"],
        in_progress: ["verifying", "blocked", "handoff"], verifying: ["in_progress", "blocked", "handoff"],
        blocked: ["planned", "in_progress", "handoff"], handoff: ["in_progress", "blocked"], completed: [],
      };
      if (!allowed[current.lifecycle_state]?.includes(input.next_state)) {
        throw new TyrantError("INVALID_STATE", `Cannot transition task from ${current.lifecycle_state} to ${input.next_state}.`);
      }
      const timestamp = now();
      const status: TaskStatus = input.next_state === "blocked" ? "blocked" : input.next_state === "handoff" ? "handoff" : "active";
      this.db.query(
        "UPDATE tasks SET lifecycle_state = ?, status = ?, updated_at = ?, finish_summary = NULL, next_action = NULL, finished_at = NULL WHERE id = ? AND project_id = ?",
      ).run(input.next_state, status, timestamp, input.task_id, this.projectId);
      const event = this.insertEvent({
        task_id: input.task_id, event_type: "task_state_changed", summary: input.reason, outcome: "success",
        actor: input.actor, host_id: input.host_id, session_id: input.session_id,
        previous_state: current.lifecycle_state, new_state: input.next_state,
      });
      const state = this.getTask(input.task_id);
      const result = { schema_version: 1, task: state.task, event };
      this.saveReplay(input.task_id, input.request_id, input, result);
      return result;
    });
    return transaction();
  }

  checkpoint(input: {
    task_id: string; request_id: string; phase: string; last_reliable_step: string; next_action: string;
    blocker?: string; changed_files: string[]; evidence_refs: string[]; intent?: string; constraints: string[];
    non_goals: string[]; plan_progress: string[]; checks: Array<{ check_id: string; status: string; summary: string; evidence_ref?: string }>;
    ai_memory_refs: string[]; graphify_refs: string[]; actor?: string; host_id?: string; session_id?: string;
  }) {
    const safe = {
      ...input, phase: redactSensitiveText(input.phase), last_reliable_step: redactSensitiveText(input.last_reliable_step),
      next_action: redactSensitiveText(input.next_action), blocker: input.blocker === undefined ? undefined : redactSensitiveText(input.blocker),
      changed_files: redactTextArray(input.changed_files), evidence_refs: redactTextArray(input.evidence_refs),
      intent: input.intent === undefined ? undefined : redactSensitiveText(input.intent),
      constraints: redactTextArray(input.constraints), non_goals: redactTextArray(input.non_goals), plan_progress: redactTextArray(input.plan_progress),
      checks: input.checks.map((check) => ({
        ...check, check_id: redactSensitiveText(check.check_id), summary: redactSensitiveText(check.summary),
        evidence_ref: check.evidence_ref === undefined ? undefined : redactSensitiveText(check.evidence_ref),
      })),
      ai_memory_refs: redactTextArray(input.ai_memory_refs), graphify_refs: redactTextArray(input.graphify_refs),
      actor: input.actor === undefined ? undefined : redactSensitiveText(input.actor),
      host_id: input.host_id === undefined ? undefined : redactSensitiveText(input.host_id),
      session_id: input.session_id === undefined ? undefined : redactSensitiveText(input.session_id),
    };
    const transaction = this.db.transaction(() => {
      this.ensureTask(input.task_id);
      const replayed = this.replay<Record<string, unknown>>(input.task_id, input.request_id, input);
      if (replayed) return replayed;
      const checkpoint = {
        id: randomUUID(), phase: safe.phase, last_reliable_step: safe.last_reliable_step,
        next_action: safe.next_action, blocker: safe.blocker ?? null,
        changed_files: safe.changed_files, evidence_refs: safe.evidence_refs, created_at: now(),
        intent: safe.intent ?? null, constraints: safe.constraints, non_goals: safe.non_goals,
        plan_progress: safe.plan_progress, checks: safe.checks, ai_memory_refs: safe.ai_memory_refs,
        graphify_refs: safe.graphify_refs, actor: safe.actor ?? null, host_id: safe.host_id ?? null, session_id: safe.session_id ?? null,
      };
      const details = {
        intent: checkpoint.intent, constraints: checkpoint.constraints, non_goals: checkpoint.non_goals,
        plan_progress: checkpoint.plan_progress, checks: checkpoint.checks, ai_memory_refs: checkpoint.ai_memory_refs,
        graphify_refs: checkpoint.graphify_refs, actor: checkpoint.actor, host_id: checkpoint.host_id, session_id: checkpoint.session_id,
      };
      this.db.query(
        "INSERT INTO checkpoints(id,task_id,phase,last_reliable_step,next_action,blocker,changed_files_json,evidence_refs_json,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(checkpoint.id, input.task_id, checkpoint.phase, checkpoint.last_reliable_step, checkpoint.next_action,
        checkpoint.blocker, JSON.stringify(checkpoint.changed_files), JSON.stringify(checkpoint.evidence_refs), JSON.stringify(details), checkpoint.created_at);
      this.db.query("UPDATE tasks SET updated_at = ?, next_action = ? WHERE id = ? AND project_id = ?")
        .run(checkpoint.created_at, checkpoint.next_action, input.task_id, this.projectId);
      const event = this.insertEvent({
        task_id: input.task_id, event_type: "checkpoint_saved", summary: `Saved ${checkpoint.phase} checkpoint.`,
        next_action: checkpoint.next_action, outcome: checkpoint.blocker ? "blocked" : "success",
        evidence_refs: checkpoint.evidence_refs, artifact_refs: checkpoint.changed_files,
        actor: checkpoint.actor ?? undefined, host_id: checkpoint.host_id ?? undefined, session_id: checkpoint.session_id ?? undefined,
      });
      const result = { schema_version: 1, checkpoint, event };
      this.saveReplay(input.task_id, input.request_id, input, result);
      return result;
    });
    return transaction();
  }
  recordEvent(input: {
    task_id: string; request_id: string; event_type: string; summary: string; skill_id?: string; outcome?: string;
    evidence_refs: string[]; artifact_refs: string[]; actor?: string; host_id?: string; session_id?: string;
    previous_state?: TaskLifecycleState; new_state?: TaskLifecycleState;
  }) {
    const transaction = this.db.transaction(() => {
      this.ensureTask(input.task_id);
      const replayed = this.replay<Record<string, unknown>>(input.task_id, input.request_id, input);
      if (replayed) return replayed;
      const event = this.insertEvent(input);
      this.db.query("UPDATE tasks SET updated_at = ? WHERE id = ? AND project_id = ?").run(event.created_at, input.task_id, this.projectId);
      const result = { schema_version: 1, event };
      this.saveReplay(input.task_id, input.request_id, input, result);
      return result;
    });
    return transaction();
  }
  recordEvidence(input: {
    task_id: string; request_id: string; check_id: string; status: string; summary: string; evidence_ref?: string;
    actor?: string; host_id?: string; session_id?: string;
  }) {
    const safe = {
      ...input, check_id: redactSensitiveText(input.check_id), summary: redactSensitiveText(input.summary),
      evidence_ref: input.evidence_ref === undefined ? undefined : redactSensitiveText(input.evidence_ref),
    };
    const transaction = this.db.transaction(() => {
      this.ensureTask(input.task_id);
      const replayed = this.replay<Record<string, unknown>>(input.task_id, input.request_id, input);
      if (replayed) return replayed;
      const evidence = {
        id: randomUUID(), task_id: safe.task_id, check_id: safe.check_id, status: safe.status,
        summary: safe.summary, evidence_ref: safe.evidence_ref ?? null, created_at: now(),
      };
      this.db.query(
        "INSERT INTO evidence(id,task_id,check_id,status,summary,evidence_ref,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(evidence.id, safe.task_id, safe.check_id, safe.status, safe.summary, safe.evidence_ref ?? null, evidence.created_at);
      const event = this.insertEvent({
        task_id: input.task_id, event_type: "evidence_recorded", summary: safe.summary,
        outcome: safe.status === "pass" ? "success"
          : safe.status === "fail" ? "failed"
            : safe.status === "not_run" || safe.status === "needs_validation" ? "incomplete"
              : safe.status,
        evidence_refs: safe.evidence_ref ? [safe.evidence_ref] : [], actor: input.actor, host_id: input.host_id, session_id: input.session_id,
      });
      this.db.query("UPDATE tasks SET updated_at = ? WHERE id = ? AND project_id = ?").run(evidence.created_at, input.task_id, this.projectId);
      const result = { schema_version: 1, evidence, event };
      this.saveReplay(input.task_id, input.request_id, input, result);
      return result;
    });
    return transaction();
  }
  recordMemorySync(input: {
    task_id: string; status: "synced" | "incomplete" | "unavailable" | "uncertain";
    handoff_status: "created" | "existing" | "uncertain" | "not_required"; page_ref?: string; handoff_id?: string;
    error_code?: string; error_step?: string; actor?: string; host_id?: string; session_id?: string;
  }) {
    const transaction = this.db.transaction(() => {
      const current = this.ensureTask(input.task_id);
      const pageRef = input.page_ref ? redactSensitiveText(input.page_ref) : null;
      const handoffIdValue = input.handoff_id ? redactSensitiveText(input.handoff_id) : null;
      const errorCode = input.error_code ? (/^[a-z0-9_-]{1,80}$/i.test(input.error_code) ? input.error_code.toLowerCase() : "provider_error") : null;
      const errorStep = input.error_step ? (/^[a-z][a-z0-9_]{0,63}$/i.test(input.error_step) ? input.error_step.toLowerCase() : null) : null;
      const changed = current.memory_sync_status !== input.status
        || current.memory_handoff_status !== input.handoff_status
        || current.memory_page_ref !== pageRef
        || current.memory_handoff_id !== handoffIdValue
        || current.memory_error_code !== errorCode
        || current.memory_error_step !== errorStep;
      if (!changed) return this.getTask(input.task_id);
      const timestamp = now();
      this.db.query(
        "UPDATE tasks SET memory_sync_status = ?, memory_handoff_status = ?, memory_page_ref = ?, memory_handoff_id = ?, memory_error_code = ?, memory_error_step = ?, updated_at = ? WHERE id = ? AND project_id = ?",
      ).run(input.status, input.handoff_status, pageRef, handoffIdValue, errorCode, errorStep, timestamp, input.task_id, this.projectId);
      this.insertEvent({
        task_id: input.task_id,
        event_type: input.status === "synced" ? "memory_sync_succeeded" : "memory_sync_failed",
        summary: input.status === "synced" ? "Synchronized the concise task outcome to ai-memory." : "ai-memory outcome sync is " + input.status + (errorCode ? " (" + errorCode + ")" : "") + (errorStep ? " at " + errorStep : "") + ".",
        outcome: input.status === "synced" ? "success" : input.status === "uncertain" ? "uncertain" : "incomplete",
        evidence_refs: pageRef ? [pageRef] : [], artifact_refs: handoffIdValue ? [`ai-memory:handoff:${handoffIdValue}`] : [],
        actor: input.actor ?? "tyrant", host_id: input.host_id, session_id: input.session_id,
      });
      return this.getTask(input.task_id);
    });
    return transaction();
  }
  finish(input: {
    task_id: string; request_id: string; status: "completed" | "blocked" | "handoff"; summary: string; next_action?: string;
    actor?: string; host_id?: string; session_id?: string;
  }) {
    const safe = {
      ...input, summary: redactSensitiveText(input.summary),
      next_action: input.next_action === undefined ? undefined : redactSensitiveText(input.next_action),
    };
    const transaction = this.db.transaction(() => {
      const current = this.ensureTask(input.task_id);
      const replayed = this.replay<Record<string, unknown>>(input.task_id, input.request_id, input);
      if (replayed) return replayed;
      if (current.lifecycle_state === "completed") {
        throw new TyrantError("INVALID_STATE", "Completed tasks are terminal and cannot be changed.");
      }
      if (safe.status === "completed" && ["blocked", "handoff"].includes(current.lifecycle_state)) {
        throw new TyrantError("INVALID_STATE", "Resume the blocked or handed-off task before completing it.");
      }
      const timestamp = now();
      const lifecycleState: TaskLifecycleState = safe.status === "completed" ? "completed" : safe.status;
      this.db.query(
        "UPDATE tasks SET status = ?, lifecycle_state = ?, updated_at = ?, finish_summary = ?, next_action = ?, finished_at = ? WHERE id = ? AND project_id = ?",
      ).run(safe.status, lifecycleState, timestamp, safe.summary, safe.next_action ?? null, timestamp, safe.task_id, this.projectId);
      const eventType = safe.status === "completed" ? "task_completed" : safe.status === "blocked" ? "task_blocked" : "handoff_created";
      this.insertEvent({
        task_id: safe.task_id, event_type: eventType, summary: safe.summary, outcome: safe.status,
        next_action: safe.next_action, actor: input.actor, host_id: input.host_id, session_id: input.session_id,
        previous_state: current.lifecycle_state, new_state: lifecycleState,
      });
      const state = this.getTask(safe.task_id);
      const result = {
        schema_version: 1, task: state.task, task_id: safe.task_id, status: safe.status,
        lifecycle_state: lifecycleState, summary: safe.summary, next_action: safe.next_action ?? null, updated_at: timestamp,
      };
      this.saveReplay(input.task_id, input.request_id, input, result);
      return result;
    });
    return transaction();
  }
}

export function withTyrantStore<T>(
  operation: (store: TyrantStore) => T,
  options: { projectRoot?: string; stateDirectory?: string } = {},
): T {
  const store = new TyrantStore(options);
  try {
    return operation(store);
  } finally {
    store.close();
  }
}














