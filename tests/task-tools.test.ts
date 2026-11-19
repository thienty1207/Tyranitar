import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTyrantServer } from "../src/mcp/server";
import { TyrantStore } from "../src/state/store";

const sandbox = await mkdtemp(join(tmpdir(), "tyrant-tools-"));
const stateDirectory = join(sandbox, "state");
const quotaStateDirectory = join(sandbox, "quota-state");
const projectA = join(sandbox, "project-a");
const projectB = join(sandbox, "project-b");
const autoSessionProject = join(sandbox, "auto-session-project");
const autoRetryProject = join(sandbox, "auto-retry-project");
const autoHandoffProject = join(sandbox, "auto-handoff-project");
const autoAmbiguousProject = join(sandbox, "auto-ambiguous-project");
const providerRecoveryProvenanceProject = join(sandbox, "provider-recovery-provenance-project");
const legacyStateDirectory = join(sandbox, "legacy-state");
const legacyProject = join(sandbox, "legacy-project");
await Promise.all([
  mkdir(stateDirectory), mkdir(quotaStateDirectory), mkdir(projectA), mkdir(projectB),
  mkdir(autoSessionProject), mkdir(autoRetryProject), mkdir(autoHandoffProject), mkdir(autoAmbiguousProject), mkdir(providerRecoveryProvenanceProject),
  mkdir(legacyStateDirectory), mkdir(legacyProject),
]);

const priorStateDirectory = process.env.TYRANT_STATE_DIR;
const priorProjectRoot = process.env.TYRANT_PROJECT_ROOT;
const unavailableGraphify = {
  async loadContext() {
    return { status: "unavailable", mapStatus: "missing", context: "", references: [], errorCode: "command_missing" };
  },
};

async function openClient(projectRoot: string, selectedStateDirectory = stateDirectory, aiMemory?: unknown, graphify?: unknown) {
  process.env.TYRANT_STATE_DIR = selectedStateDirectory;
  process.env.TYRANT_PROJECT_ROOT = projectRoot;

  const server = createTyrantServer({ aiMemory, graphify: graphify ?? unavailableGraphify } as any);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tyrant-contract-test", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function parseToolResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content.find((item) => item.type === "text");
  if (!content || content.type !== "text") throw new Error("Tyrant tool did not return text content.");
  return JSON.parse(content.text) as Record<string, any>;
}

afterAll(async () => {
  if (priorStateDirectory === undefined) delete process.env.TYRANT_STATE_DIR;
  else process.env.TYRANT_STATE_DIR = priorStateDirectory;
  if (priorProjectRoot === undefined) delete process.env.TYRANT_PROJECT_ROOT;
  else process.env.TYRANT_PROJECT_ROOT = priorProjectRoot;
  await rm(sandbox, { recursive: true, force: true });
});

test("prepare always puts Matt Pocock first and requires ai-memory plus Graphify", async () => {
  const { client, close } = await openClient(projectA);
  try {
    const result = await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Implement tracing for the request flow", request_id: "prepare-001" },
    });

    expect(result.isError).toBeFalsy();
    const prepared = parseToolResult(result);
    const retry = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Implement tracing for the request flow", request_id: "prepare-001" },
    }));
    expect(prepared.schema_version).toBe(1);
    expect(retry.task.id).toBe(prepared.task.id);
    expect(retry.events).toHaveLength(5);
    expect(prepared.route.core_workflow).toMatchObject({
      workflow_id: "matt-pocock-main-flow",
      policy_applied: true,
      status: "used",
      execution_method: "tyrant_internal_policy",
      required: true,
      order: 0,
      native_skill: {
        skill_id: "ask-matt",
        invocation_policy: "manual_only",
        host_availability: "unknown",
        status: "not_invoked",
      },
    });
    expect(prepared.route.required_context.map((item: { provider: string }) => item.provider)).toEqual([
      "ai-memory",
      "graphify",
    ]);
    expect(prepared.task.status).toBe("blocked");
    expect(prepared.blockers).toHaveLength(2);
  } finally {
    await close();
  }
});

test("prepare combines ready ai-memory history and Graphify current-code context without merging their roles", async () => {
  const aiMemory = {
    async loadContext() {
      return { status: "ready", context: "[historical_untrusted] Keep the API stable.", references: ["ai-memory:page:decision-7"], handoffStatus: "none" };
    },
    async syncOutcome() {
      return { status: "synced", handoffStatus: "not_required" };
    },
  };
  const graphContext = {
    status: "ready", mapStatus: "current",
    context: "Derived Graphify context; verify against source:\nserver.ts::handleRequest calls router.ts::routeTask",
    references: [
      `graphify:graph:graphify-out/graph.json#sha256=${"a".repeat(64)}`,
      `graphify:query:${"b".repeat(64)}`,
    ],
  };
  const graphify = { async loadContext() { return graphContext; } };
  const { client, close } = await openClient(projectB, stateDirectory, aiMemory, graphify);
  try {
    const prepared = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Implement a bounded API change", request_id: "graphify-ready-prepare-001" },
    }));

    expect(prepared.memory_context.context).toContain("historical_untrusted");
    expect(prepared.graphify_context.context).toContain("Derived Graphify context");
    expect(prepared.task.graphify).toMatchObject({
      context_status: "ready", map_status: "current", error_code: null,
      references: graphContext.references,
    });
    expect(prepared.route.required_context.map((provider: any) => provider.status)).toEqual(["available", "available"]);
    expect(prepared.route.provider_gaps).toEqual([]);
    expect(prepared.blockers).toEqual([]);
    expect(prepared.task.status).toBe("active");
    expect(prepared.checkpoint.ai_memory_refs).toEqual(["ai-memory:page:decision-7"]);
    expect(prepared.checkpoint.graphify_refs).toEqual(graphContext.references);
    expect(prepared.task.graphify.context).toBeUndefined();
    expect(prepared.events.find((event: any) => event.event_type === "graphify_context_loaded")).toMatchObject({
      outcome: "success", evidence_refs: graphContext.references,
    });
  } finally {
    await close();
  }
});

test("resumed tasks refresh Graphify state and keep an explicit transition after a provider blocker clears", async () => {
  const aiMemory = {
    async loadContext() {
      return { status: "ready", context: "[historical_untrusted] Prior work", references: ["ai-memory:page:prior"], handoffStatus: "none" };
    },
    async syncOutcome() { return { status: "synced", handoffStatus: "not_required" }; },
  };
  const currentGraphContext = {
    status: "ready", mapStatus: "current",
    context: "Derived Graphify context; verify against source:\nmodule.ts::start",
    references: [`graphify:graph:graphify-out/graph.json#sha256=${"c".repeat(64)}`],
  };
  let graphContext: Record<string, unknown> = {
    status: "unavailable", mapStatus: "missing", context: "", references: [], errorCode: "command_missing",
  };
  const graphify = { async loadContext() { return graphContext; } };
  const { client, close } = await openClient(projectB, stateDirectory, aiMemory, graphify);
  try {
    const first = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Implement a service change", request_id: "graphify-resume-first-001" },
    }));
    expect(first.task.lifecycle_state).toBe("blocked");
    expect(first.blockers.map((item: any) => item.provider)).toEqual(["graphify"]);

    graphContext = currentGraphContext;
    const resumed = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task_id: first.task.id, task: "Implement a service change", request_id: "graphify-resume-second-001" },
    }));

    expect(resumed.route.provider_gaps).toEqual([]);
    expect(resumed.task.graphify).toMatchObject({ context_status: "ready", map_status: "current", references: currentGraphContext.references });
    expect(resumed.task.lifecycle_state).toBe("blocked");
    expect(resumed.next_action).toContain("explicit transition");
    expect(resumed.events.filter((event: any) => event.event_type === "graphify_context_loaded")).toHaveLength(2);
  } finally {
    await close();
  }
});

