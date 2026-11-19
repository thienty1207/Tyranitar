import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HostHookInput } from "../src/adapters/auto-preflight";

const adapterApi = await import("../src/adapters/auto-preflight").catch(() => undefined);
const localToolsApi = await import("../src/adapters/local-tools").catch(() => undefined);
const commandHookApi = await import("../src/adapters/command-hook").catch(() => undefined);
const dshAdapterApi = await import("../src/adapters/dsh").catch(() => undefined);
const openCodeAdapterApi = await import("../src/adapters/opencode").catch(() => undefined);

function preparedFixture(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    task: { id: "task-auto-1", lifecycle_state: "planned" },
    route: {
      status: "ready",
      core_workflow: { workflow_id: "matt-pocock-main-flow", source_skill_id: "ask-matt", policy_applied: true },
      specialists: [{ skill_id: "matt-tdd", required: true, reason: "Code changes use test-first workflow." }],
      provider_gaps: [],
      code_change_gate: { status: "ready", provider_ids: [] },
    },
    memory_context: { status: "ready", context: "[historical_untrusted] Keep the API stable.", references: ["ai-memory:page:project"] },
    graphify_context: { status: "ready", mapStatus: "current", context: "Derived code map; verify against source.", references: ["graphify:graph:current"] },
    next_action: "Apply the selected route before code changes.",
    ...overrides,
  };
}

test("automatic host preflight returns Matt, Memory, Graphify, and selected skill context before model work", async () => {
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!adapterApi) return;

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const prepared = preparedFixture();
  prepared.checkpoint = {
    phase: "verification", last_reliable_step: "Built the API handler", next_action: "Run route checks",
    blocker: null, changed_files: ["src/api/list.ts"], evidence_refs: ["test://api-list"],
  };
  prepared.resume_context = {
    source_task_id: "task-prior-1", source_task_summary: "Previous API work", handoff_id: "handoff-1",
    checkpoint: {
      phase: "implementation", last_reliable_step: "Added the list route", next_action: "Add pagination tests",
      blocker: "Waiting for database seed data", changed_files: ["src/routes/list.ts"], evidence_refs: ["test://list-route"],
    },
  };
  const result = await adapterApi.prepareAutomaticHostContext(
    { host_id: "codex", cwd: "D:/project", session_id: "session-1", turn_id: "turn-1", prompt: "Implement the list endpoint" },
    async (name, args) => {
      calls.push({ name, args });
      return name === "tyrant_prepare_task" ? prepared : {};
    },
    async ({ skill_id, source_skill_id }) => ({
      status: "loaded",
      skill_id,
      source_skill_id,
      method: "host_skill_file",
      source_ref: `skill-file://${source_skill_id}`,
      content: `Full instructions for ${source_skill_id}.`,
    }),
  );

  expect(calls).toHaveLength(1);
  expect(calls[0].name).toBe("tyrant_prepare_task");
  expect(calls[0].args).toMatchObject({ host_id: "codex", session_id: "session-1", resume_session: true });
  expect(result.task_id).toBe("task-auto-1");
  expect(result.context).toContain("Matt Pocock main flow");
  expect(result.context).toContain("[historical_untrusted] Keep the API stable.");
  expect(result.context).toContain("Derived code map; verify against source.");
  expect(result.context).toContain("Prior task handoff and local checkpoint");
  expect(result.context).toContain("Latest Tyrant checkpoint");
  expect(result.context).toContain("Last reliable step: Built the API handler.");
  expect(result.context).toContain("Last reliable step: Added the list route.");
  expect(result.context).toContain("Next action: Add pagination tests.");
  expect(result.context).toContain("src/routes/list.ts");
  expect(result.context).toContain("Tyrant built-in Matt Pocock-inspired orchestration policy");
  expect(result.context).toContain("Full instructions for tdd.");
  expect(result.skill_loads.map((skill: { source_skill_id: string }) => skill.source_skill_id)).toEqual(["tyrant-matt-orchestrator", "tdd"]);
  expect(result.skill_loads[0]).toMatchObject({ method: "tyrant_builtin_policy", status: "loaded" });
  expect(result.code_change_allowed).toBe(true);
});

test("native ask-matt is loaded only when the user explicitly requests its workflow", async () => {
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!adapterApi) return;
  const prepared = preparedFixture({
    route: {
      status: "ready",
      core_workflow: { workflow_id: "matt-pocock-main-flow", source_skill_id: "tyrant-matt-orchestrator", policy_applied: true },
      specialists: [{ skill_id: "matt-ask-matt", required: true, phase: "explicit_manual_request", reason: "User requested native ask-matt." }],
      provider_gaps: [],
      code_change_gate: { status: "ready", provider_ids: [] },
    },
  });
  const loaded: string[] = [];
  const result = await adapterApi.prepareAutomaticHostContext(
    { host_id: "dsh", cwd: "D:/project", session_id: "session-ask-matt", prompt: "Use ask-matt to choose a workflow" },
    async () => prepared,
    async ({ skill_id, source_skill_id }) => {
      loaded.push(source_skill_id);
      return { status: "loaded", skill_id, source_skill_id, method: "host_skill_file", content: "Manual ask-matt instructions." };
    },
  );
  expect(loaded).toEqual(["ask-matt"]);
  expect(result.loaded_skills.map((skill: { skill_id: string }) => skill.skill_id)).toContain("matt-ask-matt");
  expect(result.context).toContain("Manual ask-matt instructions.");
  expect(result.context).toContain("Tyrant automatically applied its built-in Matt Pocock-inspired orchestration policy");
});

test("preflight automatically injects routed Taste and security-audit bodies before model work", async () => {
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!adapterApi) return;
  for (const specialist of ["design-taste-frontend", "security-audit"]) {
    const prepared = preparedFixture({
      memory_context: { status: "ready", context: "M".repeat(7_000), references: [] },
      graphify_context: { status: "ready", mapStatus: "current", context: "G".repeat(7_000), references: [] },
      route: {
        status: "ready",
        core_workflow: { workflow_id: "matt-pocock-main-flow", source_skill_id: "ask-matt", policy_applied: true },
        specialists: [{ skill_id: specialist, required: true, reason: `Routed ${specialist} for this task.` }],
        provider_gaps: [],
        code_change_gate: { status: "ready", provider_ids: [] },
      },
    });
    const loaded: string[] = [];
    const result = await adapterApi.prepareAutomaticHostContext(
      { host_id: "dsh", cwd: "D:/project", session_id: `specialist-${specialist}`, prompt: specialist === "design-taste-frontend" ? "Build the frontend" : "Review security" },
      async (name) => name === "tyrant_prepare_task" ? prepared : {},
      async (request) => {
        loaded.push(request.source_skill_id);
        const body = request.source_skill_id === "ask-matt"
          ? "Pinned Matt body."
          : `${specialist} complete instructions. ${"S".repeat(specialist === "design-taste-frontend" ? 31_000 : 22_000)} END-${specialist}`;
        return { status: "loaded", skill_id: request.skill_id, source_skill_id: request.source_skill_id, method: "host_skill_file", content: body };
      },
    );
    expect(result.code_change_allowed).toBe(true);
    expect(loaded).toEqual([specialist]);
    expect(result.context).toContain(`END-${specialist}`);
    expect(result.context.length).toBeLessThanOrEqual(52_000);
    expect(result.loaded_skills.map((skill: { skill_id: string }) => skill.skill_id)).toContain(specialist);
  }
});

