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

Events record task/route creation, checkpoint and evidence updates, state transitions, skill lifecycle reports, memory sync outcomes, and proxied AI-Memory operation names/outcomes. Generic proxy events omit raw arguments and result bodies. Event metadata includes stable ID, task ID, actor/host/session where known, time, outcome, evidence, and artifact references. Task reads return the latest blocked-state event separately from the bounded recent-event list so an older implementation or test blocker cannot disappear when the event window advances.

Do not store API keys, environment dumps, full shell output, source files, or transcripts. Common secret patterns are redacted, but detection is incomplete. Local SQLite is plaintext.

## 4. ai-memory boundary and protocol

- ai-memory owns searchable historical observations and single-use handoffs.
- Tyrant owns active task state, route, workflow position, checkpoints, and verification references.
- Project instructions, current source, and tests remain authoritative over recalled history.
- Tyrant stores references and sync status, not copied history pages or transcripts.

Tyrant connects to the ai-memory Streamable HTTP MCP endpoint with explicit workspace and project on every project-scoped tool call. A per-user registry stores named vault profiles and one active default; the registry is independent of any project directory. Each profile identifies a canonical AI-Memory data directory, its server endpoint, and a credential source reference. `tyrant setup [<vault-path>]` selects or creates the profile for that vault and makes it the default for future `tyrant init` operations across the user's projects. With no path, `tyrant setup` uses the current directory, so running it from inside a vault selects that vault. Running setup for another vault changes the default for future project initialization only; it never changes an existing project's binding.

`tyrant init [--vault <profile>]` binds a new project to the explicit profile or the current default and persists that profile ID in project-local Tyrant configuration. If no default exists, init must stop with a clear instruction to run `tyrant setup`; it must not silently create or guess a vault. Re-running `tyrant init` without an explicit profile preserves an existing binding; an explicit profile override is the deliberate rebind path. Existing projects always resolve their provider through the saved binding, never by falling back to the user's active default. Each profile must resolve to the intended AI-Memory server/data directory; an endpoint collision, missing profile, or identity mismatch is a visible provider failure, not permission to use whichever server happens to answer.

AI-Memory scope is a complete `workspace`/`project` pair from the project binding or an explicit root scope in `.ai-memory.toml`. If the marker is absent, `tyrant init` creates a stable, non-colliding project scope and persists it with the project binding; directory basenames are display labels, never identity. A partial or conflicting scope is reported and blocks repository code work until corrected. One profile may serve many projects, but each project has a distinct scope, including projects with identical folder names. On first use, Tyrant creates a small `tyrant/project.md` marker using a create-only write. Prepare/resume queries a bounded `memory_query` result set, and an exact task-matched handoff is accepted only on resume.

On a fresh data directory, AI-Memory generates its own root bearer token at the path configured by `[auth].bearer_token_file`. Tyrant resolves that file from the selected profile's trusted AI-Memory configuration, reuses existing credentials without rotating them, and never copies the token into project files, host settings, `AGENTS.md`, command arguments, or logs. The generated token is unique to the install, not a shared default secret. An unreadable or missing configured credential is a provider failure; Tyrant does not guess another token path.

On finish, Tyrant first persists the local result, then updates a deterministic tyrant/tasks/<task-id>.md page using conditional writes. A handoff task also calls memory_handoff_begin. Definite failures remain retryable through tyrant_sync_memory; ambiguous handoff delivery remains uncertain and is not blindly duplicated. A page-specific upstream `-32602` response whose message identifies that page as missing is treated as the first-write case; unrelated invalid-parameter errors remain incomplete. Provider errors become short safe status codes, not raw response bodies. Outcome sync also returns the failed MCP operation name and persists that bounded operation in ai_memory.error_step and the memory-sync event summary. Raw RPC messages, payloads, and credentials are never included in this diagnostic.

The internal lifecycle uses the upstream Streamable HTTP contract. SPEC-08 also exposes the complete pinned AI-Memory v3.4.7 surface (27 tools) with original schemas, default project scope, explicit profile/global destinations, safe bounded output, and operation/outcome-only events. See the pinned upstream [programmatic MCP contract](https://github.com/akitaonrails/ai-memory/blob/fa0ec25dbe987b7574a7487ecf92f0873040c2f2/docs/programmatic-memory.md).

## 5. Hooks and host fallback

This spec defines state/provider behavior and does not install host hooks. SPEC-06 adds optional project-scoped adapters that call these MCP tools before host model work. DSH sessions without that adapter still need explicit prepare/checkpoint/finish calls. The DSH disposal hook is best-effort for remote sync; local state is saved first and retried on the next unambiguous resume. Skill configuration or context injection is not proof that a host-native Skill tool ran or that the model followed the instructions.

Graphify remains a separate current-code provider and is not part of this spec's adapter. The routing gate must continue to expose its absence instead of treating ai-memory history as a substitute.

## 6. Acceptance evidence and limits

Automated coverage is in tests/task-tools.test.ts, tests/ai-memory.test.ts, and tests/stdio.test.ts. It checks lifecycle transitions, idempotency, migration, restart persistence, bounded context, scope/auth, handoff matching/claim/retry/ambiguity, MCP timeouts and connection failures, concurrent page writes, secret redaction, and explicit provider gaps. Full bun test and bun run typecheck are required before final acceptance.

The adapter is exercised against a local Streamable HTTP MCP fixture, not a live ai-memory installation. Real-server and Codex/DSH/Claude/OpenCode host behavior remain unverified. Acceptance must also cover generated and custom `bearer_token_file` paths, multiple vault profiles, default switching, project binding persistence, endpoint identity, and no cross-profile or cross-project reads. Graphify is integrated separately in SPEC-04 and is exercised with an injected local process fixture.