test("task state keeps the latest blocking transition after it leaves the bounded event window", async () => {
  const aiMemory = {
    async loadContext() {
      return { status: "ready", context: "[historical_untrusted] Existing project notes.", references: [], handoffStatus: "none" };
    },
    async syncOutcome() { return { status: "synced", handoffStatus: "not_required" }; },
  };
  const { client, close } = await openClient(providerRecoveryProvenanceProject, stateDirectory, aiMemory);
  try {
    const task = "Implement a provider-backed change";
    const initial = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task, request_id: "aged-block-prepare-001", host_id: "codex", session_id: "aged-block-session" },
    }));
    const taskId = initial.task.id as string;
    expect(initial.task.lifecycle_state).toBe("blocked");

    for (const [request_id, next_state, reason] of [
      ["aged-block-planned", "planned", "Providers were available; plan the task"],
      ["aged-block-started", "in_progress", "Begin implementation"],
      ["aged-block-blocked", "blocked", "A required test failed; stop implementation"],
    ]) {
      await client.callTool({
        name: "tyrant_transition_task",
        arguments: { schema_version: 1, task_id: taskId, request_id, next_state, reason },
      });
    }

    for (let index = 0; index < 12; index += 1) {
      await client.callTool({
        name: "tyrant_prepare_task",
        arguments: {
          schema_version: 1, task_id: taskId, task,
          request_id: `aged-block-refresh-${String(index).padStart(2, "0")}`,
          host_id: "codex", session_id: "aged-block-session",
        },
      });
    }

    const state = parseToolResult(await client.callTool({
      name: "tyrant_get_task", arguments: { schema_version: 1, task_id: taskId },
    }));
    expect(state.task.lifecycle_state).toBe("blocked");
    expect(state.events).toHaveLength(20);
    expect(state.events.some((event: any) => event.summary === "A required test failed; stop implementation")).toBe(false);
    expect(state.latest_block_event).toMatchObject({
      event_type: "task_state_changed", new_state: "blocked", summary: "A required test failed; stop implementation",
    });
  } finally {
    await close();
  }
});

test("skill listing omits site cloning and marks the core/context routes required", async () => {
  const { client, close } = await openClient(projectA);
  try {
    const result = await client.callTool({ name: "tyrant_list_skills", arguments: { schema_version: 1 } });
    expect(result.isError).toBeFalsy();
    const catalog = parseToolResult(result);
    const skills = catalog.skills as Array<{
      id: string;
      required: boolean;
      role: string;
      version: string | null;
      invocation: string;
      requirements: string[];
    }>;

    expect(skills.map((skill) => skill.id)).not.toContain("site-clone");
    expect(skills.every((skill) => Object.hasOwn(skill, "version"))).toBe(true);
    expect(skills.every((skill) => skill.invocation.length > 0 && skill.requirements.length > 0)).toBe(true);
    expect(skills.find((skill) => skill.id === "matt-pocock-main-flow")).toMatchObject({ required: true, role: "core-orchestrator" });
    expect(skills.find((skill) => skill.id === "ai-memory")).toMatchObject({ required: true, role: "project-memory" });
    expect(skills.find((skill) => skill.id === "graphify")).toMatchObject({ required: true, role: "code-map" });
    expect(skills.find((skill) => skill.id === "design-taste-frontend")).toMatchObject({ required: true, role: "frontend" });
  } finally {
    await close();
  }
});

test("the routing-policy resource and task-start prompt are discoverable and readable", async () => {
  const { client, close } = await openClient(projectA);
  try {
    const listedResources = await client.listResources();
    expect(listedResources.resources.map((resource) => resource.uri)).toContain("tyrant://routing-policy");
    const resource = await client.readResource({ uri: "tyrant://routing-policy" });
    expect(resource.contents[0]).toMatchObject({ mimeType: "text/markdown" });
    const resourceContents = resource.contents[0];
    expect("text" in resourceContents ? resourceContents.text : "").toContain("ai-memory and Graphify are required");

    const listedPrompts = await client.listPrompts();
    expect(listedPrompts.prompts.map((prompt) => prompt.name)).toContain("tyrant-start-task");
    const prompt = await client.getPrompt({ name: "tyrant-start-task" });
    expect(prompt.messages[0].content).toMatchObject({ type: "text" });
    expect((prompt.messages[0].content as { text: string }).text).toContain("Matt Pocock");
  } finally {
    await close();
  }
});

