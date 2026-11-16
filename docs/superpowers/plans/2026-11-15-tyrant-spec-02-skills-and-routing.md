# Tyrant SPEC-02 Skill Catalog and Routing Implementation Plan

> For agentic workers: implement this plan inline with superpowers:executing-plans. Each behavior change follows test-first RED-GREEN. Baron is the development workflow only.

**Goal:** Implement SPEC-02 as a pinned skill catalog, deterministic Matt Pocock-first task route, explicit provider roles, conflict rules, and evidence-backed skill lifecycle events.

**Architecture:** Put catalog metadata and route decisions in focused modules under src/routing. Keep the MCP layer as a thin adapter over these modules and the existing task store. Embed reviewed upstream pins; never fetch or execute upstream content at runtime.

**Tech Stack:** TypeScript, Bun, Zod, official MCP TypeScript SDK, bun:test, existing SQLite event store.

## Global Constraints

- Tyrant does not call a model or initiate a conversation.
- ai-memory and Graphify are required project-context providers for repository work; missing integrations remain blockers for code changes.
- Taste is required for frontend tasks.
- Cloudflare security-audit is conditional; a full audit requires an explicit request or an approved risk route, and SPEC-05 execution boundaries still apply.
- A listed or recommended skill is not proof of host loading or use.
- Direct user instructions and project instructions take precedence over Tyrant and skill defaults.
- Do not install, update, rewrite, fetch at runtime, or execute external skill bundles.
- Do not include Site Clone.
- Work in the user-requested Tyrant directory because it has no Git repository; a Git worktree and commit ranges are unavailable.

## File Map

- Create src/routing/catalog.ts for typed skill metadata, provenance and source pins.
- Create src/routing/router.ts for deterministic task matching, preflight order, conflict precedence and bounded reasons.
- Modify src/mcp/server.ts to consume the catalog/router and expose their results through existing MCP tools.
- Modify src/contracts.ts to validate lifecycle events and require evidence for skill load/use/completion claims.
- Create tests/routing.test.ts for catalog, route behavior, provider separation and specialist selection.
- Modify tests/task-tools.test.ts for event evidence and lifecycle validation.
- Create docs/SKILL-CATALOG.md for source pins, invocation policies, host boundaries and refresh procedure.
- Modify README.md and spec/SPEC-02-SKILLS-AND-ROUTING.md with the implemented behavior and remaining integration boundaries.

## Interfaces

- src/routing/catalog.ts exports SKILL_CATALOG, SkillCatalogEntry, and SkillStatus.
- src/routing/router.ts exports routeTask(task: string), returning the existing core_workflow, required_context, specialists, blockers and host_action_required fields plus ordered steps, reasons, status, provider semantics and precedence.
- The MCP layer continues to expose tyrant_prepare_task and tyrant_list_skills; no new tool or model runtime is added.
- skill_loaded, skill_used and skill_completed events require skill_id and at least one host-provided evidence reference. skill_blocked and skill_skipped require skill_id and a reason summary.

---

### Task 1: Version-pinned skill catalog

**Files:**
- Create: src/routing/catalog.ts
- Create: tests/routing.test.ts
- Modify: src/mcp/server.ts

**Produces:** A typed catalog for the Tyrant-owned Matt orchestration policy, the relevant Matt skill family, ai-memory, Graphify, Taste and Cloudflare security-audit. Entries expose stable IDs, upstream skill IDs, repositories, source paths, version and commit, SPDX license, triggers, runtime/tool requirements, host-loading method, invocation policy, conflicts and fallbacks. Host installation presence is explicitly unknown.

- [x] Add an MCP behavior test that lists the catalog and checks every entry has nonempty identity/description/triggers/requirements/loading/policy/fallback metadata, a 40-character source commit, a recognized license, and a host-presence field that does not claim installation.
- [x] Assert the native ask-matt entry is manual-only, the Tyrant-owned core policy is distinct from that native entry, provider roles differ, and Site Clone is absent.
- [x] Run the focused catalog test; expect it to fail because listSkills currently returns unpinned metadata with null versions.
- [x] Add catalog types and the release/commit pins verified in the design note; paraphrase metadata and retain attribution links instead of copying upstream skill text.
- [x] Replace the inline skills array in src/mcp/server.ts with SKILL_CATALOG.
- [x] Re-run the focused catalog test; expect catalog behavior to pass.

### Task 2: Matt-first deterministic routing