test("optional security guidance does not push required frontend context over the host limit", async () => {
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!adapterApi) return;

  const prepared = preparedFixture({
    route: {
      status: "ready",
      core_workflow: { workflow_id: "matt-pocock-main-flow", source_skill_id: "tyrant-matt-orchestrator", policy_applied: true },
      specialists: [
        { skill_id: "matt-tdd", required: true, phase: "before_implementation", reason: "Use test-first implementation." },
        { skill_id: "design-taste-frontend", required: true, phase: "frontend_implementation", reason: "Taste is required for frontend work." },
        { skill_id: "security-audit", required: false, phase: "security_guidance", reason: "Optional scoped guidance." },
      ],
      provider_gaps: [],
      code_change_gate: { status: "ready", provider_ids: [] },
    },
  });
  const loaded: string[] = [];
  const result = await adapterApi.prepareAutomaticHostContext(
    { host_id: "dsh", cwd: "D:/project", session_id: "session-optional-security", prompt: "Implement a login screen and API." },
    async (name) => name === "tyrant_prepare_task" ? prepared : {},
    async ({ skill_id, source_skill_id }) => {
      loaded.push(skill_id);
      const body = source_skill_id === "tdd"
        ? `TDD instructions. ${"T".repeat(1_000)}`
        : source_skill_id === "design-taste-frontend"
          ? `Taste instructions. ${"D".repeat(31_000)}`
          : `Security audit instructions. ${"S".repeat(25_000)}`;
      return { status: "loaded", skill_id, source_skill_id, method: "host_skill_file", content: body };
    },
  );

  expect(loaded).toEqual(["matt-tdd", "design-taste-frontend"]);
  expect(result.code_change_allowed).toBe(true);
  expect(result.host_context_error).toBeUndefined();
  expect(result.context).toContain("security-audit: not_loaded; required=false; phase=security_guidance");
  expect(result.context).not.toContain('<tyrant-skill id="security-audit"');
  expect(result.context.length).toBeLessThanOrEqual(52_000);
});

test("preflight keeps post-implementation skill bodies out of the initial host context", async () => {
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!adapterApi) return;
  const prepared = preparedFixture({
    route: {
      status: "ready",
      core_workflow: { workflow_id: "matt-pocock-main-flow", source_skill_id: "ask-matt", policy_applied: true },
      specialists: [{ skill_id: "matt-code-review", required: false, phase: "post_implementation", reason: "Review after code changes." }],
      provider_gaps: [],
      code_change_gate: { status: "ready", provider_ids: [] },
    },
  });
  const loadedSources: string[] = [];
  const result = await adapterApi.prepareAutomaticHostContext(
    { host_id: "codex", cwd: "D:/project", session_id: "session-phase-skill", prompt: "Implement a list endpoint" },
    async () => prepared,
    async ({ skill_id, source_skill_id }) => {
      loadedSources.push(source_skill_id);
      return {
        status: "loaded", skill_id, source_skill_id, method: "host_skill_file", content: `Instructions for ${source_skill_id}.`,
      };
    },
  );

  expect(loadedSources).toEqual([]);
  expect(result.context).toContain("matt-code-review: not_loaded; required=false; phase=post_implementation");
  expect(result.context).not.toContain('<tyrant-skill id="matt-code-review"');
  expect(result.context).toContain("defer post-implementation instructions until their route phase");
  expect(result.loaded_skills.map((skill: { skill_id: string }) => skill.skill_id)).toEqual(["matt-pocock-main-flow"]);
});

test("automatic preflight keeps required provider failures visible and closes the code gate", async () => {
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!adapterApi) return;

  const prepared = preparedFixture({
    route: {
      status: "blocked",
      core_workflow: { workflow_id: "matt-pocock-main-flow", source_skill_id: "ask-matt", policy_applied: true },
      specialists: [],
      provider_gaps: [{ provider: "graphify", status: "blocked", message: "Graphify map is missing." }],
      code_change_gate: { status: "blocked", provider_ids: ["graphify"] },
    },
    graphify_context: { status: "unavailable", mapStatus: "missing", context: "", errorCode: "command_missing", references: [] },
  });
  const result = await adapterApi.prepareAutomaticHostContext(
    { host_id: "codex", cwd: "D:/project", session_id: "session-2", prompt: "Fix the API" },
    async () => prepared,
    async ({ skill_id, source_skill_id }) => ({
      status: "loaded", skill_id, source_skill_id, method: "host_skill_file", source_ref: `skill-file://${source_skill_id}`, content: "Matt workflow.",
    }),
  );

  expect(result.code_change_allowed).toBe(false);
  expect(result.context).toContain("Graphify map is missing.");
  expect(result.context).toContain("Do not change code");
});

test("automatic host preflight records a resume transition after a provider-only block clears", async () => {
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!adapterApi) return;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const providerBlockedTask = preparedFixture({
    task: { id: "task-provider-blocked", lifecycle_state: "blocked" },
    checkpoint: { phase: "preflight", blocker: "Required project context is not ready." },
    next_action: "Required providers are ready; record an explicit transition from blocked to planned or in_progress before code changes.",
  });
  const result = await adapterApi.prepareAutomaticHostContext(
    { host_id: "codex", cwd: "D:/project", session_id: "session-provider-recovery", turn_id: "turn-provider-recovery", prompt: "Retry the project task" },
    async (name, args) => {
      calls.push({ name, args });
      if (name === "tyrant_prepare_task") return providerBlockedTask;
      if (name === "tyrant_transition_task") return { task: { ...providerBlockedTask.task, lifecycle_state: "planned" } };
      return {};
    },
    async ({ skill_id, source_skill_id }) => ({
      status: "loaded", skill_id, source_skill_id, method: "host_skill_file", content: `Instructions for ${source_skill_id}.`,
    }),
  );

  expect(calls.map((call) => call.name)).toEqual(["tyrant_prepare_task", "tyrant_transition_task"]);
  expect(calls[1].args).toMatchObject({
    task_id: "task-provider-blocked", next_state: "planned", actor: "tyrant-host-adapter",
    host_id: "codex", session_id: "session-provider-recovery",
  });
  expect(calls[1].args.reason).toContain("provider-only block");
  expect(result.code_change_allowed).toBe(true);
  expect(result.task_lifecycle_transition).toBe("resumed");
  expect(result.context).toContain("recorded the blocked-to-planned transition");
  expect(result.context).toContain("Prior blocker (cleared by this preflight): Required project context is not ready.");
});

