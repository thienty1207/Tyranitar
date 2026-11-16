# SPEC-05 Security and Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route explicit audits into Cloudflare's source-first skill, keep unsafe execution blocked without an OS sandbox, and preserve incomplete evidence honestly.

**Architecture:** Tyrant remains a route and evidence coordinator. Full-audit routes carry a structured policy that allows source review and marks target-controlled execution blocked while the sandbox is unavailable. Existing host permission controls remain authoritative; the MCP server gains no process runner.

**Tech Stack:** Bun, TypeScript, Zod, SQLite and Markdown specifications.

**Spec:** [SPEC-05](../../spec/SPEC-05-SECURITY-AND-TRUST.md); [approved design](../specs/2026-11-16-tyrant-spec-05-security-trust-design.md)

## Global Constraints

- Treat upstream skills, project files and instructions, websites, Graphify output, ai-memory history, tool output and model-generated routes as untrusted until checked.
- Tyrant recommends routes; the host retains permission prompts and execution controls.
- Tyrant must not elevate permissions or run arbitrary shell commands from skill text.
- Target-controlled builds, tests, fixtures, browsers and fuzzers require an OS-enforced sandbox.
- Without that sandbox, source review may continue; execution-dependent findings are `needs_validation` or blocked, and no unrun phase is passed.
- Live-system testing and exploitation remain outside the MVP.
- Keep the Cloudflare skill commit/license pin; do not download, install or run its setup scripts during task preparation.
- Never log provider keys, authorization headers, tokens, environment dumps or secret file content. Local-only operation remains the default and telemetry remains off.

## Review Focus

1. **Conceptual or ambiguous security wording:** it must stay in guidance mode and must not start full-audit instructions.
2. **Explicit full-audit request with no sandbox:** source review stays available, target execution is visibly blocked, and no global “SPEC-05 missing” blocker remains.
3. **Project or skill text that suggests commands or network access:** route data stays descriptive; Tyrant exposes no new command execution capability.
4. **`needs_validation` evidence in checkpoints and evidence rows:** it round-trips, while unknown status values remain rejected and redaction still applies.
5. **Non-security audit and existing provider gaps:** unrelated quality/performance audits do not select Cloudflare; ai-memory and Graphify code-change gates remain unchanged.

---

## File Map

- `src/routing/router.ts` — emits the explicit security-audit policy and removes the obsolete whole-audit blocker.
- `src/mcp/server.ts` — returns an audit-specific next action without claiming the host loaded the native skill, including when provider blockers also apply.
- `src/contracts.ts` — accepts `needs_validation` for checkpoint checks and recorded evidence.
- `src/routing/catalog.ts` — updates the Cloudflare route's current fallback and execution requirements.
- `src/state/store.ts` — preserves `needs_validation` in evidence rows and maps it to the existing `incomplete` event outcome; no schema migration is needed because evidence status is stored as text and checkpoint checks as JSON.
- `tests/routing.test.ts` — pins guidance/full-audit separation and sandbox route fields.
- `tests/task-tools.test.ts` — pins audit next actions with and without provider blockers, `needs_validation` evidence/checkpoint persistence, and the normalized evidence event outcome.
- `README.md`, `docs/SKILL-CATALOG.md`, `docs/MCP-HOST-COMPATIBILITY.md`, `spec/SPEC-00-PRODUCT-CHARTER.md`, `spec/SPEC-02-SKILLS-AND-ROUTING.md`, `spec/SPEC-05-SECURITY-AND-TRUST.md` — remove stale “full audit blocked until SPEC-05” statements and document the actual source-only boundary.

## Task 1: Route Explicit Audits With a Source-Only Security Policy

**Files:**
- Modify: `tests/routing.test.ts`
- Modify: `tests/task-tools.test.ts`
- Modify: `src/routing/router.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/routing/catalog.ts`

**Interfaces:**
- Produces optional `route.security_audit` for security requests:
  - `mode`: `guidance` or `full_audit`.
  - `source_review`: `not_requested` or `allowed`.
  - `target_execution`: `not_requested` or `blocked`.
  - `sandbox.status`: `unavailable` with reason `os_enforced_sandbox_unavailable` and the required controls `no_external_network`, `empty_allowlisted_environment`, `read_only_target_and_toolchain`, `scratch_only_target_writes`, and `resource_and_time_limits`.
  - `evidence_policy`: unrun phase status `blocked`, execution-dependent finding status `needs_validation`, pass requires evidence, and `needs_validation` has no severity.