**Files:**
- Create: src/routing/router.ts
- Modify: src/mcp/server.ts
- Test: tests/routing.test.ts
- Test: tests/task-tools.test.ts

**Consumes:** SKILL_CATALOG and SkillStatus from Task 1.

**Produces:** routeTask(task: string) selects a bounded ordered route without a model call. The internal Matt policy is always applied. Repository preflight is ai-memory, then current Graphify map/query, then the host-loaded Matt workflow before code changes. Code changes recommend Matt TDD and post-change review; bug reports select diagnosing-bugs; frontend tasks require Taste; security tasks select Cloudflare guidance, with full-audit mode marked as gated by explicit authorization and SPEC-05.

- [x] Add tests for a normal code-change route, a Vietnamese frontend task, a bug report, a generic security question, and an explicit full audit.
- [x] Assert the provider roles and authority rule: ai-memory is historical context, Graphify is a current-code map, and source/project instructions remain authoritative.
- [x] Assert route order, per-selection reason/required flag/status, explicit conflict precedence, and blockers for unavailable provider integrations.
- [x] Run the focused routing tests; expect failures because current routing only uses broad regexes and has no ordered route or specialist lifecycle policy.
- [x] Implement the typed deterministic router with bounded bilingual trigger patterns and explicit security guidance/full-audit distinction.
- [x] Wire routeTask into tyrant_prepare_task and preserve the existing required_context provider IDs and blocker behavior.
- [x] Re-run focused routing tests and the existing prepare-task route test; expect all to pass.

### Task 3: Evidence-backed skill lifecycle

**Files:**
- Modify: src/contracts.ts
- Modify: src/mcp/server.ts
- Test: tests/task-tools.test.ts

**Produces:** Existing MCP event logging distinguishes loaded, used, completed, blocked and skipped skill states. A loaded/used/completed record is rejected unless it contains a skill ID and a host-provided evidence reference; blocked/skipped records require a skill ID and reason. Tyrant states that evidence references are recorded claims, not independently verified host telemetry.

- [x] Add tests proving skill_used without evidence is rejected and does not persist an event.
- [x] Add tests proving loaded, used and completed events with evidence persist; blocked/skipped events require a reason and preserve their status.
- [x] Run the focused event tests; expect failures because the current schema has no completed/blocked/skipped event types and does not require evidence.
- [x] Extend the Zod event contract with those lifecycle types and cross-field refinements; map validation errors to a bounded INVALID_INPUT response.
- [x] Update the tool description to say which events require host evidence.
- [x] Re-run focused event tests and the existing retry, isolation and redaction tests; expect all to pass.

### Task 4: Public docs and SPEC-02 verification

**Files:**
- Create: docs/SKILL-CATALOG.md
- Modify: README.md
- Modify: spec/SPEC-02-SKILLS-AND-ROUTING.md

- [x] Document the pinned sources, roles, non-conflict rule, precedence order, route triggers, host-loading boundary, evidence status meanings, and manual-only ask-matt behavior.
- [x] Document that installation state is unknown and no upstream bundle is installed by this spec.
- [x] Update the SPEC-02 status and map each acceptance clause to behavior tests or a documented integration boundary.
- [x] Run bun test; expect all SPEC-01 and SPEC-02 tests to pass.
- [x] Run bun run typecheck; expect exit code 0.
- [x] Run Baron code-reviewer and test-engineer gates; retain the missing trusted-receipt condition. Agent reviews passed and gate summaries were recorded, but strict Baron gate evaluation is blocked by unrelated stale SPEC-01 receipt `receipt-8f3f593101113dade76a5af9b97a1835`.

## Setup and bookkeeping

The project has no .git directory, so git worktree, branch commits, merge-base review packages and git status are unavailable. The user named this exact project directory and authorized the change there; keep every Tyrant source edit inside that directory. Keep the plan ledger in .superpowers/sdd/2026-11-15-tyrant-spec-02-skills-and-routing/progress.md.

## Plan self-review

- Catalog fields and source provenance are covered by Task 1.
- Matt-first sequence, required providers, specialist triggers, conflict precedence and security gating are covered by Task 2.
- Lifecycle states and evidence rule are covered by Task 3.
- Public source/update documentation, SPEC status, full tests, typecheck and Baron gates are covered by Task 4.
- No runtime fetching, external installs, Site Clone, provider implementation, or model calls are included.