test("automatic host preflight does not clear a blocked task with a non-provider blocker", async () => {
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!adapterApi) return;
  const calls: string[] = [];
  const blockedTask = preparedFixture({
    task: { id: "task-test-blocked", lifecycle_state: "blocked" },
    checkpoint: { phase: "verification", blocker: "A required test failed." },
  });
  const result = await adapterApi.prepareAutomaticHostContext(
    { host_id: "codex", cwd: "D:/project", session_id: "session-test-blocker", turn_id: "turn-test-blocker", prompt: "Continue the task" },
    async (name) => { calls.push(name); return blockedTask; },
    async ({ skill_id, source_skill_id }) => ({
      status: "loaded", skill_id, source_skill_id, method: "host_skill_file", content: `Instructions for ${source_skill_id}.`,
    }),
  );

  expect(calls).toEqual(["tyrant_prepare_task"]);
  expect(result.code_change_allowed).toBe(false);
  expect(result.task_lifecycle_blocked).toBe(true);
  expect(adapterApi.automaticPreflightBlockReason(result)).toContain("task remains blocked");
  expect(result.context).toContain("A required test failed.");
});

test("automatic host preflight respects a later blocked outcome after the original provider failure", async () => {
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!adapterApi) return;
  const calls: string[] = [];
  const blockedTask = preparedFixture({
    task: { id: "task-later-block", lifecycle_state: "blocked", finish_summary: "The integration test failed." },
    checkpoint: { phase: "preflight", blocker: "Required project context is not ready." },
    events: [{ event_type: "task_blocked", new_state: "blocked", summary: "The integration test failed." }],
  });
  const result = await adapterApi.prepareAutomaticHostContext(
    { host_id: "codex", cwd: "D:/project", session_id: "session-later-block", turn_id: "turn-later-block", prompt: "Continue the task" },
    async (name) => { calls.push(name); return blockedTask; },
    async ({ skill_id, source_skill_id }) => ({
      status: "loaded", skill_id, source_skill_id, method: "host_skill_file", content: `Instructions for ${source_skill_id}.`,
    }),
  );

  expect(calls).toEqual(["tyrant_prepare_task"]);
  expect(result.code_change_allowed).toBe(false);
  expect(result.task_lifecycle_blocked).toBe(true);
});

test("automatic host preflight honors a durable block event outside the bounded event window", async () => {
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!adapterApi) return;
  const calls: string[] = [];
  const blockedTask = preparedFixture({
    task: { id: "task-aged-block", lifecycle_state: "blocked", finish_summary: null },
    checkpoint: { phase: "preflight", blocker: "Required project context is not ready." },
    latest_block_event: { event_type: "task_state_changed", new_state: "blocked", summary: "A required test failed." },
    events: Array.from({ length: 20 }, (_, index) => ({ event_type: "graphify_context_loaded", summary: `Refresh ${index}` })),
  });
  const result = await adapterApi.prepareAutomaticHostContext(
    { host_id: "codex", cwd: "D:/project", session_id: "session-aged-block", turn_id: "turn-aged-block", prompt: "Continue the task" },
    async (name) => {
      calls.push(name);
      return name === "tyrant_prepare_task" ? blockedTask : { task: { id: "task-aged-block", lifecycle_state: "planned" } };
    },
    async ({ skill_id, source_skill_id }) => ({
      status: "loaded", skill_id, source_skill_id, method: "host_skill_file", content: `Instructions for ${source_skill_id}.`,
    }),
  );

  expect(calls).toEqual(["tyrant_prepare_task"]);
  expect(result.code_change_allowed).toBe(false);
  expect(result.task_lifecycle_blocked).toBe(true);
  expect(result.context).toContain("A required test failed.");
});

test("required native skill gaps remain visible and cannot be logged as loaded", async () => {
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!adapterApi) return;

  const result = await adapterApi.prepareAutomaticHostContext(
    { host_id: "dsh", cwd: "D:/project", session_id: "session-3", prompt: "Build the frontend" },
    async () => preparedFixture({
      route: {
        status: "ready",
        core_workflow: { workflow_id: "matt-pocock-main-flow", source_skill_id: "ask-matt", policy_applied: true },
        specialists: [{ skill_id: "design-taste-frontend", required: true, reason: "Frontend work requires Taste." }],
        provider_gaps: [],
        code_change_gate: { status: "ready", provider_ids: [] },
      },
    }),
    async ({ skill_id, source_skill_id }) => skill_id === "matt-pocock-main-flow"
      ? { status: "loaded", skill_id, source_skill_id, method: "host_skill_registry", source_ref: "dsh-skill://ask-matt", content: "Matt workflow." }
      : { status: "missing", skill_id, source_skill_id, method: "host_skill_registry", reason: "skill_not_installed" },
  );

  expect(result.code_change_allowed).toBe(false);
  expect(result.required_skill_gaps).toContain("design-taste-frontend");
  expect(result.skill_loads.some((skill: { skill_id: string; status: string }) => skill.skill_id === "design-taste-frontend" && skill.status === "missing")).toBe(true);
  expect(result.context).toContain("design-taste-frontend");
});

test("skill load events are recorded only after the host confirms context injection", async () => {
  expect(adapterApi?.recordAutomaticSkillInjection).toBeDefined();
  if (!adapterApi) return;

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const result = {
    task_id: "task-auto-1",
    request_id: "auto-123",
    host_id: "codex",
    session_id: "session-1",
    skill_loads: [
      { skill_id: "matt-pocock-main-flow", source_skill_id: "ask-matt", status: "loaded", method: "host_skill_file" },
      { skill_id: "matt-tdd", source_skill_id: "tdd", status: "missing", method: "host_skill_file" },
    ],
    loaded_skills: [
      { skill_id: "matt-pocock-main-flow", source_skill_id: "ask-matt", status: "loaded" as const, method: "host_skill_file" as const, content: "Matt instructions." },
    ],
  };

  const recorded = await adapterApi.recordAutomaticSkillInjection({ ...result, context_injected: true }, async (name, args) => {
    calls.push({ name, args });
    return {};
  });

  expect(calls).toHaveLength(1);
  expect(calls[0].args).toMatchObject({
    event_type: "skill_loaded", skill_id: "matt-pocock-main-flow", outcome: "success",
    host_id: "codex", session_id: "session-1",
  });
  expect((calls[0].args.summary as string)).toContain("host_skill_file");
  expect((calls[0].args.evidence_refs as string[])[0]).toContain("host-hook://codex/");
  expect(recorded.recorded).toBe(1);
});

