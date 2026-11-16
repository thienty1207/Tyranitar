# SPEC-03 — Task State, Logs, Continuity and ai-memory

Status: Implemented; automated checks pass. Live ai-memory and host smoke acceptance remain unverified.
Depends on: SPEC-00, SPEC-01, SPEC-02

## 1. Purpose

Recover work without treating a large transcript as project state. Tyrant stores a compact task snapshot and structured event history; ai-memory supplies bounded historical retrieval and handoffs. Tyrant does not mirror the ai-memory wiki.

## 2. Task lifecycle

The lifecycle is new, planned, in_progress, verifying, blocked, handoff, and completed. Accepted transitions record task ID, prior/new state, actor/host/session where available, timestamp, and reason. Repeated delivery with the same request ID and payload is idempotent; a changed payload conflicts. completed is terminal.

Existing coarse status values remain for compatibility. The additive migration maps active to in_progress, and maps blocked, handoff, and completed directly. A migration test confirms legacy task, checkpoint, and event rows survive.

## 3. Checkpoints and event log

A checkpoint includes phase, last reliable step, next action, blocker, changed-file and evidence references, plus bounded intent, constraints, non-goals, plan progress, check outcomes, ai-memory/Graphify references, and host/session identity. Each new task receives an initial preflight checkpoint.

Events record task/route creation, checkpoint and evidence updates, state transitions, skill lifecycle reports, and memory sync outcomes. Event metadata includes stable ID, task ID, actor/host/session where known, time, outcome, evidence, and artifact references.

Do not store API keys, environment dumps, full shell output, source files, or transcripts. Common secret patterns are redacted, but detection is incomplete. Local SQLite is plaintext.

## 4. ai-memory boundary and protocol

- ai-memory owns searchable historical observations and single-use handoffs.
- Tyrant owns active task state, route, workflow position, checkpoints, and verification references.
- Project instructions, current source, and tests remain authoritative over recalled history.
- Tyrant stores references and sync status, not copied history pages or transcripts.

Tyrant connects to the ai-memory Streamable HTTP MCP endpoint with explicit workspace and project on every project-scoped tool call. Scope comes only from a complete Tyrant environment pair or root keys in .ai-memory.toml; it is never guessed. On first use, Tyrant creates a small tyrant/project.md marker using a create-only write. Prepare/resume queries a bounded memory_query result set, and an exact task-matched handoff is accepted only on resume.

On finish, Tyrant first persists the local result, then updates a deterministic tyrant/tasks/<task-id>.md page using conditional writes. A handoff task also calls memory_handoff_begin. Definite failures remain retryable through tyrant_sync_memory; ambiguous handoff delivery remains uncertain and is not blindly duplicated. Provider errors become short safe status codes, not raw response bodies.

The upstream protocol uses Streamable HTTP at /mcp, explicit scope for static clients, MCP content-text JSON tool results, result.isError/JSON-RPC error handling, conditional page versions, and single-use handoff claims. See the pinned upstream [programmatic MCP contract](https://github.com/akitaonrails/ai-memory/blob/a11eff2514f24cb30c21917236ec187c0a359143/docs/programmatic-memory.md).

## 5. Hooks and host fallback

Tyrant does not install hooks or edit host configuration. The host must call Tyrant MCP tools to record state. For DSH, explicit prepare/checkpoint/finish calls remain necessary because the bridge lacks a dependable PreCompact/SessionEnd path and SessionStart output is detached. Skill configuration is not proof of skill execution.

Graphify remains a separate current-code provider and is not part of this spec's adapter. The routing gate must continue to expose its absence instead of treating ai-memory history as a substitute.

## 6. Acceptance evidence and limits

Automated coverage is in tests/task-tools.test.ts, tests/ai-memory.test.ts, and tests/stdio.test.ts. It checks lifecycle transitions, idempotency, migration, restart persistence, bounded context, scope/auth, handoff matching/claim/retry/ambiguity, MCP timeouts and connection failures, concurrent page writes, secret redaction, and explicit provider gaps. Full bun test and bun run typecheck are required before final acceptance.

The adapter is exercised against a local Streamable HTTP MCP fixture, not a live ai-memory installation. Real-server and Codex/DSH/Claude/OpenCode host behavior remain unverified. Graphify is integrated separately in SPEC-04 and is exercised with an injected local process fixture.