test("task mutations are retry-safe and the latest checkpoint survives a server restart", async () => {
  const first = await openClient(projectA);
  let taskId = "";
  try {
    const prepared = parseToolResult(await first.client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Map the project", request_id: "prepare-persist-001" },
    }));
    taskId = prepared.task.id;

    const checkpointInput = {
      schema_version: 1,
      task_id: taskId,
      request_id: "checkpoint-001",
      phase: "orientation",
      last_reliable_step: "Loaded the project specification",
      next_action: "Inspect the MCP server boundary",
      evidence_refs: ["spec/SPEC-01-MCP-AND-HOSTS.md"],
    };
    const checkpoint = parseToolResult(await first.client.callTool({ name: "tyrant_checkpoint", arguments: checkpointInput }));
    const retry = parseToolResult(await first.client.callTool({ name: "tyrant_checkpoint", arguments: checkpointInput }));
    expect(retry.checkpoint.id).toBe(checkpoint.checkpoint.id);

    const conflict = await first.client.callTool({
      name: "tyrant_checkpoint",
      arguments: { ...checkpointInput, next_action: "Use a different payload with the same key" },
    });
    expect(conflict.isError).toBe(true);

    const eventInput = {
      schema_version: 1,
      task_id: taskId,
      request_id: "event-001",
      event_type: "route_selected",
      summary: "Matt Pocock is the first workflow",
    };
    const event = await first.client.callTool({
      name: "tyrant_record_event",
      arguments: eventInput,
    });
    const eventRetry = await first.client.callTool({ name: "tyrant_record_event", arguments: eventInput });
    expect(event.isError).toBeFalsy();
    expect(parseToolResult(eventRetry).event.id).toBe(parseToolResult(event).event.id);

    const evidenceInput = {
      schema_version: 1,
      task_id: taskId,
      request_id: "evidence-001",
      check_id: "preflight",
      status: "blocked",
      summary: "Required context providers are not configured",
    };
    const evidence = await first.client.callTool({
      name: "tyrant_record_evidence",
      arguments: evidenceInput,
    });
    const evidenceRetry = await first.client.callTool({ name: "tyrant_record_evidence", arguments: evidenceInput });
    expect(evidence.isError).toBeFalsy();
    expect(parseToolResult(evidenceRetry).evidence.id).toBe(parseToolResult(evidence).evidence.id);

    const finishInput = {
      schema_version: 1,
      task_id: taskId,
      request_id: "finish-001",
      status: "blocked",
      summary: "Task cannot proceed until required context is available",
      next_action: "Configure ai-memory and Graphify",
    };
    const finished = await first.client.callTool({
      name: "tyrant_finish_task",
      arguments: finishInput,
    });
    const finishRetry = await first.client.callTool({ name: "tyrant_finish_task", arguments: finishInput });
    expect(finished.isError).toBeFalsy();
    expect(parseToolResult(finishRetry)).toEqual(parseToolResult(finished));
  } finally {
    await first.close();
  }

  const restarted = await openClient(projectA);
  try {
    const recovered = await restarted.client.callTool({
      name: "tyrant_get_task",
      arguments: { schema_version: 1, task_id: taskId },
    });
    expect(recovered.isError).toBeFalsy();
    const state = parseToolResult(recovered);
    expect(state.task.id).toBe(taskId);
    expect(state.task.status).toBe("blocked");
    expect(state.task.finish_summary).toBe("Task cannot proceed until required context is available");
    expect(state.task.next_action).toBe("Configure ai-memory and Graphify");
    expect(state.checkpoint.next_action).toBe("Inspect the MCP server boundary");
    expect(state.events.length).toBeGreaterThan(0);
    expect(state.events.find((event: any) => event.event_type === "task_blocked")).toMatchObject({
      event_type: "task_blocked",
      summary: "Task cannot proceed until required context is available",
      next_action: "Configure ai-memory and Graphify",
    });
    expect(state.evidence.length).toBe(1);
  } finally {
    await restarted.close();
  }

  const otherProject = await openClient(projectB);
  try {
    const isolated = await otherProject.client.callTool({
      name: "tyrant_get_task",
      arguments: { schema_version: 1, task_id: taskId },
    });
    expect(isolated.isError).toBe(true);
    const text = isolated.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    expect(text).not.toContain("Map the project");

    const crossProjectWrite = await otherProject.client.callTool({
      name: "tyrant_checkpoint",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "cross-project-checkpoint-001",
        phase: "unauthorized-project",
        last_reliable_step: "This project must not access another project's task",
        next_action: "Stop",
      },
    });
    expect(crossProjectWrite.isError).toBe(true);
    const stillIsolated = await otherProject.client.callTool({
      name: "tyrant_get_task",
      arguments: { schema_version: 1, task_id: taskId },
    });
    expect(stillIsolated.isError).toBe(true);
  } finally {
    await otherProject.close();
  }
});

test("skill lifecycle claims require host evidence and preserve blocked or skipped status", async () => {
  const { client, close } = await openClient(projectA);
  try {
    const prepared = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Record a skill lifecycle", request_id: "skill-lifecycle-prepare-001" },
    }));
    const taskId = prepared.task.id as string;

    const missingEvidence = await client.callTool({
      name: "tyrant_record_event",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "skill-used-without-evidence-001",
        event_type: "skill_used",
        skill_id: "matt-tdd",
        summary: "The host reports the skill was used",
      },
    });
    expect(missingEvidence.isError).toBe(true);
    expect(parseToolResult(missingEvidence).error.code).toBe("INVALID_INPUT");

    const mismatchedBlockedOutcome = await client.callTool({
      name: "tyrant_record_event",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "skill-blocked-wrong-outcome-001",
        event_type: "skill_blocked",
        skill_id: "design-taste-frontend",
        outcome: "success",
        summary: "The blocked event must keep a blocked outcome",
      },
    });
    expect(mismatchedBlockedOutcome.isError).toBe(true);
    expect(parseToolResult(mismatchedBlockedOutcome).error.code).toBe("INVALID_INPUT");

    const mismatchedSkippedOutcome = await client.callTool({
      name: "tyrant_record_event",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "skill-skipped-wrong-outcome-001",
        event_type: "skill_skipped",
        skill_id: "security-audit",
        outcome: "blocked",
        summary: "The skipped event must keep a skipped outcome",
      },
    });
    expect(mismatchedSkippedOutcome.isError).toBe(true);
    expect(parseToolResult(mismatchedSkippedOutcome).error.code).toBe("INVALID_INPUT");
    const validEvents = [
      { event_type: "skill_loaded", skill_id: "matt-tdd", outcome: "success", evidence_refs: ["host://session/skill-loaded/1"] },
      { event_type: "skill_used", skill_id: "matt-tdd", outcome: "success", evidence_refs: ["host://session/skill-used/1"] },
      { event_type: "skill_completed", skill_id: "matt-tdd", outcome: "success", evidence_refs: ["host://session/skill-completed/1"] },
      { event_type: "skill_blocked", skill_id: "design-taste-frontend", outcome: "blocked", evidence_refs: [] },
      { event_type: "skill_skipped", skill_id: "security-audit", outcome: "skipped", evidence_refs: [] },
    ];
    for (const [index, event] of validEvents.entries()) {
      const result = await client.callTool({
        name: "tyrant_record_event",
        arguments: {
          schema_version: 1,
          task_id: taskId,
          request_id: `skill-lifecycle-${index}`,
          ...event,
          summary: index < 3 ? `Host-confirmed ${event.event_type}` : `Reason for ${event.event_type}`,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result).event.event_type).toBe(event.event_type);
    }

    const missingSkillId = await client.callTool({
      name: "tyrant_record_event",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "skill-blocked-without-id-001",
        event_type: "skill_blocked",
        outcome: "blocked",
        summary: "No skill was selected",
      },
    });
    expect(missingSkillId.isError).toBe(true);
    expect(parseToolResult(missingSkillId).error.code).toBe("INVALID_INPUT");

    const state = parseToolResult(await client.callTool({
      name: "tyrant_get_task",
      arguments: { schema_version: 1, task_id: taskId },
    }));
    const skillEvents = state.events.filter((event: any) => String(event.event_type).startsWith("skill_"));
    expect(skillEvents.map((event: any) => event.event_type).sort()).toEqual([
      "skill_blocked",
      "skill_completed",
      "skill_loaded",
      "skill_skipped",
      "skill_used",
    ]);
    expect(skillEvents.find((event: any) => event.event_type === "skill_blocked")).toMatchObject({
      skill_id: "design-taste-frontend",
      outcome: "blocked",
      summary: "Reason for skill_blocked",
      evidence_refs: [],
    });
    expect(skillEvents.find((event: any) => event.event_type === "skill_skipped")).toMatchObject({
      skill_id: "security-audit",
      outcome: "skipped",
      summary: "Reason for skill_skipped",
      evidence_refs: [],
    });
    expect(skillEvents.find((event: any) => event.event_type === "skill_used")?.evidence_refs).toEqual([
      "host://session/skill-used/1",
    ]);
  } finally {
    await close();
  }
});
test("frontend and security requests add their relevant skill routes", async () => {
  const { client, close } = await openClient(projectA);
  try {
    const prepared = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: {
        schema_version: 1,
        task: "Build a React frontend UI and explain a security risk in dependency updates",
        request_id: "prepare-specialists-001",
      },
    }));
    expect(prepared.route.specialists.map((skill: any) => [skill.skill_id, skill.required])).toEqual([["matt-tdd", true], ["design-taste-frontend", true], ["security-audit", false], ["matt-code-review", false]]);
    expect(prepared.route.specialists.find((skill: any) => skill.skill_id === "security-audit")).toMatchObject({ status: "recommended", mode: "guidance" });
  } finally {
    await close();
  }
});

