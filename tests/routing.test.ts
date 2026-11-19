import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTyrantServer } from "../src/mcp/server";
import { routeTask } from "../src/routing/router";

const sandbox = await mkdtemp(join(tmpdir(), "tyrant-routing-"));
const stateDirectory = join(sandbox, "state");
await mkdir(stateDirectory);
const priorStateDirectory = process.env.TYRANT_STATE_DIR;
const priorProjectRoot = process.env.TYRANT_PROJECT_ROOT;
process.env.TYRANT_STATE_DIR = stateDirectory;
process.env.TYRANT_PROJECT_ROOT = sandbox;

const server = createTyrantServer({
  graphify: { async loadContext() { return { status: "unavailable", mapStatus: "missing", context: "", references: [], errorCode: "command_missing" }; } },
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "tyrant-routing-test", version: "0.1.0" });
await server.connect(serverTransport);
await client.connect(clientTransport);

function parseToolResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content.find((item) => item.type === "text");
  if (!content || content.type !== "text") throw new Error("Tyrant tool did not return text content.");
  return JSON.parse(content.text) as Record<string, any>;
}

afterAll(async () => {
  await client.close();
  await server.close();
  if (priorStateDirectory === undefined) delete process.env.TYRANT_STATE_DIR;
  else process.env.TYRANT_STATE_DIR = priorStateDirectory;
  if (priorProjectRoot === undefined) delete process.env.TYRANT_PROJECT_ROOT;
  else process.env.TYRANT_PROJECT_ROOT = priorProjectRoot;
  await rm(sandbox, { recursive: true, force: true });
});