test("local adapter calls the real Tyrant MCP server through an in-process transport", async () => {
  expect(localToolsApi?.withInProcessTyrantTools).toBeDefined();
  if (!localToolsApi) return;

  const priorStateDir = process.env.TYRANT_STATE_DIR;
  const priorProjectRoot = process.env.TYRANT_PROJECT_ROOT;
  const sandbox = await mkdtemp(join(tmpdir(), "tyrant-host-adapter-"));
  const projectRoot = join(sandbox, "project");
  const stateDir = join(sandbox, "state");
  await Promise.all([mkdir(projectRoot), mkdir(stateDir)]);
  process.env.TYRANT_STATE_DIR = stateDir;
  try {
    await localToolsApi.withInProcessTyrantTools(projectRoot, async (callTool: (name: string, args: Record<string, unknown>) => Promise<any>) => {
      const catalog = await callTool("tyrant_list_skills", { schema_version: 1 });
      const payload = catalog.structuredContent ?? JSON.parse(catalog.content[0].text);
      expect(payload.skills.some((skill: { id: string }) => skill.id === "matt-pocock-main-flow")).toBe(true);
      expect(payload.skills.some((skill: { id: string }) => skill.id === "graphify")).toBe(true);
    });
  } finally {
    if (priorStateDir === undefined) delete process.env.TYRANT_STATE_DIR;
    else process.env.TYRANT_STATE_DIR = priorStateDir;
    if (priorProjectRoot === undefined) delete process.env.TYRANT_PROJECT_ROOT;
    else process.env.TYRANT_PROJECT_ROOT = priorProjectRoot;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("host request IDs are stable per host session and turn without exposing prompt text", () => {
  expect(adapterApi?.deriveHostRequestId).toBeDefined();
  if (!adapterApi) return;
  const input = { host_id: "codex", cwd: "D:/project", session_id: "session-a", turn_id: "turn-a", prompt: "secret API_KEY=sk-test-123" };
  const first = adapterApi.deriveHostRequestId(input);
  expect(adapterApi.deriveHostRequestId(input)).toBe(first);
  expect(first).not.toContain("secret");
  expect(adapterApi.deriveHostRequestId({ ...input, turn_id: "turn-b" })).not.toBe(first);
});

test("host request IDs use a fresh invocation key when the host omits a turn ID", () => {
  expect(adapterApi?.deriveHostRequestId).toBeDefined();
  if (!adapterApi) return;
  const input = { host_id: "claude-code", cwd: "D:/project", session_id: "session-no-turn", prompt: "Retry the provider check" };
  expect(adapterApi.deriveHostRequestId(input)).not.toBe(adapterApi.deriveHostRequestId(input));
});

test("automatic preflight redacts prompt secrets and bounds skill bodies from adapter loaders", async () => {
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!adapterApi) return;
  let taskSent = "";
  const result = await adapterApi.prepareAutomaticHostContext(
    { host_id: "codex", cwd: "D:/project", session_id: "session-redact", prompt: "Fix token=sk-test-secret" },
    async (_name, args) => {
      taskSent = String(args.task);
      return preparedFixture();
    },
    async ({ skill_id, source_skill_id }) => ({
      status: "loaded", skill_id, source_skill_id, method: "host_skill_file", content: "x".repeat(40_001),
    }),
  );

  expect(taskSent).not.toContain("sk-test-secret");
  expect(result.context).not.toContain("sk-test-secret");
  expect(result.code_change_allowed).toBe(false);
  expect(result.required_skill_gaps).toContain("matt-tdd");
  expect(result.required_skill_gaps).not.toContain("matt-pocock-main-flow");
  expect(result.context.length).toBeLessThanOrEqual(52_000);
});

test("Claude Code keeps required skill bodies inline while reducing provider text to its hook limit", async () => {
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!adapterApi) return;
  const result = await adapterApi.prepareAutomaticHostContext(
    { host_id: "claude-code", cwd: "D:/project", session_id: "claude-context-fit", prompt: "Implement this feature" },
    async () => preparedFixture({
      memory_context: { status: "ready", context: "M".repeat(7_000), references: [] },
      graphify_context: { status: "ready", mapStatus: "current", context: "G".repeat(7_000), references: [] },
    }),
    async ({ skill_id, source_skill_id }) => ({
      status: "loaded", skill_id, source_skill_id, method: "host_skill_file",
      content: `Complete instructions for ${source_skill_id}. ${"S".repeat(500)} END-${source_skill_id}`,
    }),
  );

  expect(result.code_change_allowed).toBe(true);
  expect(result.context.length).toBeLessThanOrEqual(9_000);
  expect(result.context).toContain("Provider context was reduced to fit this host's inline context limit; required skill bodies remain complete.");
  expect(result.context).toContain("tyrant_builtin_policy");
  expect(result.context).toContain("END-tdd");
});

test("DSH native skill registry runs first but cannot replace the integrity-pinned skill body", async () => {
  expect(adapterApi?.loadHostSkillFile).toBeDefined();
  expect(dshAdapterApi?.createDshSkillLoader).toBeDefined();
  if (!adapterApi || !dshAdapterApi) return;
  const sandbox = await mkdtemp(join(tmpdir(), "tyrant-pinned-skill-"));
  const workspace = join(sandbox, "project");
  const askPath = join(workspace, ".tyrant", "skills", "ask-matt", "SKILL.md");
  const tastePath = join(workspace, ".tyrant", "skills", "design-taste-frontend", "SKILL.md");
  const askBody = await readFile(join(import.meta.dir, "..", "vendor", "skills", "ask-matt", "SKILL.md"), "utf8");
  const tasteBody = await readFile(join(import.meta.dir, "..", "vendor", "skills", "design-taste-frontend", "SKILL.md"), "utf8");
  const bodyOf = (content: string) => {
    const normalized = content.replaceAll("\r\n", "\n").trim();
    const end = normalized.startsWith("---\n") ? normalized.indexOf("\n---", 4) : -1;
    const start = end < 0 ? -1 : normalized.indexOf("\n", end + 4);
    return (start < 0 ? normalized : normalized.slice(start + 1)).trim();
  };
  const records = [
    { project_path: ".tyrant/skills/ask-matt/SKILL.md", sha256: createHash("sha256").update(askBody).digest("hex") },
    { project_path: ".tyrant/skills/design-taste-frontend/SKILL.md", sha256: createHash("sha256").update(tasteBody).digest("hex") },
  ];
  await mkdir(join(workspace, ".tyrant", "skills", "ask-matt"), { recursive: true });
  await mkdir(join(workspace, ".tyrant", "skills", "design-taste-frontend"), { recursive: true });
  await writeFile(askPath, askBody);
  await writeFile(tastePath, tasteBody);
  await writeFile(join(workspace, ".tyrant", "skills", "manifest.json"), JSON.stringify({ schema_version: 1, files: records }));
  try {
    let registryCalls = 0;
    const loader = dshAdapterApi.createDshSkillLoader({ id: "pinned-agent" }, new AbortController().signal, async () => {
      registryCalls += 1;
      return { content: "Different registry version." };
    });
    const request = { host_id: "dsh", cwd: workspace, skill_id: "matt-pocock-main-flow", source_skill_id: "ask-matt" };
    const loaded = await loader(request);
    expect(loaded).toMatchObject({ status: "loaded", method: "host_skill_file", source_ref: askPath, content: bodyOf(askBody) });
    expect(registryCalls).toBe(1);
    const native = dshAdapterApi.createDshSkillLoader({ id: "native-agent" }, new AbortController().signal, async () => ({
      content: askBody,
      resourceBase: { kind: "directory", path: "D:/project/.agents/skills/ask-matt" },
    }));
    expect(await native(request)).toMatchObject({
      status: "loaded", method: "host_skill_registry", content: bodyOf(askBody),
      resource_base: "D:/project/.agents/skills/ask-matt",
    });
    const taste = await adapterApi.loadHostSkillFile({ host_id: "dsh", cwd: workspace, skill_id: "design-taste-frontend", source_skill_id: "design-taste-frontend" });
    expect(taste.status).toBe("loaded");
    expect(taste.content).toBe(bodyOf(tasteBody));
    const forgedBody = `${askBody}\nmodified`;
    await writeFile(askPath, forgedBody);
    records[0]!.sha256 = createHash("sha256").update(forgedBody).digest("hex");
    await writeFile(join(workspace, ".tyrant", "skills", "manifest.json"), JSON.stringify({ schema_version: 1, files: records }));
    const modified = await loader(request);
    expect(modified).toMatchObject({ status: "missing", reason: "pinned_skill_integrity_mismatch" });
    expect(registryCalls).toBe(1);

    const unpinnedWorkspace = join(sandbox, "unpinned-project");
    await mkdir(join(unpinnedWorkspace, ".agents", "skills", "ask-matt"), { recursive: true });
    await writeFile(join(unpinnedWorkspace, ".agents", "skills", "ask-matt", "SKILL.md"), "Untrusted project skill instructions.");
    const unpinnedRequest = { ...request, cwd: unpinnedWorkspace };
    expect(await adapterApi.loadHostSkillFile(unpinnedRequest)).toMatchObject({ status: "missing", reason: "pinned_skill_integrity_mismatch" });
    const untrustedNative = dshAdapterApi.createDshSkillLoader({ id: "untrusted-agent" }, new AbortController().signal, async () => ({ content: "Untrusted registry instructions." }));
    expect(await untrustedNative(unpinnedRequest)).toMatchObject({ status: "missing", reason: "pinned_skill_integrity_mismatch" });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Claude Code blocks when complete required instructions cannot fit its inline hook limit", async () => {
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!adapterApi) return;
  const result = await adapterApi.prepareAutomaticHostContext(
    { host_id: "claude-code", cwd: "D:/project", session_id: "claude-context-too-large", prompt: "Implement this feature" },
    async () => preparedFixture({
      memory_context: { status: "ready", context: "", references: [] },
      graphify_context: { status: "ready", mapStatus: "current", context: "", references: [] },
    }),
    async ({ skill_id, source_skill_id }) => ({
      status: "loaded", skill_id, source_skill_id, method: "host_skill_file",
       content: `Complete instructions for ${source_skill_id}. ${"S".repeat(12_000)} END-${source_skill_id}`,
    }),
  );

  expect(result.code_change_allowed).toBe(false);
  expect(result.host_context_error).toBe("context_limit_exceeded");
  expect(result.context.length).toBeLessThanOrEqual(9_000);
  expect(result.context).toContain("Complete required instructions and route context exceed Claude Code's inline hook limit.");
});

test("Codex and Claude Code prompt hooks return their documented additional-context payload", () => {
  expect(commandHookApi?.createCommandHookOutput).toBeDefined();
  if (!commandHookApi) return;
  expect(commandHookApi.createCommandHookOutput("codex", "## Tyrant context")).toEqual({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "## Tyrant context" },
  });
  expect(commandHookApi.createCommandHookOutput("claude-code", "## Tyrant context")).toEqual({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "## Tyrant context" },
  });
  expect(commandHookApi.createCommandHookOutput("codex", "## Tyrant blocked", false)).toEqual({
    decision: "block",
    reason: "Tyrant blocked code work because required project context is unavailable.",
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "## Tyrant blocked" },
  });
});