test("explicit audit preparation gives the host a source-only next action", async () => {
  const { client, close } = await openClient(projectB);
  try {
    const prepared = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: {
        schema_version: 1,
        task: "Perform a full security audit of this project",
        request_id: "prepare-source-only-security-audit-001",
      },
    }));

    expect(prepared.route.security_audit).toMatchObject({
      mode: "full_audit",
      source_review: "allowed",
      target_execution: "blocked",
    });
    expect(prepared.next_action.toLocaleLowerCase()).toContain("source-only");
    expect(prepared.next_action.toLocaleLowerCase()).toContain("sandbox");
    expect(prepared.next_action).toContain("needs_validation");
    expect(prepared.route.specialists.find((item: any) => item.skill_id === "security-audit")).toMatchObject({
      required: true,
      status: "recommended",
      host_availability: "unknown",
    });
  } finally {
    await close();
  }
});

test("provider blockers do not hide the sandbox boundary for an audit plus code change", async () => {
  const { client, close } = await openClient(projectA);
  try {
    const prepared = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: {
        schema_version: 1,
        task: "Perform a full security audit of this project and fix confirmed vulnerabilities",
        request_id: "prepare-audit-and-fix-provider-gap-001",
      },
    }));

    expect(prepared.blockers.map((item: any) => item.provider)).toEqual(["ai-memory", "graphify"]);
    expect(prepared.next_action).toContain("Continue only with read-only or provider setup work");
    expect(prepared.next_action).toContain("until ai-memory and graphify are ready");
    expect(prepared.next_action.toLocaleLowerCase()).toContain("source-only");
    expect(prepared.next_action.toLocaleLowerCase()).toContain("sandbox");
    expect(prepared.next_action).toContain("needs_validation");
    expect(prepared.next_action).toContain("Never mark an unrun phase passed");
  } finally {
    await close();
  }
});

test("the mutation quota rejects new writes without partially changing task state", async () => {
  const { client, close } = await openClient(projectA, quotaStateDirectory);
  try {
    const prepared = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Exercise the local state quota", request_id: "quota-prepare-001" },
    }));
    const database = new Database(join(quotaStateDirectory, "tyrant.sqlite3"));
    database.exec(`
      WITH RECURSIVE numbers(n) AS (
        VALUES(1)
        UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000
      )
      INSERT INTO idempotency(scope, request_id, payload_hash, response_json, created_at)
      SELECT 'quota-fixture', 'fixture-' || n, 'fixture-hash', '{}', '2026-01-01T00:00:00.000Z'
      FROM numbers;
    `);
    database.close();

    const checkpoint = await client.callTool({
      name: "tyrant_checkpoint",
      arguments: {
        schema_version: 1,
        task_id: prepared.task.id,
        request_id: "quota-checkpoint-001",
        phase: "quota",
        last_reliable_step: "Prepared the task",
        next_action: "Should not persist at the quota",
      },
    });
    expect(checkpoint.isError).toBe(true);
    const resultText = checkpoint.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    expect(resultText).toContain("STATE_QUOTA_REACHED");

    const state = parseToolResult(await client.callTool({
      name: "tyrant_get_task",
      arguments: { schema_version: 1, task_id: prepared.task.id },
    }));
    expect(state.checkpoint.phase).toBe("preflight");
    expect(state.checkpoint.next_action).not.toBe("Should not persist at the quota");
  } finally {
    await close();
  }
});

test("common credentials and bearer tokens are redacted from every persisted text surface", async () => {
  const { client, close } = await openClient(projectA);
  const secrets = [
    "sk-proj-123456789012345678901234",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "verysecret123456",
    "AKIAABCDEFGHIJKLMNOP",
    "pass@example.com",
    "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    "redisUserSecret",
  ];
  try {
    const prepared = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: {
        schema_version: 1,
        task: `Open project with OPENAI_API_KEY=${secrets[0]}`,
        request_id: secrets[2],
      },
    }));
    const taskId = prepared.task.id as string;

    await client.callTool({
      name: "tyrant_checkpoint",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "redact-checkpoint-001",
        phase: "auth token=verysecret123456",
        last_reliable_step: `Read Authorization: Bearer ${secrets[1]}`,
        next_action: `Rotate password=${secrets[3]}`,
        blocker: `client_secret=${secrets[3]}`,
        changed_files: [`secrets/${secrets[2]}.txt`],
        evidence_refs: [
          `postgresql://user:${secrets[5]}/project`,
          `redis://${secrets[7]}@cache.example.test/0`,
        ],
      },
    });
    await client.callTool({
      name: "tyrant_record_event",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "redact-event-001",
        event_type: "skill_used",
        skill_id: `token=${secrets[3]}`,
        summary: `Found ${secrets[4]} and AWS_SECRET_ACCESS_KEY=${secrets[6]} in a fixture`,
        evidence_refs: [`Authorization: Basic ${secrets[1]}`],
      },
    });
    await client.callTool({
      name: "tyrant_record_evidence",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "redact-evidence-001",
        check_id: `x-api-key=${secrets[3]}`,
        status: "blocked",
        summary: `The log contained password=${secrets[3]}`,
        evidence_ref: `mongodb+srv://user:${secrets[5]}/evidence`,
      },
    });
    await client.callTool({
      name: "tyrant_finish_task",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "redact-finish-001",
        status: "blocked",
        summary: `Found credential ${secrets[0]}`,
        next_action: `Rotate credentials outside Tyrant; then clear password=${secrets[3]}`,
      },
    });

    const state = parseToolResult(await client.callTool({
      name: "tyrant_get_task",
      arguments: { schema_version: 1, task_id: taskId },
    }));
    const database = new Database(join(stateDirectory, "tyrant.sqlite3"));
    const persistedRows = ["tasks", "checkpoints", "events", "evidence", "idempotency"]
      .map((table) => database.query(`SELECT * FROM ${table}`).all());
    database.close();
    const persisted = JSON.stringify({ state, persistedRows });
    for (const secret of secrets) expect(persisted).not.toContain(secret);
    expect(persisted).toContain("[REDACTED");
  } finally {
    await close();
  }
});