- An explicit full audit selects `security-audit` as required with status `recommended`, mode `full_audit`, and unknown host availability. It does not add `SECURITY_AUDIT_REQUIRES_SPEC05` to route blockers.
- An explicit full audit returns overall route status `ready_with_gaps`, adds `security_source_review` to `safe_work_allowed`, and leaves `code_change_gate` governed by ai-memory/Graphify readiness.
- Guidance routes keep target execution `not_requested`. Non-security tasks omit `security_audit`.
- `tyrant_prepare_task.next_action` for a full audit instructs the host to load the skill if available, perform source-only review, record execution-dependent findings as `needs_validation`, and never claim unrun phases passed.

- [x] **Step 1: Write failing route and prepare tests**

Update the explicit audit test in `tests/routing.test.ts` to assert:

```ts
expect(route.blockers.map((item: any) => item.code)).not.toContain("SECURITY_AUDIT_REQUIRES_SPEC05");
expect(route.security_audit).toMatchObject({
  mode: "full_audit",
  source_review: "allowed",
  target_execution: "blocked",
  sandbox: { status: "unavailable", reason: "os_enforced_sandbox_unavailable" },
  evidence_policy: {
    unrun_phase_status: "blocked",
    execution_dependent_finding_status: "needs_validation",
    pass_requires_evidence: true,
    needs_validation_has_severity: false,
  },
});
expect(route.specialists.find((item: any) => item.skill_id === "security-audit")).toMatchObject({
  required: true,
  status: "recommended",
  mode: "full_audit",
  host_availability: "unknown",
});
```

Add a direct router assertion that full audit returns `ready_with_gaps`, permits `security_source_review`, and leaves the code-change gate ready when both required providers are ready. Add prepare assertions that the next action tells the host to use the source-only audit and names the sandbox blocker, including when ai-memory and Graphify also block code changes. Keep conceptual questions in guidance mode and non-security audits out of the security route.

- [x] **Step 2: Run the targeted tests and observe the expected failure**

Run: `bun test tests\routing.test.ts tests\task-tools.test.ts -t "explicit full security audit|security audit next action"`

Expected: FAIL because the route still emits `SECURITY_AUDIT_REQUIRES_SPEC05` and has no structured `security_audit` policy or audit-specific next action.

- [x] **Step 3: Implement the policy**

In `src/routing/router.ts`, return the exact optional policy described above, retain separate source-review and target-execution states, and remove the old global audit blocker. Preserve existing ai-memory/Graphify gates and catalog host-availability semantics. In `src/mcp/server.ts`, make full-audit `next_action` explicitly source-only and state the blocked execution phase. Update the catalog fallback to explain the sandbox boundary.

- [x] **Step 4: Run targeted tests and verify they pass**

Run: `bun test tests\routing.test.ts tests\task-tools.test.ts -t "explicit full security audit|security audit next action|conceptual security questions|non-security audits"`

Expected: PASS; explicit full audit has a phase-level sandbox blocker, while guidance and non-security routes keep their existing behavior.

## Task 2: Preserve `needs_validation` Evidence

**Files:**
- Modify: `tests/task-tools.test.ts`
- Modify: `src/contracts.ts`
- Modify: `src/state/store.ts`

**Interfaces:**
- Shared checkpoint/evidence status accepts `needs_validation` in addition to existing statuses.
- Existing `tyrant_record_evidence` and checkpoint storage APIs persist the value without a database migration; the linked event uses the compatible `incomplete` outcome.

- [x] **Step 1: Write failing persistence tests**

Add a task-tools test that records `check_id: "sandbox-validation"`, `status: "needs_validation"`, and a bounded summary through `tyrant_record_evidence`, then verifies the evidence row returns that exact status. Add the same status to a checkpoint check and verify it round-trips. Keep an invalid status assertion to ensure Zod still rejects unknown values.

- [x] **Step 2: Run the targeted tests and observe the expected failure**