test("command hook emits one successful context response even if evidence logging fails", async () => {
  expect(commandHookApi?.runCommandHook).toBeDefined();
  if (!commandHookApi) return;
  const output: string[] = [];
  await commandHookApi.runCommandHook(
    "codex",
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s-1", cwd: "D:/project", prompt: "Fix health" }),
    {
      async prepare() {
        return { context: "Tyrant context", code_change_allowed: true, task_id: "task-1", request_id: "request-1", loaded_skills: [], skill_loads: [] };
      },
      async record() { throw new Error("event store unavailable"); },
    },
    (line: string) => output.push(line),
  );
  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0])).toEqual({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Tyrant context" },
  });
});

test("command hook retries get a fresh request identity even when the host repeats a turn ID", async () => {
  expect(commandHookApi?.runCommandHook).toBeDefined();
  expect(adapterApi?.deriveHostRequestId).toBeDefined();
  if (!commandHookApi || !adapterApi) return;
  const requestIds: string[] = [];
  const raw = JSON.stringify({
    hook_event_name: "UserPromptSubmit", session_id: "codex-retry-session", cwd: "D:/project",
    turn_id: "same-host-turn", prompt: "Retry this project task",
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await commandHookApi.runCommandHook("codex", raw, {
      async prepare(input) {
        requestIds.push(adapterApi.deriveHostRequestId(input));
        return { task_id: "task", request_id: requestIds.at(-1)!, context: "Tyrant context", code_change_allowed: true, loaded_skills: [], skill_loads: [] };
      },
    }, () => {});
  }
  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).not.toBe(requestIds[0]);
});

test("command hooks block prompts when required providers or skills fail the code gate", async () => {
  expect(commandHookApi?.runCommandHook).toBeDefined();
  if (!commandHookApi) return;
  const output: string[] = [];
  const records: Array<{ context_injected: boolean }> = [];
  await commandHookApi.runCommandHook(
    "claude-code",
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s-blocked", cwd: "D:/project", prompt: "Build the frontend" }),
    {
      async prepare() {
        return {
          context: "Missing Taste skill; do not change code.", code_change_allowed: false,
          required_skill_gaps: ["design-taste-frontend"], provider_gaps: [],
          task_id: "task-blocked", request_id: "request-blocked", loaded_skills: [], skill_loads: [],
        };
      },
      async record(result: { context_injected: boolean }) { records.push(result); },
    },
    (line: string) => output.push(line),
  );
  expect(JSON.parse(output[0])).toMatchObject({
    decision: "block",
    reason: "Tyrant blocked model work because required project context is unavailable: design-taste-frontend.",
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Missing Taste skill; do not change code." },
  });
  expect(records).toHaveLength(1);
  expect(records[0].context_injected).toBe(false);
});