test("invalid tool input returns a bounded MCP error without leaking stack details", async () => {
  const { client, close } = await openClient(projectA);
  try {
    const result = await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: " ", request_id: "invalid-001" },
    });
    expect(result.isError).toBe(true);
    const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    expect(text.length).toBeLessThan(600);
    expect(text).not.toMatch(/stack|SELECT|\.sqlite|node_modules/i);

    const oversized = await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "x".repeat(8_001), request_id: "invalid-oversized-001" },
    });
    expect(oversized.isError).toBe(true);
    const oversizedText = oversized.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    expect(oversizedText.length).toBeLessThan(600);
    expect(oversizedText).not.toMatch(/stack|SELECT|\.sqlite|node_modules/i);
  } finally {
    await close();
  }
});
test("task transitions are explicit, retry-safe, logged, and completed is terminal", async () => {
  const { client, close } = await openClient(projectA);
  try {
    const prepared = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Describe the current project architecture", request_id: "transition-prepare-001" },
    }));
    const taskId = prepared.task.id as string;
    expect(prepared.task.lifecycle_state).toBe("planned");

    const startInput = {
      schema_version: 1,
      task_id: taskId,
      request_id: "transition-start-001",
      next_state: "in_progress",
      actor: "codex",
      host_id: "codex-cli",
      session_id: "session-alpha",
      reason: "Begin the requested investigation",
    };
    const started = parseToolResult(await client.callTool({ name: "tyrant_transition_task", arguments: startInput }));
    const replay = parseToolResult(await client.callTool({ name: "tyrant_transition_task", arguments: startInput }));
    expect(started.task.lifecycle_state).toBe("in_progress");
    expect(replay.event.id).toBe(started.event.id);
    expect(started.event).toMatchObject({
      event_type: "task_state_changed",
      previous_state: "planned",
      new_state: "in_progress",
      actor: "codex",
      host_id: "codex-cli",
      session_id: "session-alpha",
      summary: "Begin the requested investigation",
    });

    const verifying = parseToolResult(await client.callTool({
      name: "tyrant_transition_task",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "transition-verifying-001",
        next_state: "verifying",
        reason: "Implementation is ready for checks",
      },
    }));
    expect(verifying.task.lifecycle_state).toBe("verifying");

    const completed = parseToolResult(await client.callTool({
      name: "tyrant_finish_task",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "transition-finish-001",
        status: "completed",
        summary: "The requested investigation is complete",
      },
    }));
    expect(completed.task.lifecycle_state).toBe("completed");

    const illegal = await client.callTool({
      name: "tyrant_transition_task",
      arguments: { ...startInput, request_id: "transition-after-complete-001", next_state: "in_progress" },
    });
    expect(illegal.isError).toBe(true);
    expect(parseToolResult(illegal).error.code).toBe("INVALID_STATE");

    const state = parseToolResult(await client.callTool({
      name: "tyrant_get_task",
      arguments: { schema_version: 1, task_id: taskId },
    }));
    expect(state.events.filter((event: any) => event.event_type === "task_state_changed")).toHaveLength(2);
  } finally {
    await close();
  }
});

test("checkpoint preserves bounded intent, plans, checks, provider refs, and host identity", async () => {
  const { client, close } = await openClient(projectA);
  try {
    const prepared = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Describe project continuity", request_id: "rich-checkpoint-prepare-001" },
    }));
    const taskId = prepared.task.id as string;
    const checkpoint = parseToolResult(await client.callTool({
      name: "tyrant_checkpoint",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "rich-checkpoint-001",
        phase: "verification",
        last_reliable_step: "The public contract is understood",
        next_action: "Run focused lifecycle checks",
        intent: "Preserve enough context for the next model",
        constraints: ["Keep ai-memory and Graphify separate"],
        non_goals: ["Do not persist transcripts"],
        plan_progress: ["Lifecycle tests pass"],
        checks: [{ check_id: "typecheck", status: "not_run", summary: "Not run yet" }],
        ai_memory_refs: ["memory://workspace/project/page-1"],
        graphify_refs: [],
        host_id: "codex-cli",
        session_id: "session-beta",
      },
    }));
    expect(checkpoint.checkpoint).toMatchObject({
      intent: "Preserve enough context for the next model",
      constraints: ["Keep ai-memory and Graphify separate"],
      non_goals: ["Do not persist transcripts"],
      plan_progress: ["Lifecycle tests pass"],
      checks: [{ check_id: "typecheck", status: "not_run", summary: "Not run yet" }],
      ai_memory_refs: ["memory://workspace/project/page-1"],
      graphify_refs: [],
      host_id: "codex-cli",
      session_id: "session-beta",
    });
  } finally {
    await close();
  }
});

test("records needs_validation for audit checks and evidence", async () => {
  const { client, close } = await openClient(projectB);
  try {
    const prepared = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Track an audit validation gap", request_id: "needs-validation-prepare-001" },
    }));
    const taskId = prepared.task.id as string;
    const evidenceResult = await client.callTool({
      name: "tyrant_record_evidence",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "needs-validation-evidence-001",
        check_id: "sandbox-validation",
        status: "needs_validation",
        summary: "Runtime behavior needs an OS-enforced sandbox to validate",
        evidence_ref: "source://src/handler.ts#L24",
      },
    });
    expect(evidenceResult.isError).toBeFalsy();
    const evidence = parseToolResult(evidenceResult);
    expect(evidence.evidence).toMatchObject({
      check_id: "sandbox-validation",
      status: "needs_validation",
      evidence_ref: "source://src/handler.ts#L24",
    });
    expect(evidence.event).toMatchObject({ event_type: "evidence_recorded", outcome: "incomplete" });

    const checkpoint = parseToolResult(await client.callTool({
      name: "tyrant_checkpoint",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "needs-validation-checkpoint-001",
        phase: "security_audit",
        last_reliable_step: "Inspected the source boundary",
        next_action: "Validate the runtime condition in a sandbox",
        changed_files: [],
        evidence_refs: [],
        constraints: [],
        non_goals: [],
        plan_progress: [],
        checks: [{ check_id: "sandbox-validation", status: "needs_validation", summary: "Sandbox unavailable" }],
        ai_memory_refs: [],
        graphify_refs: [],
      },
    }));
    expect(checkpoint.checkpoint.checks).toEqual([
      { check_id: "sandbox-validation", status: "needs_validation", summary: "Sandbox unavailable" },
    ]);

    const invalid = await client.callTool({
      name: "tyrant_record_evidence",
      arguments: {
        schema_version: 1,
        task_id: taskId,
        request_id: "needs-validation-invalid-001",
        check_id: "invalid-status",
        status: "unknown_status",
        summary: "Unknown values remain invalid",
      },
    });
    expect(invalid.isError).toBe(true);
  } finally {
    await close();
  }
});



