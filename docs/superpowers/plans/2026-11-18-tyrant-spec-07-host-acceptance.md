# Tyrant SPEC-07 — Host Acceptance and Native DSH Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make the SPEC-07 DSH path genuinely model-visible and host-native, make AI-Memory authentication use the user''s configured D vault, then exercise and report the real provider/skill/host behavior without claiming untested desktop acceptance.

**Architecture:** Tyrant remains a small MCP orchestrator. Its DSH plugin will bind Tyrant''s MCP tool schemas into each DSH agent''s own tool scope, so each session''s calls stay attached to that session''s project. DSH''s own skill registry will be queried first, with integrity-checked Tyrant project files as fallback. AI-Memory receives its token from an explicit token environment variable or the configured local data directory; Graphify continues as a separate local CLI provider.

**Tech Stack:** Bun, TypeScript, MCP SDK, DSH Cordis plugin API, PowerShell for Windows host inspection.

**Spec:** `spec/SPEC-07-ACCEPTANCE-AND-ROADMAP.md`

## Global Constraints

- Preserve every pre-existing working-tree change; this checkout is already dirty before SPEC-07 work begins.
- Do not commit, push, or publish; the request is local implementation and verification.
- Never print, log, or store the AI-Memory bearer token in reports or test output.
- Keep model-visible Tyrant tool registrations scoped to one DSH agent/project and tear them down with the DSH agent.
- Use DSH''s supported native skill registry and lifecycle/tool APIs; no edits to app.asar or opaque Desktop configuration.
- Report Desktop acceptance as pending if the locked Windows UI prevents a live session.

## Review Focus

- A DSH agent from project A must not see or execute Tyrant tools scoped to project B; test separate agent contexts and disposal.
- Missing/invalid AI-Memory token files must fail safely without exposing token contents; test missing, symlink, and bounded reads.
- A DSH native skill with a duplicate name must not override Tyrant''s pinned body silently; verify the selected body hash and fallback behavior.
- Graphify refresh/query failure must remain visible and block code work according to SPEC-06; test a live current map and a missing executable.
- Logs and the final report must contain statuses, tool names, paths, versions, and hashes only, never credentials or full skill bodies.

---

### Task 1: Model-visible DSH tools (TDD)

**Files:**
- Create: `src/adapters/dsh-agent-tools.ts`
- Modify: `src/adapters/dsh.ts`, `integrations/dsh/index.ts`
- Test: `tests/dsh-agent-tools.test.ts`, `tests/host-adapters.test.ts`

- [x] Add a failing test proving the DSH plugin lists Tyrant''s real MCP tool definitions, registers them on `agent.ctx.tools`, forwards calls to the matching project server, and registers nothing globally.
- [x] Add a failing test proving missing scope/tool-registration capability rejects agent setup and prevents the first model step.
- [x] Implement per-agent tool registration from the MCP `tools/list` result; each executor opens the project-bound in-process Tyrant server and forwards only the registered tool''s own arguments.
- [x] Register at `agent/created` before first prompt assembly; record registration readiness by session identity and fail preflight closed if registration did not complete.
- [x] Run `bun test tests/dsh-agent-tools.test.ts tests/host-adapters.test.ts`, then `bun run build:dsh` and `bun run typecheck`.

### Task 2: DSH native skills and automatic routing (TDD)

**Files:**
- Modify: `src/adapters/project-setup.ts`, `src/adapters/dsh.ts`, `tests/project-setup.test.ts`, `tests/host-adapters.test.ts`
- Verify: `vendor/skills/manifest.json`, `src/routing/catalog.ts`

- [x] Add failing install tests for native skill discovery under project `.agents/skills`, including collision preservation and rollback.
- [x] Stage the integrity-pinned skill package into DSH''s supported `.agents/skills` root while preserving the existing Tyrant-private copy and manifest ownership checks.
- [x] Try DSH''s `ctx.skills.get` registry first and return explicit host-registry evidence; verify each body against a trusted runtime pin and fail closed for mismatches.
- [x] Add route tests proving Tyrant's built-in Matt policy runs for every work task, native `ask-matt` is selected only when explicitly requested, Taste only for frontend tasks, and Cloudflare Security Audit only for security tasks.
- [x] Run the focused tests, the complete Bun test suite, and integration builds.

### Task 3: AI-Memory vault authentication (TDD)

**Files:**
- Modify: `src/providers/ai-memory.ts`
- Test: `tests/ai-memory.test.ts`

- [x] Add failing tests for env-token precedence, explicit token-file loading, `AI_MEMORY_DATA_DIR/auth-token` fallback, whitespace trimming, missing files, and symlink/oversized-file rejection.
- [x] Implement bounded regular-file token loading. Read token bytes into memory only; never echo them in errors, events, or logs.
- [x] Use the existing user''s `AI_MEMORY_DATA_DIR=D:\\AI-MEMORY` configuration for a real local connection test.
- [x] Run `bun test tests/ai-memory.test.ts`; verify the upstream MCP tool list and one isolated project query/write/handoff with token output suppressed.

### Task 4: SPEC-07 real-host acceptance

**Files:**
- Create: `scripts/spec07-acceptance.ts` (or a focused acceptance script in the existing test pattern)
- Create: `docs/reports/SPEC-07-ACCEPTANCE-2026-11-18.md`
- Modify: `spec/SPEC-07-ACCEPTANCE-AND-ROADMAP.md`

- [x] Add a deterministic local acceptance fixture with a disposable project, a tiny codebase, and a unique AI-Memory scope.
- [x] Run real Tyrant MCP `tools/list` and `tyrant_prepare_task`; capture bounded evidence for `memory_context`, Graphify map/query, selected skill IDs/methods, route gates, and events.
- [x] Attempt an isolated DSH CLI smoke without changing the Desktop profile; it stopped at `MISSING_CREDENTIAL` before Tyrant preflight. The Desktop profile remains pending.
- [x] Record exact DSH/Graphify/AI-Memory/Bun/Windows versions, tool names, statuses, scope paths, and unsupported behavior. No transcript, credential, or full skill body in the report.
- [x] Mark each SPEC-07 host row passed, fixture-only, blocked, or pending; explicitly state that Tyrant uses a selective AI-Memory/Graphify contract and does not reimplement every upstream feature.

### Task 5: Security and whole-branch verification

**Files:**
- Review: all SPEC-07 changes and existing integration boundaries.

- [x] Run the focused tests, `bun test`, `bun run typecheck`, `bun run build:integrations`, and `git diff --check`.
- [x] Run and report the Standard source security scan; its captured snapshot has partial coverage and three findings. Targeted fixes are tested, but a full post-fix scan remains future acceptance work.
- [x] Review the final diff against SPEC-07 and the pre-task dirty-tree baseline; preserve inherited dirty work and make no commit/push.
- [x] Keep failed Desktop/CLI/model acceptance explicitly pending; fixture evidence is not described as a real DSH host session.
