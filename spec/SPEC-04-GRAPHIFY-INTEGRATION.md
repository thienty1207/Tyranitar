# SPEC-04 — Graphify Integration

Status: Implemented; provider fixtures pass (live Graphify CLI is not installed here)  
Depends on: SPEC-00, SPEC-01, SPEC-02

## 1. Purpose and ownership

Require Graphify as the shared code map for repository work without building a second graph. Graphify owns extraction, graph files and queries. Tyrant ensures a current map is available during task preparation, requests bounded relevant context, and stores the result reference. The graph is derived from the current repo and may be rebuilt.

Graph output is not canonical source code. The agent verifies relevant conclusions in source files before editing or claiming behavior.

## 2. When to use it

Every repository task must confirm that a Graphify map exists and is current so another model or fresh session can orient itself in the codebase. If no graph exists or the repo materially changed, refresh or extract it before code-level work. Include only the small map summary and scoped query results relevant to the task; do not inject a full graph report for simple changes.

## 3. Privacy and fallback

- Default to local code-only extraction when supported; Tyrant sets Graphify's backend to `none` and does not pass model credentials to the child process.
- Do not send docs, PDFs, images or source material to a remote model unless configured and accepted by the user.
- Report missing runtime/provider configuration plainly.
- Keep graph outputs and logs scoped to the selected repo.
- If Graphify is unavailable or stale, report the required preflight failure and do not claim a graph query ran. Code-level work remains blocked until Graphify is available and current; safe read-only diagnosis and setup may continue.

Tyrant setup installs or validates the exact Graphify CLI source/version pinned by this spec and manages any required Python runtime in an isolated user-level environment. Users must not have to install `uv` manually; Tyrant may bootstrap it privately or use another supported Python package manager. Verify the installed version and the required CLI commands before marking Graphify ready. Do not run Graphify's host installer by default when Tyrant already owns preflight and context injection; that installer may add another native skill, instruction file, or hook. Graphify remains a project-local provider, and its outputs stay under that repository's `graphify-out` directory, separate from AI-Memory data.

Tyrant uses the pinned Graphify CLI. Each prepare runs its incremental `extract` in code-only mode under `<project>/graphify-out`, then issues a task-scoped query at depth 2 with a 500-token budget. Tyrant returns at most 3,000 characters and stores the graph/query hashes and provider state, not a duplicate graph or an unbounded transcript. The child process disables Graphify's optional home-directory query log. `TYRANT_GRAPHIFY_BIN` and `TYRANT_GRAPHIFY_TIMEOUT_MS` configure the CLI path and timeout.

## 4. Acceptance criteria

Tyrant can detect Graphify availability and freshness, ensure a map exists for each repository task, request bounded context, retain a result reference, and clearly block when the required graph is missing or stale. Tyrant does not create another graph schema or index.