test("prepare loads ai-memory, stores only references, and leaves Graphify as its own gate", async () => {
  const calls: Array<{ kind: string; input: Record<string, unknown> }> = [];
  const aiMemory = {
    async loadContext(input: Record<string, unknown>) {
      calls.push({ kind: "load", input });
      return { status: "ready", context: "[historical_untrusted] A prior project decision.", references: ["ai-memory:page:history-1"], handoffStatus: "none" };
    },
    async syncOutcome(input: Record<string, unknown>) {
      calls.push({ kind: "sync", input });
      return { status: "synced", pageRef: "ai-memory:page:outcome-1", handoffStatus: "created", handoffId: "handoff-1" };
    },
  };
  const { client, close } = await openClient(projectA, stateDirectory, aiMemory);
  try {
    const prepared = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Implement a project change", request_id: "memory-prepare-001", host_id: "codex-cli", session_id: "session-memory-1" },
    }));
    expect(calls[0]).toMatchObject({ kind: "load", input: { resume: false, sessionId: "session-memory-1" } });
    expect(prepared.memory_context).toMatchObject({ status: "ready", references: ["ai-memory:page:history-1"] });
    expect(prepared.checkpoint.ai_memory_refs).toEqual(["ai-memory:page:history-1"]);
    expect(prepared.route.required_context.find((item: any) => item.provider === "ai-memory")).toMatchObject({ status: "available" });
    expect(prepared.route.provider_gaps.map((gap: any) => gap.provider)).toEqual(["graphify"]);
    expect(prepared.task.ai_memory.context_status).toBe("ready");
    expect(prepared.events.some((event: any) => event.event_type === "memory_context_loaded")).toBe(true);

    const finished = parseToolResult(await client.callTool({
      name: "tyrant_finish_task",
      arguments: { schema_version: 1, task_id: prepared.task.id, request_id: "memory-finish-001", status: "handoff", summary: "Pause with a clear next step", next_action: "Continue after Graphify is ready", session_id: "session-memory-1" },
    }));
    expect(calls.find((call) => call.kind === "sync")?.input).toMatchObject({ taskId: prepared.task.id, lifecycleState: "handoff" });
    expect(finished.ai_memory_sync).toMatchObject({ status: "synced", handoffId: "handoff-1" });
    expect(finished.task.ai_memory).toMatchObject({ sync_status: "synced", handoff_status: "created", handoff_id: "handoff-1" });
    await client.callTool({
      name: "tyrant_finish_task",
      arguments: { schema_version: 1, task_id: prepared.task.id, request_id: "memory-finish-001", status: "handoff", summary: "Pause with a clear next step", next_action: "Continue after Graphify is ready", session_id: "session-memory-1" },
    });
    expect(calls.filter((call) => call.kind === "sync")[1]?.input).toMatchObject({ priorHandoffStatus: "created", priorHandoffId: "handoff-1" });
  } finally {
    await close();
  }
});

test("explicit memory retry updates continuity without replaying a task transition", async () => {
  let syncCalls = 0;
  const aiMemory = {
    async loadContext() { return { status: "unavailable", context: "", references: [], handoffStatus: "not_checked", errorCode: "scope_missing" }; },
    async syncOutcome() {
      syncCalls += 1;
      return syncCalls === 1
        ? { status: "incomplete", handoffStatus: "uncertain", errorCode: "provider_error" }
        : { status: "synced", pageRef: "ai-memory:page:fixed", handoffStatus: "existing", handoffId: "handoff-existing" };
    },
  };
  const { client, close } = await openClient(projectA, stateDirectory, aiMemory);
  try {
    const prepared = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Resume a blocked implementation", request_id: "memory-retry-prepare-001" },
    }));
    const first = parseToolResult(await client.callTool({
      name: "tyrant_finish_task",
      arguments: { schema_version: 1, task_id: prepared.task.id, request_id: "memory-retry-finish-001", status: "handoff", summary: "Waiting for project context", next_action: "Retry memory synchronization" },
    }));
    expect(first.task.lifecycle_state).toBe("handoff");
    expect(first.task.ai_memory.sync_status).toBe("uncertain");
    const retried = parseToolResult(await client.callTool({
      name: "tyrant_sync_memory",
      arguments: { schema_version: 1, task_id: prepared.task.id, request_id: "memory-retry-001" },
    }));
    expect(retried.task.lifecycle_state).toBe("handoff");
    expect(retried.task.ai_memory).toMatchObject({ sync_status: "synced", handoff_status: "existing", handoff_id: "handoff-existing" });
    expect(syncCalls).toBe(2);
    const reread = parseToolResult(await client.callTool({ name: "tyrant_get_task", arguments: { schema_version: 1, task_id: prepared.task.id } }));
    expect(reread.events.filter((event: any) => event.event_type === "task_state_changed")).toHaveLength(0);
  } finally {
    await close();
  }
});

test("failed ai-memory RPC operation is durable in task state and the event log", async () => {
  const aiMemory = {
    async loadContext() {
      return { status: "ready", context: "", references: [], handoffStatus: "none" };
    },
    async syncOutcome() {
      return {
        status: "incomplete", handoffStatus: "not_required",
        errorCode: "rpc_n32602", failedOperation: "memory_write_page",
      };
    },
  };
  const graphify = {
    async loadContext() {
      return { status: "ready", mapStatus: "current", context: "Current-code map ready.", references: [] };
    },
  };
  const { client, close } = await openClient(projectB, stateDirectory, aiMemory, graphify);
  try {
    const prepared = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Add provider sync diagnostics", request_id: "memory-error-step-prepare-001" },
    }));
    const finished = parseToolResult(await client.callTool({
      name: "tyrant_finish_task",
      arguments: {
        schema_version: 1, task_id: prepared.task.id, request_id: "memory-error-step-finish-001",
        status: "completed", summary: "Record the AI Memory outcome",
      },
    }));
    expect(finished.ai_memory_sync).toMatchObject({
      status: "incomplete", errorCode: "rpc_n32602", failedOperation: "memory_write_page",
    });
    expect(finished.task.ai_memory).toMatchObject({
      sync_status: "incomplete", error_code: "rpc_n32602", error_step: "memory_write_page",
    });

    const retried = parseToolResult(await client.callTool({
      name: "tyrant_sync_memory",
      arguments: { schema_version: 1, task_id: prepared.task.id, request_id: "memory-error-step-retry-001" },
    }));
    expect(retried.ai_memory_sync).toMatchObject({
      status: "incomplete", errorCode: "rpc_n32602", failedOperation: "memory_write_page",
    });
    expect(retried.task.lifecycle_state).toBe("completed");
    expect(retried.task.ai_memory.error_step).toBe("memory_write_page");

    const reread = parseToolResult(await client.callTool({
      name: "tyrant_get_task",
      arguments: { schema_version: 1, task_id: prepared.task.id },
    }));
    const failureEvent = reread.events.find((event: any) => event.event_type === "memory_sync_failed");
    expect(failureEvent.summary).toContain("rpc_n32602");
    expect(failureEvent.summary).toContain("memory_write_page");
  } finally {
    await close();
  }
});

test("automatic preparation reuses the active task for one host session before loading providers", async () => {
  const memoryCalls: Array<{ taskId?: string; summary: string; resume: boolean; sessionId?: string }> = [];
  const aiMemory = {
    async loadContext(input: { taskId?: string; summary: string; resume: boolean; sessionId?: string }) {
      memoryCalls.push(input);
      return { status: "ready", context: "Prior project decisions", references: ["ai-memory:page:project"], handoffStatus: "none" };
    },
    async syncOutcome() { return { status: "synced", handoffStatus: "not_required" }; },
  };
  const graphify = {
    async loadContext() { return { status: "ready", mapStatus: "current", context: "Current code map", references: ["graphify:graph:current"] }; },
  };
  const { client, close } = await openClient(autoSessionProject, stateDirectory, aiMemory, graphify);
  try {
    const first = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: {
        schema_version: 1, task: "Build a list endpoint", request_id: "auto-session-first-001",
        host_id: "codex", session_id: "session-auto-001", resume_session: true,
      },
    }));
    const second = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: {
        schema_version: 1, task: "Add pagination to the list endpoint", request_id: "auto-session-second-001",
        host_id: "codex", session_id: "session-auto-001", resume_session: true,
      },
    }));

    expect(second.task.id).toBe(first.task.id);
    expect(memoryCalls).toEqual([
      { taskId: undefined, summary: "Build a list endpoint", resume: false, sessionId: "session-auto-001" },
      { taskId: first.task.id, summary: "Add pagination to the list endpoint", resume: true, sessionId: "session-auto-001" },
    ]);
    expect(second.events.filter((event: any) => event.event_type === "task_created")).toHaveLength(1);
    expect(second.checkpoint.session_id).toBe("session-auto-001");
  } finally {
    await close();
  }
});