test("Codex and Claude Code recognize only their real SessionEnd hook event", () => {
  expect(commandHookApi?.parseCommandSessionEndInput).toBeDefined();
  if (!commandHookApi) return;
  expect(commandHookApi.parseCommandSessionEndInput("codex", {
    hook_event_name: "SessionEnd", session_id: "codex-session", cwd: "D:/project", reason: "exit",
  })).toEqual({ host_id: "codex", session_id: "codex-session", cwd: "D:/project", event: "SessionEnd" });
  expect(() => commandHookApi.parseCommandSessionEndInput("claude-code", {
    hook_event_name: "Stop", session_id: "claude-session", cwd: "D:/project",
  })).toThrow();
});

test("DSH pre-step auto-prepares only claimed user prompts and injects one Tyrant message", async () => {
  expect(dshAdapterApi?.createDshPreStepHandler).toBeDefined();
  if (!dshAdapterApi) return;
  let preflightCalls = 0;
  const handler = dshAdapterApi.createDshPreStepHandler({
    async prepare(input: Record<string, string>) {
      preflightCalls += 1;
      expect(input).toMatchObject({ host_id: "dsh", session_id: "dsh-session", prompt: "Add a health endpoint" });
      return { task_id: "dsh-task", request_id: "dsh-request", context: "Matt + Memory + Graphify", code_change_allowed: true, loaded_skills: [], skill_loads: [] };
    },
    makeMessage(text: string) { return { id: "tyrant-injected", content: [{ type: "text", text }], source: { kind: "tyrant" } }; },
    async record() {},
  });
  const agent = { id: "dsh-session", session: { id: "dsh-session", header: { cwd: "D:/project" } } };
  const payload = {
    agent, messages: [{ id: "user-1", source: { kind: "user" }, content: [{ type: "text", text: "Add a health endpoint" }] }],
    turn: 3, step: 1, signal: new AbortController().signal,
  };
  const result = await handler(payload, async () => ({ kind: "enter", messages: payload.messages }));
  expect(result.kind).toBe("enter");
  if (result.kind !== "enter") throw new Error("Expected the DSH pre-step to enter with context.");
  expect(result.messages).toHaveLength(2);
  expect(result.messages[0].id).toBe("user-1");
  expect(result.messages[1].source?.kind).toBe("tyrant");
  const injectedContent = result.messages[1].content;
  if (!Array.isArray(injectedContent) || !injectedContent[0] || typeof injectedContent[0] !== "object" || !("text" in injectedContent[0])) {
    throw new Error("Expected the DSH adapter to add a text context message.");
  }
  expect(injectedContent[0].text).toContain("Matt + Memory + Graphify");

  await handler({ ...payload, messages: [], step: 2 }, async () => ({ kind: "enter", messages: [] }));
  expect(preflightCalls).toBe(1);
});

test("DSH rejects a model step when required project context is blocked", async () => {
  expect(dshAdapterApi?.createDshPreStepHandler).toBeDefined();
  if (!dshAdapterApi) return;
  const recordedOutcomes: boolean[] = [];
  const handler = dshAdapterApi.createDshPreStepHandler({
    async prepare() {
      return { task_id: "blocked-task", request_id: "blocked-request", context: "Graphify unavailable", code_change_allowed: false, provider_gaps: ["graphify"], loaded_skills: [], skill_loads: [] };
    },
    makeMessage(text: string) { return { id: "tyrant", content: [{ type: "text", text }] }; },
    async record(value: { context_injected: boolean }) { recordedOutcomes.push(value.context_injected); },
    onError(error: unknown) { expect(String(error)).toContain("required project context"); expect(String(error)).toContain("graphify"); },
  });
  const payload = {
    agent: { id: "blocked-session", session: { id: "blocked-session", header: { cwd: "D:/project" } } },
    messages: [{ id: "user", source: { kind: "user" }, content: [{ type: "text", text: "Fix API" }] }],
    turn: 1, step: 1, signal: new AbortController().signal,
  };
  const result = await handler(payload, async () => ({ kind: "enter", messages: payload.messages }));
  expect(result.kind).toBe("reject");
  expect(recordedOutcomes).toEqual([false]);
});

test("DSH retries a same-turn provider failure with a fresh Tyrant request identity", async () => {
  expect(dshAdapterApi?.createDshPreStepHandler).toBeDefined();
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!dshAdapterApi || !adapterApi) return;
  const requestIds: string[] = [];
  const replayByRequestId = new Map<string, unknown>();
  let prepareExecutions = 0;
  const providerBlockedTask = preparedFixture({
    task: { id: "dsh-provider-retry", lifecycle_state: "blocked" },
    route: {
      status: "blocked",
      core_workflow: { workflow_id: "matt-pocock-main-flow", source_skill_id: "ask-matt", policy_applied: true },
      specialists: [],
      provider_gaps: [{ provider: "graphify", status: "blocked", message: "Graphify map is missing." }],
      code_change_gate: { status: "blocked", provider_ids: ["graphify"] },
    },
    blockers: [{ provider: "graphify", status: "blocked", message: "Graphify map is missing." }],
    graphify_context: { status: "unavailable", mapStatus: "missing", context: "", references: [], errorCode: "command_missing" },
    checkpoint: { phase: "preflight", blocker: "Required project context is not ready." },
  });
  const recoveredTask = preparedFixture({
    task: { id: "dsh-provider-retry", lifecycle_state: "blocked" },
    checkpoint: { phase: "preflight", blocker: "Required project context is not ready." },
  });
  const callTool = async (name: string, args: Record<string, unknown>) => {
    if (name === "tyrant_prepare_task") {
      const requestId = String(args.request_id);
      requestIds.push(requestId);
      const replayed = replayByRequestId.get(requestId);
      if (replayed) return replayed;
      prepareExecutions += 1;
      const response = { structuredContent: prepareExecutions === 1 ? providerBlockedTask : recoveredTask };
      replayByRequestId.set(requestId, response);
      return response;
    }
    if (name === "tyrant_transition_task") {
      return { structuredContent: { task: { id: "dsh-provider-retry", lifecycle_state: "planned" } } };
    }
    return {};
  };
  const handler = dshAdapterApi.createDshPreStepHandler({
    async prepare(input: HostHookInput) {
      return adapterApi.prepareAutomaticHostContext(input, callTool, async ({ skill_id, source_skill_id }) => ({
        status: "loaded", skill_id, source_skill_id, method: "host_skill_file", content: `Instructions for ${source_skill_id}.`,
      }));
    },
    makeMessage(text: string) { return { id: "tyrant-injected", content: [{ type: "text", text }] }; },
  });
  const payload = {
    agent: { id: "retry-session", session: { id: "retry-session", header: { cwd: "D:/project" } } },
    messages: [{ id: "retry-user", source: { kind: "user" }, content: [{ type: "text", text: "Retry the project task" }] }],
    turn: 4, step: 1, signal: new AbortController().signal,
  };

  const first = await handler(payload, async () => ({ kind: "enter", messages: payload.messages }));
  expect(first.kind).toBe("reject");
  const second = await handler(payload, async () => ({ kind: "enter", messages: payload.messages }));

  expect(second.kind).toBe("enter");
  expect(prepareExecutions).toBe(2);
  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).not.toBe(requestIds[0]);
});

