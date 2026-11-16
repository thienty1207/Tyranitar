# Task continuity and ai-memory

SPEC-03 keeps active task authority in Tyrant's local SQLite database and uses ai-memory for bounded historical retrieval and cross-session handoffs. Tyrant calls ai-memory directly over MCP Streamable HTTP; it does not read or edit the ai-memory wiki on disk.

## Configure ai-memory

Tyrant uses http://127.0.0.1:49374/mcp by default. Configure the endpoint and optional machine token with environment variables:

    $env:TYRANT_AI_MEMORY_URL = "http://127.0.0.1:49374/mcp"
    $env:TYRANT_AI_MEMORY_AUTH_TOKEN = "<machine-api-key>"

For compatibility, Tyrant also reads AI_MEMORY_SERVER_URL and AI_MEMORY_AUTH_TOKEN if the corresponding TYRANT_ variable is not set. An unauthenticated loopback server may omit the token. Remote endpoints must use HTTPS; Tyrant rejects non-loopback plaintext HTTP.

Set an explicit scope with both variables:

    $env:TYRANT_AI_MEMORY_WORKSPACE = "my-workspace"
    $env:TYRANT_AI_MEMORY_PROJECT = "my-project"

Or add root-level scope values to the repository's .ai-memory.toml:

    workspace = "my-workspace"
    project = "my-project"

Tyrant never guesses workspace or project from the folder name and never relies on ai-memory's active-project pointer. A partial environment pair is an error instead of falling back to the marker file. TYRANT_AI_MEMORY_TIMEOUT_MS accepts 500–30000 milliseconds; other values use the 8-second default.

The server must expose ai-memory's Streamable HTTP MCP endpoint and the required tools: memory_write_page, memory_read_page, memory_query, memory_handoff_list, memory_handoff_accept, and memory_handoff_begin. See the upstream [programmatic MCP contract](https://github.com/akitaonrails/ai-memory/blob/a11eff2514f24cb30c21917236ec187c0a359143/docs/programmatic-memory.md) for transport, scope, conditional-write, and handoff behavior.

## What happens at task start

Call tyrant_prepare_task before repository changes. Tyrant:

1. Creates or resumes a project-scoped task and loads its latest local checkpoint.
2. Ensures a small tyrant/project.md marker exists in the explicitly scoped ai-memory project.
3. On resume, lists open handoffs and claims only the unique handoff carrying the exact [tyrant-task:<task-id>] marker. A new task never consumes another task's handoff.
4. Calls memory_query with the task summary and a small result limit.
5. Returns a bounded context block marked [historical_untrusted], plus references, provider status, route, and the local checkpoint.

Historical context is not current project truth. Check current project instructions, files, and tests before acting. Tyrant stores the references/status locally, not entire historical pages.

## Lifecycle, checkpoints, and events

Lifecycle states are new, planned, in_progress, verifying, blocked, handoff, and completed. Transitions are explicit and retry-safe; completed is terminal. Existing coarse task statuses remain available for compatibility.

A new task gets an initial preflight checkpoint. Later calls to tyrant_checkpoint can save bounded intent, constraints, non-goals, phase, last reliable step, plan progress, changed files, check results, blocker, next action, ai-memory/Graphify references, and host/session identity. Structured events record task creation, route selection, checkpoint/evidence changes, skill lifecycle reports, state transitions, and memory sync outcomes.

Do not place secrets, complete shell output, source files, environment dumps, or transcripts in task state. SQLite is plaintext. Redaction covers common credential formats but is best-effort.

## Finish, handoff, and retry

tyrant_finish_task saves the local outcome first, then writes a concise outcome page at tyrant/tasks/<task-id>.md. If the task state is handoff, Tyrant also creates an ai-memory handoff with the matching task marker.

If the provider is unavailable or a write fails, the local task facts remain saved. Tyrant records the sync as incomplete or uncertain and returns a short error code. Call tyrant_sync_memory after fixing provider configuration or connectivity; this does not replay or change the lifecycle transition.

An uncertain handoff creation is not blindly repeated. Tyrant first looks for the stable task marker and reuses a matching open handoff. If the result is ambiguous or the provider cannot confirm delivery, it leaves the handoff uncertain so a retry cannot silently create duplicates. ai-memory handoffs are single-claim; resume accepts the exact listed handoff ID. See the upstream [handoff contract](https://github.com/akitaonrails/ai-memory/blob/a11eff2514f24cb30c21917236ec187c0a359143/docs/usage.md#cross-agent-handoff).

## Host fallback

Tyrant is an MCP orchestrator. It does not install host configuration or hooks. A host must call Tyrant's tools for the state transitions to be recorded.

For DSH, this implementation relies on explicit calls because its bridge does not provide a dependable PreCompact/SessionEnd path and SessionStart output is detached. Use tyrant_prepare_task at the beginning, tyrant_checkpoint at milestones or before compaction, and tyrant_finish_task when stopping. A host skill being listed or configured is not evidence that the host loaded or completed it.

Graphify is a separate, required current-code provider in SPEC-04. It is not replaced by ai-memory; its runtime or freshness failures remain visible as route blockers.
