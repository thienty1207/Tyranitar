# Tyrant SPEC-03 Design

Date: 2026-11-16
Status: Approved for implementation by the user's instruction to continue with SPEC-03.

## Intent
Give Tyrant durable task continuity across model sessions and use ai-memory as the required project-history and handoff provider. Tyrant owns active task state; ai-memory remains the searchable historical memory store.

## Goals
- Track new, planned, in_progress, verifying, blocked, handoff, and completed with retry-safe transitions and actor/host/session metadata.
- Store compact checkpoints and structured events without transcripts, source files, shell output, environment dumps, or credentials.
- Before a task starts or resumes, return its latest Tyrant checkpoint and a bounded ai-memory brief/handoff.
- On task close, write a concise outcome to ai-memory; create a native ai-memory handoff for handoff state.
- Surface provider errors and mark continuity incomplete instead of silently falling back.

## Non-goals
- Do not install ai-memory, write host configuration, or install hooks.
- Do not implement Graphify; that remains SPEC-04.
- Do not mirror ai-memory wiki pages into Tyrant SQLite or treat recalled history as current truth.
- Do not claim host lifecycle hooks ran when Tyrant only made explicit MCP calls.

## Approaches
1. Direct ai-memory MCP client (selected): use the existing MCP TypeScript client and ai-memory Streamable HTTP API. Resolve explicit workspace/project from Tyrant environment overrides or the repository .ai-memory.toml. This uses ai-memory's public protocol and works independently of Codex, DSH, Claude, and OpenCode host passthrough.
2. Depend on each host to forward ai-memory tools: avoids a second MCP connection, but Tyrant cannot rely on hosts exposing sibling MCP tools to an MCP server, and host behavior differs. It cannot enforce required preflight.
3. Read/write ai-memory files directly: bypasses search, conditional writes, authorization, and handoff semantics, risking corruption of the memory store.

## Architecture decisions
- Endpoint: TYRANT_AI_MEMORY_URL, then AI_MEMORY_SERVER_URL, with loopback http://127.0.0.1:49374 as the native local default. Token: TYRANT_AI_MEMORY_AUTH_TOKEN, then AI_MEMORY_AUTH_TOKEN. Append /mcp unless already present.
- Scope: complete TYRANT_AI_MEMORY_WORKSPACE and TYRANT_AI_MEMORY_PROJECT pair, or root keys workspace and project in .ai-memory.toml. Never infer scope from a directory name or ai-memory active-project pointer.
- Prepare/resume reads a bounded task memory query and handoff. Initialize an explicitly configured new scope with one small tyrant/project.md marker page. Retrieved context is bounded historical evidence; Tyrant stores references, not full memory pages.
- A unique tyrant/tasks/<task-id>.md page records each final outcome. memory_handoff_begin is also called for handoff tasks. Local sync status and events make failures visible.
- Checkpoints include intent, constraints, non-goals, phase, plan progress, changed files, check outcomes, provider references, blocker, next action, and optional host/session IDs. Events include actor/host/session, skill/outcome, and artifact references.
- Keep the existing coarse status for compatibility and add the SPEC-03 lifecycle state separately. Completed tasks are terminal. An uncertain external handoff is not blindly retried because ai-memory handoffs are claim-once operations.

## Constraints and success
Keep Bun/TypeScript and the existing SQLite store; add no runtime dependency. Tests use a local MCP fixture. A real ai-memory installation and live host smoke are outside the verified environment. Success means full tests and typecheck pass, state survives restart, provider failures are explicit, and no raw transcript or token is persisted.
## Builder check resolutions

- Provider failure never discards local state. Prepare still records a local task and reports blocked continuity; finish preserves its local terminal state and reports pending/incomplete memory sync. A separate retry tool can sync without replaying the state transition.
- New tasks begin in planned (or blocked when required context is missing). Existing rows map active to in_progress, blocked to blocked, handoff to handoff, and completed to completed. Allowed transitions are explicit; completed is terminal, and legacy coarse status is only a compatibility projection.
- Handoffs carry a stable Tyrant task marker. A new task never claims a pending handoff; resume can accept only a unique handoff matching that exact task ID. Multiple or unmarked handoffs remain unclaimed and visible. Before retrying an uncertain creation, query for the stable marker; if it cannot establish whether the handoff was consumed, keep sync uncertain and do not create a duplicate.
