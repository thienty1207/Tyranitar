# SPEC-04 Graphify Integration Plan

## Scope

Implement [SPEC-04](../../../spec/SPEC-04-GRAPHIFY-INTEGRATION.md) using the design in [2026-11-16-tyrant-spec-04-graphify-design.md](../specs/2026-11-16-tyrant-spec-04-graphify-design.md).

## Tasks

- [x] Add failing provider tests for code-only extraction, bounded query, availability/freshness, privacy, and safe path confinement.
- [x] Implement the Graphify CLI provider with injected process runner, timeout, credential-stripped environment, local output validation, and serialized refresh/query passes for concurrent tasks in one server.
- [x] Add failing router/MCP tests showing live Graphify status controls code-change readiness and its references/status are persisted.
- [x] Wire Graphify into `tyrant_prepare_task`; keep ai-memory history and Graphify current-code context separate.
- [x] Update catalog, SPEC-04 status, provider documentation, and acceptance mapping.
- [x] Run focused tests, full `bun test`, and `bun run typecheck`; inspect changed files and perform a fresh self-review.

## Ledger

- Ruling: Run Graphify's code-only `extract` on every prepare and rely on its own incremental manifest — this checks freshness without inventing another file index; cost if wrong is extra local process time or missing a Graphify edge case in its freshness logic.
- Ruling: Treat Graphify no-match/ambiguous exit codes as a completed preflight with an empty map answer — a new or renamed feature can have no indexed symbols; cost if wrong is allowing work with less useful graph context, while the source remains authoritative.
- Ruling: Disable Graphify's own query log on every child invocation — the pinned CLI writes query text to the user's home cache by default; cost if wrong is losing Graphify's optional query history, while Tyrant still records local provider events and references.
- Blocker: Baron prepare/reconcile cannot select an operation because three managed plans are active, and the prior receipt is stale. Final `plan update`, `continuity recover`, and `trace score` were also rejected because no validated ACTIVE authority matches this operation. Preserve Baron metadata and leave its plan in progress.
- Ruling: A Baron `proof execute` run emitted a passing test receipt under a newly allocated task ID, not this plan's task ID; report the direct Bun test result, but do not count that detached receipt as this plan's proof.
- Ruling: Baron autopilot review created an untrusted verification candidate requiring explicit approval; leave it pending because it is not needed to complete the code change.
- 2026-11-16: Provider tests were observed failing on the missing module before implementation; after adding the adapter, all 5 initial tests passed. Expanded coverage now includes path confinement, query failures, no-match, and ambiguous results.
- 2026-11-16: A concurrency test first observed overlapping refresh/query subprocesses; a per-provider queue now serializes each complete refresh/query pass, and the focused provider suite passes.
- 2026-11-16: The combined-provider MCP test failed before server integration because `graphify_context` was absent, then passed after wiring. It verifies routing, checkpoint/event references, and separate provider contexts.
- Self-review: no Critical or Important issue found in the adapter, routing gate, persistence migration, or provider separation. Live CLI behavior and host acceptance remain unverified because Graphify is not installed in this environment.

## Verification Results

- `bun test`: 42 passed, 0 failed, 468 assertions.
- `bun run typecheck`: passed (`tsc --noEmit`).
- `bun test tests\graphify.test.ts`: 10 passed, including the concurrent refresh/query regression test.