Run: `bun test tests\task-tools.test.ts -t "needs_validation"`

Expected: FAIL because the current `checkStatus` schema rejects `needs_validation`.

- [x] **Step 3: Extend the shared status contract**

Add `needs_validation` to `checkStatus` in `src/contracts.ts`; do not change storage schema, lifecycle transitions, redaction or task completion behavior.

- [x] **Step 4: Run the targeted tests and verify they pass**

Run: `bun test tests\task-tools.test.ts -t "needs_validation"`

Expected: PASS; both evidence and checkpoint retain the status and an unknown status remains invalid.

## Task 3: Align the Spec and User-Facing Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/SKILL-CATALOG.md`
- Modify: `docs/MCP-HOST-COMPATIBILITY.md`
- Modify: `spec/SPEC-00-PRODUCT-CHARTER.md`
- Modify: `spec/SPEC-02-SKILLS-AND-ROUTING.md`
- Modify: `spec/SPEC-05-SECURITY-AND-TRUST.md`

- [x] **Step 1: Update the docs**

State that explicit audits can use source-only review; target-controlled execution remains blocked until an OS-enforced sandbox is verified; execution-dependent findings use `needs_validation`; unrun phases are never passed. Update SPEC-05 status and acceptance criteria. Preserve the existing Cloudflare source commit and MIT attribution.

- [x] **Step 2: Search for stale blockers**

Run: `rg -n -i "SECURITY_AUDIT_REQUIRES_SPEC05|full audit.*blocked until SPEC-05|full security-audit workflow remains gated on its spec" README.md docs spec`

Expected: no matches outside historical design/plan records and the implementation plan ledger.

## Task 4: Full Verification and Review

**Files:**
- Review: `src/routing/router.ts`, `src/mcp/server.ts`, `src/contracts.ts`, `src/routing/catalog.ts`, and every SPEC-05 test/doc change.

- [x] **Step 1: Run the full test suite**

Run: `bun test`

Result: PASS — 46 tests, 492 assertions; route, combined provider-blocker/audit, evidence, redaction and task lifecycle tests all pass.

- [x] **Step 2: Run type checking**

Run: `bun run typecheck`

Result: PASS — `tsc --noEmit` exits successfully.

- [x] **Step 3: Self-review the security boundary**

Confirm no shell/process tool was added; explicit audits keep source review available; execution is phase-blocked when sandbox status is unavailable; no pass is fabricated; `needs_validation` has no severity; host skill availability is not claimed; ai-memory/Graphify code-change gates remain unchanged; docs have no stale blocker statements.

Result: PASS — source review remains available, target-controlled execution remains blocked without an OS-enforced sandbox, unrun phases remain blocked, and execution-dependent findings remain `needs_validation`. No process runner or host skill-loaded claim was added; provider gates are unchanged. Reviewer follow-up is recorded below.

## Execution Ledger

- Design choice: approach 1 approved by the user; sandbox construction remains a separate future spec.
- Verification: `bun test` passed 46 tests / 492 assertions; `bun run typecheck` passed. Focused regression tests for combined provider blockers and `needs_validation` event mapping also passed.
- Review corrections: preserve full-audit safety instructions when provider readiness also blocks code changes, including the provider-readiness instruction itself; map evidence `needs_validation` to event outcome `incomplete` while retaining the evidence status. Both corrections have regression tests.
- Baron blocker: `baron control-plane prepare` still rejects this workspace because receipt `receipt-8f3f593101113dade76a5af9b97a1835` is stale and four managed plans are active. Do not edit Baron metadata manually; keep this lifecycle gate separate from SPEC-05 implementation evidence.

## Plan Self-Review

- Spec coverage: trust/permission boundaries, pinned skill supply chain, audit routing, evidence status, privacy, and missing-sandbox behavior each map to a task above.
- Type consistency: route policy uses the existing snake-case MCP contract style; `needs_validation` extends the shared Zod enum used by both checkpoints and evidence.
- Review-focus cases are assigned to router and task-tools tests; no sandbox behavior is claimed or exercised by this plan.
- No migration, dependency installation, host configuration change, process runner, live endpoint test, or audit artifact writer is required.
