# Tyrant SPEC-04 Graphify Integration Design

## Goal

Make Graphify the required, current code map for every repository task. Keep ai-memory as project history and handoffs. Tyrant orchestrates the two independent providers and stores only bounded context and evidence references.

## Decisions

1. Use Graphify's pinned local CLI, not a new graph schema or a second index. Run its `extract` command in code-only mode for every prepare. Graphify's own incremental manifest decides whether it needs to rebuild; code-only mode excludes docs, PDFs, and images and does not call a model.
2. Set Graphify's backend to `none`, disable Graphify's home-directory query log, pass the project root explicitly, and keep its output under `<project>/graphify-out`. Do not install Graphify or change host configuration from Tyrant.
3. After extraction succeeds, query Graphify with the bounded task summary, depth 2, and a 500-token output budget. A documented no-match or ambiguous result is a completed query with no useful map hits; other failures keep the provider unavailable.
4. Return at most 3,000 characters of Graphify query context. Save graph and query SHA-256 references plus provider status/error code in the local Tyrant task record; do not persist the query body as historical memory.
5. Refuse execution when the configured graph output resolves outside the selected project. Use process argument arrays, a timeout, and a sanitized child environment with model credentials removed.
6. Keep provider roles separate: ai-memory supplies historical decisions/handoffs, Graphify supplies derived current-code relationships. Both are untrusted evidence; source and current project instructions remain authoritative.

## Flow

`tyrant_prepare_task` loads ai-memory, asks Graphify to refresh or verify a code-only map, performs a scoped bounded query, then routes based on the live readiness of both providers. A missing executable, stale/unreadable graph, unsafe output path, timeout, or failed query produces a visible provider gap and blocks code changes. Safe read-only diagnosis and provider setup remain available.

## Verification

- Provider tests use an injected local fake process runner and temporary projects; no Graphify installation or network call is needed.
- Tests cover missing executable, local code-only refresh arguments, path confinement, valid current graph, bounded query/reference output, query errors, timeout, and no-match/ambiguous results.
- MCP tests cover readiness routing, blocking, and immediate persistence of Graphify references/status.
- Run focused tests, then `bun test` and `bun run typecheck`.

## Non-goals

- Installing Graphify or configuring Codex, DSH, Claude, or OpenCode.
- Sending repository material to a remote model.
- Replacing ai-memory or storing task transcripts in Graphify.
- Claiming Graphify's derived map is authoritative source code.
