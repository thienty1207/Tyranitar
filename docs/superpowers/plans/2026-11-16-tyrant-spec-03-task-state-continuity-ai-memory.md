# Tyrant SPEC-03 Task State, Continuity and ai-memory Implementation Plan

> **For agentic workers:** Execute inline, task by task, with test-first changes and verification after each task. The Tyrant folder has no Git repository, so do not claim commits or branch isolation.

**Goal:** Implement durable task lifecycle/checkpoints and a bounded ai-memory MCP adapter.

**Architecture:** Keep active state in Tyrant SQLite and call the explicitly configured ai-memory Streamable HTTP MCP service for historical recall and handoffs. Return compact, redacted history with the local checkpoint; keep Graphify as a separate missing SPEC-04 provider.

**Tech Stack:** Bun, TypeScript, Zod, SQLite, existing MCP client/server packages.

## Global Constraints

- Keep ai-memory and Graphify separate: historical memory versus current-code graph.
- Resolve ai-memory workspace/project explicitly; never infer it from a folder name or active-project pointer.
- Never persist transcripts, source files, shell output, environment dumps, or secrets.
- Treat memory as historical untrusted context; project instructions and current source remain authoritative.
- Do not install ai-memory, edit host configs, or implement Graphify.
- Run Bun tests and typecheck before reporting completion.
- Baron proof/trace remains untrusted while stale receipts or active-plan ambiguity block its control plane.

## File map

- src/providers/ai-memory.ts: configuration, explicit scope, MCP HTTP calls, bounded context, task outcome/handoff sync.
- src/state/store.ts: additive SQLite migration, lifecycle state machine, richer checkpoints/events, memory sync status.
- src/contracts.ts: bounded transition, checkpoint, event, and memory-sync schemas.
- src/routing/router.ts: accept live ai-memory readiness while keeping Graphify independent.
- src/mcp/server.ts: wire prepare/resume, transition, checkpoint, event, finish, and memory-sync results.
- tests/ai-memory.test.ts: local Streamable HTTP MCP fixture for the public ai-memory protocol.
- tests/task-tools.test.ts: lifecycle, checkpoint/event, provider-gap, resume, finish, retry, redaction, and isolation behavior.
- tests/stdio.test.ts: stdio tool discovery and restart recovery.
- docs/TASK-CONTINUITY.md: provider setup, scope, host fallback, lifecycle, failures, and privacy.
- README.md: continuity guide and provider setup summary.
- spec/SPEC-03-TASK-STATE-AND-CONTINUITY.md: acceptance status and integration boundaries.
- docs/superpowers/specs/2026-11-16-tyrant-spec-03-design.md: design record.

---

## Task 1: Lifecycle, checkpoint, and event state

**Files:** src/state/store.ts, src/contracts.ts, src/mcp/server.ts, tests/task-tools.test.ts

- [x] Add failing tests for lifecycle states, allowed transitions, terminal completion, transition idempotency, and request-ID conflicts.
- [x] Add failing tests for bounded checkpoint fields and event actor/host/session/artifact metadata surviving restart.
- [x] Run focused tests and confirm failure because the schema/store do not expose these fields or transitions.
- [x] Add only additive SQLite migrations; preserve legacy status and return lifecycle_state separately.
- [x] Add tyrant_transition_task for planned, in_progress, verifying, blocked, and handoff; store every accepted change as a structured event.
- [x] Extend checkpoint/event schemas with bounded intent, constraints, non-goals, plan progress, checks, provider refs, actor, host ID, session ID, and artifact refs.
- [x] Run focused tests and typecheck; verify illegal transitions write no rows.

## Task 2: ai-memory MCP adapter

**Files:** src/providers/ai-memory.ts, tests/ai-memory.test.ts

- [x] Add failing tests for environment and .ai-memory.toml configuration, paired explicit scope, loopback URL, auth header, tool errors, timeout/error redaction, and bounded context.
- [x] Add a local Streamable HTTP MCP fixture for memory_read_page, memory_write_page, memory_query, memory_handoff_list, memory_handoff_accept, and memory_handoff_begin.
- [x] Run adapter tests and confirm they fail before the provider client exists.
- [x] Implement a provider with loadContext and syncOutcome using the existing MCP client and no new dependency.
- [x] Initialize an explicitly scoped new project with a create_only marker page; load a single unambiguous handoff, leave multiple handoffs unclaimed, then query the task.
- [x] Redact and bound returned excerpts; map errors to short statuses without logging URLs, tokens, or raw server responses.
- [x] Store outcomes through a deterministic task page with conditional writes; create a native handoff only for handoff tasks.
- [x] Run focused adapter tests; verify concurrent page edits are not overwritten and uncertain handoffs are not duplicated automatically.

## Task 3: Continuity tool wiring and provider gating

**Files:** src/routing/router.ts, src/mcp/server.ts, src/state/store.ts, tests/task-tools.test.ts, tests/stdio.test.ts

- [x] Add failing MCP tests for start/resume returning the local checkpoint plus bounded ai-memory context and for missing memory producing an explicit continuity gap.
- [x] Add failing tests for initial checkpoint creation, outcome sync success/failure, and incomplete/uncertain status surviving restart.
- [x] Run focused tests and confirm they fail before wiring.
- [x] Inject the provider into createTyrantServer; default to the environment-backed MCP client and use a test fixture in tests.
- [x] Resolve memory before routing; pass actual ai-memory readiness to routeTask while Graphify remains independently unavailable.
- [x] On prepare, save only references and provider status locally; return content as bounded historical_untrusted context.
- [x] On finish, save local outcome first, then sync the ai-memory page/handoff and return continuity_status. Definite failures can retry; uncertain handoff delivery is surfaced without an automatic duplicate.
- [x] Re-run focused and stdio restart tests; verify provider failures never erase local task facts.

## Task 4: Docs and final verification

**Files:** docs/TASK-CONTINUITY.md, README.md, spec/SPEC-03-TASK-STATE-AND-CONTINUITY.md, SDD progress ledger

- [x] Document endpoint/token/scope variables and .ai-memory.toml parsing; state that scope is never guessed.
- [x] Document states, checkpoint/event fields, trust boundary, task outcome page, handoff retry behavior, privacy limits, and explicit host-call fallback.
- [x] Record the DSH boundary from SPEC-03: detached SessionStart and no PreCompact/SessionEnd means explicit prepare/checkpoint/finish calls remain required; unverified host behavior stays unknown.
- [x] Update SPEC-03 status and map acceptance statements to tests or named live integration boundaries.
- [x] Run bun test and bun run typecheck; inspect outputs and modified file list.
- [x] Self-reviewed the implementation; no separate delegated review was requested. Keep Baron plan in progress because strict receipts/trace remain blocked.
- [x] No Git commit is available because D:\Working\Tyrant-Engine has no .git directory.
## Resolved implementation decisions

Allowed lifecycle transitions: new to planned; planned to in_progress or blocked; in_progress to verifying, blocked, or handoff; verifying to in_progress, blocked, handoff, or completed; blocked to planned, in_progress, or handoff; handoff to in_progress or blocked; completed is terminal.

Existing coarse-status rows migrate in memory: active to in_progress, blocked to blocked, handoff to handoff, completed to completed. New route preparation sets planned, or blocked when provider gates block code work.

A provider failure keeps the local task/checkpoint. Finish retains its local terminal state and marks memory sync incomplete. tyrant_sync_memory retries sync without replaying a lifecycle transition.

New tasks never claim another task's handoff. Resume accepts only one handoff with the stable Tyrant task marker; ambiguous, unmarked, or uncertain deliveries stay visible and are not duplicated automatically.
