# DSH Integration Closure Plan (2026-11-17)

## Goal

Close the verified integration gaps from the Tyrant Healthcheck DSH run before starting SPEC-06/07: make ai-memory sync failures actionable and durable, make the pinned Taste skill visible to DSH, and correct the healthcheck report to match the code. Keep upstream tool versions pinned and do not expose credentials.

## Confirmed baseline

- Tyrant main is clean at 2cb70f3; unit baseline was 46 passing tests and typecheck passed.
- The healthcheck DSH report shows preflight AI Memory and Graphify both ready; outcome sync is incomplete with rpc_n32602, but the failed MCP method is omitted.
- The report claims a query limit parameter is validated; the API actually uses a fixed limit of 100.
- The user clarified that the active DSH profile currently has only the model connection; no Tyrant MCP, plugin, or skill setup is accepted as live. Tyrant pins Taste v2.5.1 at commit f6b76575f949707b4e3c37cd86cb44b0b98643e8.
- DSH must be restarted/reloaded before host-side skill discovery can be confirmed. The current session has no registered Tyrant MCP tools, so live sync retry cannot be run from this Codex session.
- Baron preflight has a stale receipt / ambiguous active-plan blocker. Preserve Baron state; do not repair metadata manually.

## Steps

1. Add failing ai-memory provider tests for RPC -32602 and assert the exact MCP method is returned as a bounded failedOperation, with no raw message/token leakage.
2. Implement operation-aware error wrapping for ai-memory RPC calls; persist the last failed operation through Tyrant task state and include it in the sync result and event log. Add schema migration coverage.
3. Clarify gate semantics in the compatibility docs: safe_work_allowed lists safe fallback categories and does not negate a ready code_change_gate.
4. Correct the healthcheck report's limit statement; preserve the API's fixed 100-row limit.
5. Vendor the full pinned Taste skill bundle into Tyrant's project-scoped package with its license and hashes; do not configure the active DSH profile as part of this repository task.
6. Run Tyrant unit tests, typecheck, and focused safety checks. Recheck the Healthcheck source/report consistency. State explicitly that a DSH restart and tyrant_sync_memory retry are still required for live acceptance.

## Progress

- [x] Confirmed repository clean and captured current report/runtime evidence.
- [x] Add red tests for failed-operation reporting and state persistence; both failed before the implementation.
- [x] Implement operation-aware sync diagnostics, SQLite migration, task state, and event-log details; provider and lifecycle tests pass.
- [x] Vendor the pinned full Taste skill tree and MIT LICENSE in Tyrant; project setup installs its verified files under `.tyrant/skills/`.
- [x] Correct the Healthcheck report and document the separate provider gate versus host-native skill evidence.
- [x] Run full verification: 48 tests pass, typecheck passes, and git diff --check passes.
- [ ] DSH profile activation/discovery and live `tyrant_sync_memory` retry remain pending for host acceptance.