test("an exact automatic first-prompt retry does not conflict after its task was created", async () => {
  let memoryLoadCount = 0;
  const aiMemory = {
    async loadContext() {
      memoryLoadCount += 1;
      return {
        status: "ready", context: "Prior project decisions",
        references: [memoryLoadCount === 1 ? "ai-memory:page:marker" : "ai-memory:path:tyrant/project.md"],
        handoffStatus: "none",
      };
    },
    async syncOutcome() { return { status: "synced", handoffStatus: "not_required" }; },
  };
  const graphify = {
    async loadContext() {
      return { status: "ready", mapStatus: "current", context: "Current code map", references: ["graphify:graph:current"] };
    },
  };
  const { client, close } = await openClient(autoRetryProject, stateDirectory, aiMemory, graphify);
  const request = {
    schema_version: 1, task: "Create the project list endpoint", request_id: "auto-first-prompt-retry-001",
    host_id: "codex", session_id: "session-auto-first-retry", resume_session: true,
  };
  try {
    const first = parseToolResult(await client.callTool({ name: "tyrant_prepare_task", arguments: request }));
    const retriedCall = await client.callTool({ name: "tyrant_prepare_task", arguments: request });

    expect(retriedCall.isError).toBeFalsy();
    const retry = parseToolResult(retriedCall);
    expect(retry.task.id).toBe(first.task.id);
    expect(retry.events.filter((event: any) => event.event_type === "task_created")).toHaveLength(1);
    expect(memoryLoadCount).toBe(2);
  } finally {
    await close();
  }
});

test("automatic preparation carries one claimed handoff and its local checkpoint into a fresh task", async () => {
  const memoryCalls: Array<{ taskId?: string; resume: boolean }> = [];
  const aiMemory = {
    async loadContext(input: { taskId?: string; resume: boolean }) {
      memoryCalls.push(input);
      return input.resume
        ? { status: "ready", context: "Prior handoff summary", references: ["ai-memory:handoff:handoff-auto"], handoffStatus: "claimed" }
        : { status: "ready", context: "Prior context", references: [], handoffStatus: "none" };
    },
    async syncOutcome() { return { status: "synced", handoffStatus: "created", handoffId: "handoff-auto" }; },
  };
  const graphify = {
    async loadContext() { return { status: "ready", mapStatus: "current", context: "Current code map", references: [] }; },
  };
  const { client, close } = await openClient(autoHandoffProject, stateDirectory, aiMemory, graphify);
  try {
    const first = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: {
        schema_version: 1, task: "Implement the first change", request_id: "auto-session-handoff-first",
        host_id: "codex", session_id: "session-auto-handoff", resume_session: true,
      },
    }));
    await client.callTool({
      name: "tyrant_checkpoint",
      arguments: {
        schema_version: 1, task_id: first.task.id, request_id: "auto-session-handoff-checkpoint",
        phase: "implementation", last_reliable_step: "Added the list route", next_action: "Add pagination tests",
        changed_files: ["src/routes/list.ts"], evidence_refs: ["test://list-route"],
      },
    });
    await client.callTool({
      name: "tyrant_finish_task",
      arguments: {
        schema_version: 1, task_id: first.task.id, request_id: "auto-session-handoff-finish",
        status: "handoff", summary: "Pause the first change", next_action: "Continue in a new task",
        host_id: "codex", session_id: "session-auto-handoff",
      },
    });
    const second = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: {
        schema_version: 1, task: "Start a separate follow-up", request_id: "auto-session-handoff-second",
        host_id: "codex", session_id: "session-auto-handoff-new", resume_session: true,
      },
    }));
    const source = parseToolResult(await client.callTool({
      name: "tyrant_get_task", arguments: { schema_version: 1, task_id: first.task.id },
    }));

    expect(second.task.id).not.toBe(first.task.id);
    expect(second.task.lifecycle_state).toBe("planned");
    expect(memoryCalls.at(-1)).toMatchObject({ taskId: first.task.id, resume: true, sessionId: "session-auto-handoff-new" });
    expect(second.memory_context).toMatchObject({ status: "ready", handoffStatus: "claimed" });
    expect(second.resume_context).toMatchObject({
      source_task_id: first.task.id,
      checkpoint: {
        phase: "implementation", last_reliable_step: "Added the list route",
        next_action: "Add pagination tests", changed_files: ["src/routes/list.ts"], evidence_refs: ["test://list-route"],
      },
    });
    expect(source.events.some((event: any) => event.event_type === "memory_handoff_claimed" && event.evidence_refs.includes(`tyrant-task:${second.task.id}`))).toBe(true);
  } finally {
    await close();
  }
});

test("automatic preparation blocks when multiple unclaimed handoffs make resume ambiguous", async () => {
  let resumeCalls = 0;
  const aiMemory = {
    async loadContext(input: { resume: boolean }) {
      if (input.resume) resumeCalls += 1;
      return { status: "ready", context: "Prior context", references: [], handoffStatus: input.resume ? "claimed" : "none" };
    },
    async syncOutcome() { return { status: "synced", handoffStatus: "created", handoffId: "handoff-ambiguous" }; },
  };
  const graphify = {
    async loadContext() { return { status: "ready", mapStatus: "current", context: "Current code map", references: [] }; },
  };
  const { client, close } = await openClient(autoAmbiguousProject, stateDirectory, aiMemory, graphify);
  try {
    for (let index = 0; index < 2; index += 1) {
      const prepared = parseToolResult(await client.callTool({
        name: "tyrant_prepare_task",
        arguments: { schema_version: 1, task: `Create handoff ${index}`, request_id: `ambiguous-source-${index}`, host_id: "codex", session_id: `ambiguous-session-${index}` },
      }));
      await client.callTool({ name: "tyrant_finish_task", arguments: {
        schema_version: 1, task_id: prepared.task.id, request_id: `ambiguous-finish-${index}`,
        status: "handoff", summary: `Pause task ${index}`, next_action: "Continue later",
      } });
    }
    const fresh = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: { schema_version: 1, task: "Continue project work", request_id: "ambiguous-fresh-session", host_id: "codex", session_id: "ambiguous-session-new", resume_session: true },
    }));
    expect(fresh.memory_context).toMatchObject({ status: "incomplete", handoffStatus: "ambiguous", errorCode: "handoff_ambiguous" });
    expect(fresh.route.code_change_gate.status).toBe("blocked");
    expect(resumeCalls).toBe(0);
  } finally {
    await close();
  }
});