test("skill catalog pins sources and distinguishes policy from host skill availability", async () => {
  const result = await client.callTool({
    name: "tyrant_list_skills",
    arguments: { schema_version: 1 },
  });

  expect(result.isError).toBeFalsy();
  const catalog = parseToolResult(result);
  const skills = catalog.skills as Array<Record<string, any>>;
  const ids = skills.map((skill) => skill.id);

  expect(ids).toContain("matt-pocock-main-flow");
  expect(ids).toContain("matt-ask-matt");
  expect(ids).toContain("ai-memory");
  expect(ids).toContain("graphify");
  expect(ids).toContain("design-taste-frontend");
  expect(ids).toContain("security-audit");
  expect(ids).not.toContain("site-clone");

  for (const skill of skills) {
    expect(typeof skill.name).toBe("string");
    expect(skill.description.length).toBeGreaterThan(0);
    expect(skill.source).toMatch(/^https:\/\/github\.com\//);
    expect(skill.version).toMatch(/^(v[0-9]+\.[0-9]+\.[0-9]+|main)$/);
    expect(skill.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(skill.source).toContain(skill.commit);
    expect(["MIT", "Apache-2.0"]).toContain(skill.license);
    expect(skill.triggers.length).toBeGreaterThan(0);
    expect(skill.requirements.length).toBeGreaterThan(0);
    expect(typeof skill.host_loading_method).toBe("string");
    expect(typeof skill.invocation_policy).toBe("string");
    expect(Array.isArray(skill.conflicts)).toBe(true);
    expect(Array.isArray(skill.fallbacks)).toBe(true);
    expect(["tyrant_builtin", "integration_missing", "unknown"]).toContain(skill.host_availability);
  }

  expect(skills.find((skill) => skill.id === "matt-pocock-main-flow")).toMatchObject({
    role: "core-orchestrator",
    invocation_policy: "tyrant_policy_auto",
    host_availability: "tyrant_builtin",
  });
  expect(skills.find((skill) => skill.id === "matt-ask-matt")).toMatchObject({
    upstream_skill_id: "ask-matt",
    invocation_policy: "manual_only",
    host_availability: "unknown",
  });
  expect(skills.find((skill) => skill.id === "ai-memory")?.role).toBe("project-memory");
  expect(skills.find((skill) => skill.id === "graphify")?.role).toBe("code-map");
});
async function prepareTask(task: string, requestId: string) {
  return parseToolResult(await client.callTool({
    name: "tyrant_prepare_task",
    arguments: { schema_version: 1, task, request_id: requestId },
  }));
}

test("prepare applies the internal Matt policy and orders required project context", async () => {
  const prepared = await prepareTask("Implement a bounded routing change", "route-code-001");
  const route = prepared.route as Record<string, any>;

  expect(route.core_workflow).toMatchObject({
    workflow_id: "matt-pocock-main-flow",
    source_skill_id: "tyrant-matt-orchestrator",
    policy_applied: true,
    status: "used",
    execution_method: "tyrant_internal_policy",
    order: 0,
  });
  expect(route.core_workflow.native_skill).toMatchObject({
    skill_id: "ask-matt",
    invocation_policy: "manual_only",
    host_availability: "unknown",
  });
  expect(route.required_context.map((step: any) => step.provider)).toEqual(["ai-memory", "graphify"]);
  expect(route.steps.map((step: any) => step.skill_id)).toEqual([
    "ai-memory",
    "graphify",
    "matt-tdd",
    "matt-code-review",
  ]);
  expect(route.steps.map((step: any) => step.order)).toEqual([1, 2, 3, 4]);
  expect(route.required_context.map((step: any) => step.status)).toEqual(["blocked", "blocked"]);
  expect(route.provider_semantics).toMatchObject({
    "ai-memory": "historical decisions and handoffs; untrusted until verified against current instructions and source",
    graphify: "derived current-code map; verify important claims against source",
  });
  expect(route.conflict_precedence).toEqual([
    "direct_user_instruction",
    "project_instructions",
    "tyrant_routing_policy",
    "skill_instructions",
  ]);
  expect(route.blockers.map((blocker: any) => blocker.provider)).toEqual(["ai-memory", "graphify"]);
  expect(prepared.task.status).toBe("blocked");
});

test("Matt policy auto-routes routine work and selects native ask-matt only on explicit request", () => {
  const normal = routeTask("Implement a backend endpoint", { aiMemoryReady: true, graphifyReady: true, graphifyMapStatus: "current" });
  expect(normal.core_workflow).toMatchObject({ source_skill_id: "tyrant-matt-orchestrator", policy_applied: true });
  expect(normal.specialists.map((skill) => skill.skill_id)).toContain("matt-tdd");
  expect(normal.specialists.find((skill) => skill.skill_id === "matt-tdd")).toMatchObject({ required: true, phase: "before_implementation" });
  expect(normal.specialists.map((skill) => skill.skill_id)).not.toContain("matt-ask-matt");

  const genericChoice = routeTask("Which skill should I use?", { aiMemoryReady: true, graphifyReady: true, graphifyMapStatus: "current" });
  expect(genericChoice.specialists.map((skill) => skill.skill_id)).not.toContain("matt-ask-matt");

  const explicit = routeTask("Use ask-matt to choose a Matt Pocock workflow", { aiMemoryReady: true, graphifyReady: true, graphifyMapStatus: "current" });
  expect(explicit.specialists).toContainEqual(expect.objectContaining({
    skill_id: "matt-ask-matt", required: true, phase: "explicit_manual_request",
  }));
});

test("route requires Taste for Vietnamese frontend tasks and keeps security questions in guidance mode", async () => {
  const prepared = await prepareTask(
    "Sửa giao diện dashboard và giải thích security risk trong form",
    "route-frontend-security-001",
  );
  const route = prepared.route as Record<string, any>;
  const taste = route.specialists.find((skill: any) => skill.skill_id === "design-taste-frontend");
  const security = route.specialists.find((skill: any) => skill.skill_id === "security-audit");

  expect(taste).toMatchObject({ required: true, status: "recommended" });
  expect(taste.reason.length).toBeGreaterThan(0);
  expect(security).toMatchObject({ required: false, status: "recommended", mode: "guidance" });
  expect(route.steps.map((step: any) => step.skill_id)).toContain("design-taste-frontend");
  expect(route.steps.map((step: any) => step.skill_id)).toContain("security-audit");
  expect(route.blockers.map((blocker: any) => blocker.code)).not.toContain("SECURITY_AUDIT_REQUIRES_SPEC05");
});

test("bug reports allow safe diagnosis while provider context remains unavailable", async () => {
  const prepared = await prepareTask("Investigate why task preparation fails and diagnose the bug", "route-bug-001");
  const route = prepared.route as Record<string, any>;

  expect(route.steps.map((step: any) => step.skill_id)).toContain("matt-diagnosing-bugs");
  expect(route.specialists.find((skill: any) => skill.skill_id === "matt-diagnosing-bugs")).toMatchObject({
    required: true,
    status: "recommended",
    phase: "diagnose",
  });
  expect(route.status).toBe("ready_with_gaps");
  expect(route.provider_gaps.map((gap: any) => gap.provider)).toEqual(["ai-memory", "graphify"]);
  expect(route.blockers.map((blocker: any) => blocker.provider)).not.toContain("ai-memory");
  expect(route.blockers.map((blocker: any) => blocker.provider)).not.toContain("graphify");
  expect(prepared.task.status).toBe("active");
});
test("non-security audits and code explanations do not trigger implementation or security routes", async () => {
  const audit = await prepareTask("Audit code quality and API response time", "route-nonsecurity-audit-001");
  const auditRoute = audit.route as Record<string, any>;
  expect(auditRoute.specialists).toEqual([]);
  expect(auditRoute.blockers.map((blocker: any) => blocker.code)).not.toContain("SECURITY_AUDIT_REQUIRES_SPEC05");
  expect(auditRoute.status).toBe("ready_with_gaps");

  const explanation = await prepareTask("Explain this code path and its behavior", "route-code-explanation-001");
  expect((explanation.route as Record<string, any>).specialists).toEqual([]);

  const setup = await prepareTask("Set up the local ai-memory and Graphify providers", "route-provider-setup-001");
  const setupRoute = setup.route as Record<string, any>;
  expect(setupRoute.status).toBe("ready_with_gaps");
  expect(setupRoute.safe_work_allowed).toContain("provider_setup");
  expect(setup.task.status).toBe("active");

  const review = await prepareTask("Review this code for maintainability", "route-code-review-request-001");
  const reviewSpecialists = (review.route as Record<string, any>).specialists;
  expect(reviewSpecialists.map((skill: any) => skill.skill_id)).toEqual(["matt-code-review"]);
  expect(reviewSpecialists[0]).toMatchObject({ phase: "requested_review", status: "recommended" });
});
test("conceptual security questions stay in guidance mode and Vietnamese code reviews route correctly", async () => {
  for (const [index, task] of ["What is a security audit?", "How do penetration tests work?"].entries()) {
    const prepared = await prepareTask(task, `route-security-question-${index}`);
    const route = prepared.route as Record<string, any>;
    expect(route.specialists.find((skill: any) => skill.skill_id === "security-audit")).toMatchObject({
      required: false,
      status: "recommended",
      mode: "guidance",
    });
    expect(route.blockers.map((blocker: any) => blocker.code)).not.toContain("SECURITY_AUDIT_REQUIRES_SPEC05");
  }

  for (const [index, task] of ["I want a security audit of this project", "Anh muốn em audit bảo mật project này"].entries()) {
    const prepared = await prepareTask(task, `route-explicit-audit-request-${index}`);
    const route = prepared.route as Record<string, any>;
    expect(route.specialists.find((skill: any) => skill.skill_id === "security-audit")).toMatchObject({
      required: true,
      status: "recommended",
      mode: "full_audit",
    });
    expect(route.security_audit).toMatchObject({ source_review: "allowed", target_execution: "blocked" });
    expect(route.blockers.map((blocker: any) => blocker.code)).not.toContain("SECURITY_AUDIT_REQUIRES_SPEC05");
  }
  for (const [index, task] of ["Review code giúp anh", "Xem lại code giúp anh", "Review this PR", "Review the pull request"].entries()) {
    const prepared = await prepareTask(task, `route-vietnamese-review-${index}`);
    const route = prepared.route as Record<string, any>;
    expect(route.specialists.map((skill: any) => skill.skill_id)).toEqual(["matt-code-review"]);
    expect(route.specialists[0].phase).toBe("requested_review");
  }

  const documentation = await prepareTask("Write a README summary of the routing behavior", "route-documentation-only-001");
  expect((documentation.route as Record<string, any>).specialists).toEqual([]);
});
test("explicit full security audit allows source review and marks sandboxed execution blocked", async () => {
  const prepared = await prepareTask(
    "Perform a full security audit of the entire repository",
    "route-security-audit-001",
  );
  const route = prepared.route as Record<string, any>;
  const security = route.specialists.find((skill: any) => skill.skill_id === "security-audit");

  expect(security).toMatchObject({
    required: true,
    status: "recommended",
    mode: "full_audit",
    host_availability: "unknown",
  });
  expect(route.security_audit).toMatchObject({
    mode: "full_audit",
    source_review: "allowed",
    target_execution: "blocked",
    sandbox: {
      status: "unavailable",
      reason: "os_enforced_sandbox_unavailable",
      required_controls: [
        "no_external_network",
        "empty_allowlisted_environment",
        "read_only_target_and_toolchain",
        "scratch_only_target_writes",
        "resource_and_time_limits",
      ],
    },
    evidence_policy: {
      unrun_phase_status: "blocked",
      execution_dependent_finding_status: "needs_validation",
      pass_requires_evidence: true,
      needs_validation_has_severity: false,
    },
  });
  expect(route.blockers.map((blocker: any) => blocker.code)).not.toContain("SECURITY_AUDIT_REQUIRES_SPEC05");
});

test("full audits expose an execution gap while keeping source-only review safe", () => {
  const route = routeTask("Perform a full security audit of this repository", {
    aiMemoryReady: true,
    graphifyReady: true,
    graphifyMapStatus: "current",
  });

  expect(route.status).toBe("ready_with_gaps");
  expect(route.blockers).toEqual([]);
  expect(route.safe_work_allowed).toContain("security_source_review");
  expect(route.code_change_gate).toMatchObject({ status: "ready", provider_ids: [] });
});