test("DSH adapter restart gets a fresh request identity for a replayed host turn", async () => {
  expect(dshAdapterApi?.createDshPreStepHandler).toBeDefined();
  expect(adapterApi?.deriveHostRequestId).toBeDefined();
  if (!dshAdapterApi || !adapterApi) return;
  const requestIds: string[] = [];
  const makeHandler = () => dshAdapterApi!.createDshPreStepHandler({
    async prepare(input: HostHookInput) {
      requestIds.push(adapterApi!.deriveHostRequestId(input));
      return { task_id: "dsh-restart", request_id: requestIds.at(-1)!, context: "Tyrant context", code_change_allowed: true, loaded_skills: [], skill_loads: [] };
    },
    makeMessage(text: string) { return { id: "tyrant-injected", content: [{ type: "text", text }] }; },
  });
  const payload = {
    agent: { id: "restart-session", session: { id: "restart-session", header: { cwd: "D:/project" } } },
    messages: [{ id: "replayed-user", source: { kind: "user" }, content: [{ type: "text", text: "Continue project work" }] }],
    turn: 7, step: 1, signal: new AbortController().signal,
  };
  const run = async (handler: ReturnType<typeof makeHandler>) => handler(payload, async () => ({ kind: "enter", messages: payload.messages }));

  await run(makeHandler());
  await run(makeHandler());

  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).not.toBe(requestIds[0]);
});