test("a fresh host session automatically retries an incomplete local handoff sync before claiming it", async () => {
  const handoffProject = join(sandbox, "project-handoff-sync-retry");
  const handoffState = join(sandbox, "state-handoff-sync-retry");
  await Promise.all([mkdir(handoffProject), mkdir(handoffState)]);
  let syncCalls = 0;
  const memoryResumeCalls: string[] = [];
  const aiMemory = {
    async loadContext(input: { taskId?: string; resume: boolean }) {
      if (input.resume && input.taskId) memoryResumeCalls.push(input.taskId);
      return input.resume
        ? { status: "ready", context: "Recovered handoff", references: ["ai-memory:handoff:retry-handoff"], handoffStatus: "claimed" }
        : { status: "ready", context: "Project history", references: [], handoffStatus: "none" };
    },
    async syncOutcome() {
      syncCalls += 1;
      return syncCalls === 1
        ? { status: "incomplete", handoffStatus: "uncertain", errorCode: "provider_timeout" }
        : { status: "synced", handoffStatus: "created", handoffId: "retry-handoff" };
    },
  };
  const graphify = {
    async loadContext() { return { status: "ready", mapStatus: "current", context: "Current code map", references: [] }; },
  };
  const { client, close } = await openClient(handoffProject, handoffState, aiMemory, graphify);
  try {
    const first = parseToolResult(await client.callTool({ name: "tyrant_prepare_task", arguments: {
      schema_version: 1, task: "Implement the first part", request_id: "sync-retry-source", host_id: "codex", session_id: "sync-retry-old",
    } }));
    const finish = parseToolResult(await client.callTool({ name: "tyrant_finish_task", arguments: {
      schema_version: 1, task_id: first.task.id, request_id: "sync-retry-finish", status: "handoff",
      summary: "Paused before database integration", next_action: "Continue database integration",
    } }));
    expect(finish.task.ai_memory.sync_status).toBe("uncertain");

    const second = parseToolResult(await client.callTool({ name: "tyrant_prepare_task", arguments: {
      schema_version: 1, task: "Continue database integration", request_id: "sync-retry-new-session",
      host_id: "codex", session_id: "sync-retry-new", resume_session: true,
    } }));

    expect(syncCalls).toBe(2);
    expect(memoryResumeCalls).toEqual([first.task.id]);
    expect(second.task.id).not.toBe(first.task.id);
    expect(second.memory_context).toMatchObject({ status: "ready", handoffStatus: "claimed" });
    expect(second.resume_context.source_task_id).toBe(first.task.id);
  } finally {
    await close();
  }
});

test("task lookup by host and session never falls back to another session's latest task", async () => {
  const { client, close } = await openClient(projectA);
  try {
    const prepared = parseToolResult(await client.callTool({
      name: "tyrant_prepare_task",
      arguments: {
        schema_version: 1, task: "Task for one session", request_id: "session-lookup-prepare",
        host_id: "claude-code", session_id: "session-lookup-one",
      },
    }));
    const found = parseToolResult(await client.callTool({
      name: "tyrant_get_task",
      arguments: { schema_version: 1, host_id: "claude-code", session_id: "session-lookup-one" },
    }));
    const missing = await client.callTool({
      name: "tyrant_get_task",
      arguments: { schema_version: 1, host_id: "claude-code", session_id: "session-lookup-other" },
    });

    expect(found.task.id).toBe(prepared.task.id);
    expect(missing.isError).toBe(true);
  } finally {
    await close();
  }
});





test("SPEC-03 database migration preserves legacy tasks, checkpoints, and events", () => {
  const previousState = process.env.TYRANT_STATE_DIR;
  const previousRoot = process.env.TYRANT_PROJECT_ROOT;
  process.env.TYRANT_STATE_DIR = legacyStateDirectory;
  process.env.TYRANT_PROJECT_ROOT = legacyProject;
  const projectPath = realpathSync(legacyProject);
  const normalizedPath = process.platform === "win32" ? projectPath.toLocaleLowerCase("en-US") : projectPath;
  const projectId = createHash("sha256").update(normalizedPath).digest("hex");
  const legacyDb = new Database(join(legacyStateDirectory, "tyrant.sqlite3"), { create: true, strict: true });
  try {
    legacyDb.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','blocked','completed','handoff')), route_json TEXT NOT NULL, blockers_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE checkpoints (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, phase TEXT NOT NULL, last_reliable_step TEXT NOT NULL, next_action TEXT NOT NULL, blocker TEXT, changed_files_json TEXT NOT NULL, evidence_refs_json TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, event_type TEXT NOT NULL, summary TEXT NOT NULL, skill_id TEXT, outcome TEXT, evidence_refs_json TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE evidence (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, check_id TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, evidence_ref TEXT, created_at TEXT NOT NULL); CREATE TABLE idempotency (scope TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope, request_id));");
    for (const status of ["active", "blocked", "handoff", "completed"]) {
      legacyDb.query("INSERT INTO tasks(id,project_id,task,status,route_json,blockers_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("legacy-" + status, projectId, "Legacy " + status, status, "{}", "[]", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    }
    legacyDb.query("INSERT INTO checkpoints(id,task_id,phase,last_reliable_step,next_action,blocker,changed_files_json,evidence_refs_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run("legacy-checkpoint", "legacy-active", "implementation", "Old reliable step", "Old next action", null, '["src/old.ts"]', '["test://old"]', "2026-01-01T00:01:00.000Z");
    legacyDb.query("INSERT INTO events(id,task_id,event_type,summary,skill_id,outcome,evidence_refs_json,created_at) VALUES(?,?,?,?,?,?,?,?)").run("legacy-event", "legacy-active", "checkpoint_saved", "Old checkpoint event", null, "success", "[]", "2026-01-01T00:02:00.000Z");
  } finally {
    legacyDb.close();
  }

  try {
    const store = new TyrantStore();
    try {
      expect(store.getTask("legacy-active").task.lifecycle_state).toBe("in_progress");
      expect(store.getTask("legacy-blocked").task.lifecycle_state).toBe("blocked");
      expect(store.getTask("legacy-handoff").task.lifecycle_state).toBe("handoff");
      expect(store.getTask("legacy-completed").task.lifecycle_state).toBe("completed");
      expect(store.getTask("legacy-active")).toMatchObject({
        task: { summary: "Legacy active", status: "active", ai_memory: { error_step: null } },
        checkpoint: { phase: "implementation", last_reliable_step: "Old reliable step", next_action: "Old next action", changed_files: ["src/old.ts"], evidence_refs: ["test://old"] },
      });
      expect(store.getTask("legacy-active").events).toContainEqual(expect.objectContaining({ id: "legacy-event", event_type: "checkpoint_saved", summary: "Old checkpoint event" }));
    } finally {
      store.close();
    }
  } finally {
    if (previousState === undefined) delete process.env.TYRANT_STATE_DIR;
    else process.env.TYRANT_STATE_DIR = previousState;
    if (previousRoot === undefined) delete process.env.TYRANT_PROJECT_ROOT;
    else process.env.TYRANT_PROJECT_ROOT = previousRoot;
  }
});