test("DSH rejects skill bodies that do not match a trusted runtime pin", async () => {
  expect(dshAdapterApi?.createDshSkillLoader).toBeDefined();
  if (!dshAdapterApi) return;
  const sandbox = await mkdtemp(join(tmpdir(), "tyrant-dsh-skill-"));
  const workspace = join(sandbox, "project");
  await mkdir(join(workspace, ".dsh", "skills", "ask-matt"), { recursive: true });
  await writeFile(join(workspace, ".dsh", "skills", "ask-matt", "SKILL.md"), "---\nname: ask-matt\n---\nWorkspace Matt instructions.");
  const agent = { id: "scope-agent" };
  const controller = new AbortController();
  const calls: Array<{ candidate: string; options: Record<string, unknown> }> = [];
  try {
    const loader = dshAdapterApi.createDshSkillLoader(agent, controller.signal, async (candidate: string, options: Record<string, unknown>) => {
      calls.push({ candidate, options });
      return { content: "Registry Matt instructions.", resourceBase: { kind: "directory", path: "D:/skills/ask-matt" } };
    });
    const request = { host_id: "dsh", cwd: workspace, skill_id: "matt-pocock-main-flow", source_skill_id: "ask-matt" };
    const loaded = await loader(request);
    expect(loaded).toMatchObject({ status: "missing", reason: "pinned_skill_integrity_mismatch" });
    expect(calls).toHaveLength(1);
    expect(calls[0].candidate).toBe("ask-matt");
    expect(calls[0].options).toMatchObject({ cwd: workspace, signal: controller.signal, scope: agent });

    const fallback = dshAdapterApi.createDshSkillLoader(agent, controller.signal, async () => undefined);
    expect(await fallback(request)).toMatchObject({ status: "missing", reason: "pinned_skill_integrity_mismatch" });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("DSH does not create a context-only model step when the claimed user message was removed", async () => {
  expect(dshAdapterApi?.createDshPreStepHandler).toBeDefined();
  if (!dshAdapterApi) return;
  let prepareCalls = 0;
  const handler = dshAdapterApi.createDshPreStepHandler({
    async prepare() {
      prepareCalls += 1;
      return { task_id: "task", request_id: "request", context: "context", code_change_allowed: true, loaded_skills: [], skill_loads: [] };
    },
    makeMessage(text: string) { return { id: "tyrant", content: [{ type: "text", text }], source: { kind: "tyrant" } }; },
  });
  const payload = {
    agent: { id: "s", session: { id: "s", header: { cwd: "D:/project" } } },
    messages: [{ id: "user-2", source: { kind: "user" }, content: [{ type: "text", text: "Do work" }] }],
    turn: 1, step: 1, signal: new AbortController().signal,
  };
  const result = await handler(payload, async () => ({ kind: "enter", messages: [] }));
  if (result.kind !== "enter") throw new Error("Expected an enter decision.");
  expect(result.messages).toHaveLength(0);
  expect(prepareCalls).toBe(0);
});

test("OpenCode prepares on prompt admission and reuses context without repeating providers on model continuations", async () => {
  expect(openCodeAdapterApi?.createOpenCodeHooks).toBeDefined();
  if (!openCodeAdapterApi) return;
  let prepareCalls = 0;
  let recordCalls = 0;
  const hooks = openCodeAdapterApi.createOpenCodeHooks({
    async prepare(input: Record<string, string>) {
      prepareCalls += 1;
      expect(input).toMatchObject({ host_id: "opencode", session_id: "opencode-session", prompt: "Add pagination" });
      return { task_id: "oc-task", request_id: "oc-request", context: "Tyrant preflight context", code_change_allowed: true, loaded_skills: [], skill_loads: [] };
    },
    async record() { recordCalls += 1; },
  });
  await hooks.onPrompt({ sessionID: "opencode-session", cwd: "D:/project", messageID: "message-1", prompt: { text: "Add pagination" } });
  const first = { sessionID: "opencode-session", messages: [{ id: "message-1", role: "user" }], system: [] as Array<{ type: string; text: string }> };
  await hooks.onContext(first);
  const second = { sessionID: "opencode-session", messages: [{ id: "message-1", role: "user" }], system: [] as Array<{ type: string; text: string }> };
  await hooks.onContext(second);
  expect(prepareCalls).toBe(1);
  expect(recordCalls).toBe(1);
  expect(first.system[0].text).toContain("Tyrant preflight context");
  expect(second.system[0].text).toContain("Tyrant preflight context");
});

test("OpenCode does not admit prompts when required project context is blocked", async () => {
  expect(openCodeAdapterApi?.createOpenCodeHooks).toBeDefined();
  if (!openCodeAdapterApi) return;
  const hooks = openCodeAdapterApi.createOpenCodeHooks({
    async prepare() {
      return {
        task_id: "blocked-task", request_id: "blocked-request", context: "Graphify unavailable",
        code_change_allowed: false, provider_gaps: ["graphify"], loaded_skills: [], skill_loads: [],
      };
    },
    async record(value: { context_injected: boolean }) { expect(value.context_injected).toBe(false); },
  });
  await expect(hooks.onPrompt({ sessionID: "blocked-session", cwd: "D:/project", messageID: "blocked-message", prompt: { text: "Fix API" } }))
    .rejects.toThrow("graphify");
  const request = { sessionID: "blocked-session", messages: [{ id: "blocked-message", role: "user" }], system: [] as Array<{ type: string; text: string }> };
  await expect(hooks.onContext(request)).rejects.toThrow("preflight is missing");
  expect(request.system).toHaveLength(0);
});

test("OpenCode retries a repeated message ID with fresh providers after a blocked preflight", async () => {
  expect(openCodeAdapterApi?.createOpenCodeHooks).toBeDefined();
  expect(adapterApi?.prepareAutomaticHostContext).toBeDefined();
  if (!openCodeAdapterApi || !adapterApi) return;
  const requestIds: string[] = [];
  const replayByRequestId = new Map<string, unknown>();
  let prepareExecutions = 0;
  const providerBlockedTask = preparedFixture({
    task: { id: "opencode-provider-retry", lifecycle_state: "blocked" },
    route: {
      status: "blocked",
      core_workflow: { workflow_id: "matt-pocock-main-flow", source_skill_id: "ask-matt", policy_applied: true },
      specialists: [],
      provider_gaps: [{ provider: "graphify", status: "blocked", message: "Graphify map is missing." }],
      code_change_gate: { status: "blocked", provider_ids: ["graphify"] },
    },
    blockers: [{ provider: "graphify", status: "blocked", message: "Graphify map is missing." }],
    graphify_context: { status: "unavailable", mapStatus: "missing", context: "", references: [], errorCode: "command_missing" },
    checkpoint: { phase: "preflight", blocker: "Required project context is not ready." },
  });
  const recoveredTask = preparedFixture({
    task: { id: "opencode-provider-retry", lifecycle_state: "blocked" },
    checkpoint: { phase: "preflight", blocker: "Required project context is not ready." },
  });
  const callTool = async (name: string, args: Record<string, unknown>) => {
    if (name === "tyrant_prepare_task") {
      const requestId = String(args.request_id);
      requestIds.push(requestId);
      const replayed = replayByRequestId.get(requestId);
      if (replayed) return replayed;
      prepareExecutions += 1;
      const response = { structuredContent: prepareExecutions === 1 ? providerBlockedTask : recoveredTask };
      replayByRequestId.set(requestId, response);
      return response;
    }
    if (name === "tyrant_transition_task") {
      return { structuredContent: { task: { id: "opencode-provider-retry", lifecycle_state: "planned" } } };
    }
    return {};
  };
  const hooks = openCodeAdapterApi.createOpenCodeHooks({
    async prepare(input: HostHookInput) {
      return adapterApi.prepareAutomaticHostContext(input, callTool, async ({ skill_id, source_skill_id }) => ({
        status: "loaded", skill_id, source_skill_id, method: "host_skill_file", content: `Instructions for ${source_skill_id}.`,
      }));
    },
  });
  const event = { sessionID: "opencode-retry-session", cwd: "D:/project", messageID: "same-message", prompt: { text: "Retry the project task" } };

  await expect(hooks.onPrompt(event)).rejects.toThrow("graphify");
  await hooks.onPrompt(event);
  const contextEvent = {
    sessionID: event.sessionID,
    messages: [{ id: event.messageID, role: "user" }],
    system: [] as Array<{ type: string; text: string }>,
  };
  await hooks.onContext(contextEvent);

  expect(prepareExecutions).toBe(2);
  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).not.toBe(requestIds[0]);
  expect(contextEvent.system[0]?.text).toContain("recorded the blocked-to-planned transition");
});

test("OpenCode adapter restart gets a fresh request identity for a replayed message", async () => {
  expect(openCodeAdapterApi?.createOpenCodeHooks).toBeDefined();
  expect(adapterApi?.deriveHostRequestId).toBeDefined();
  if (!openCodeAdapterApi || !adapterApi) return;
  const requestIds: string[] = [];
  const makeHooks = () => openCodeAdapterApi!.createOpenCodeHooks({
    async prepare(input: HostHookInput) {
      requestIds.push(adapterApi!.deriveHostRequestId(input));
      return { task_id: "opencode-restart", request_id: requestIds.at(-1)!, context: "Tyrant context", code_change_allowed: true, loaded_skills: [], skill_loads: [] };
    },
  });
  const event = { sessionID: "restart-session", cwd: "D:/project", messageID: "replayed-message", prompt: { text: "Continue project work" } };

  await makeHooks().onPrompt(event);
  await makeHooks().onPrompt(event);

  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).not.toBe(requestIds[0]);
});

test("OpenCode routes queued prompt context by message identity instead of overwriting a session's preflight", async () => {
  expect(openCodeAdapterApi?.createOpenCodeHooks).toBeDefined();
  if (!openCodeAdapterApi) return;
  const hooks = openCodeAdapterApi.createOpenCodeHooks({
    async prepare(input: Record<string, string>) {
      return { task_id: input.prompt, request_id: input.turn_id, context: `Context for ${input.prompt}`, code_change_allowed: true, loaded_skills: [], skill_loads: [] };
    },
  });
  await hooks.onPrompt({ sessionID: "same-session", cwd: "D:/project", messageID: "message-1", prompt: { text: "first request" } });
  await hooks.onPrompt({ sessionID: "same-session", cwd: "D:/project", messageID: "message-2", prompt: { text: "second request" } });
  const first = { sessionID: "same-session", messages: [{ id: "message-1", role: "user" }], system: [] as Array<{ type: string; text: string }> };
  const second = { sessionID: "same-session", messages: [{ id: "message-2", role: "user" }], system: [] as Array<{ type: string; text: string }> };
  await hooks.onContext(first);
  await hooks.onContext(second);
  expect(first.system[0]?.text).toContain("Context for first request");
  expect(second.system[0]?.text).toContain("Context for second request");
});

test("a failed OpenCode preflight does not erase context already prepared for another queued prompt", async () => {
  expect(openCodeAdapterApi?.createOpenCodeHooks).toBeDefined();
  if (!openCodeAdapterApi) return;
  const hooks = openCodeAdapterApi.createOpenCodeHooks({
    async prepare(input: Record<string, string>) {
      if (input.prompt === "second request") throw new Error("provider unavailable");
      return { task_id: "task-1", request_id: "request-1", context: "First prompt context", code_change_allowed: true, loaded_skills: [], skill_loads: [] };
    },
  });
  await hooks.onPrompt({ sessionID: "same-session", cwd: "D:/project", messageID: "message-1", prompt: { text: "first request" } });
  try {
    await hooks.onPrompt({ sessionID: "same-session", cwd: "D:/project", messageID: "message-2", prompt: { text: "second request" } });
  } catch {}
  const first = { sessionID: "same-session", messages: [{ id: "message-1", role: "user" }], system: [] as Array<{ type: string; text: string }> };
  await hooks.onContext(first);
  expect(first.system[0]?.text).toBe("First prompt context");
});
