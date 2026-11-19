# Tyrant SPEC-06: Automatic Host Adapters

## Goal

Implement the automatic orchestration contract in SPEC-06 so a configured host runs Tyrant before model work, receives bounded Memory/Graphify and routed pinned skill context, and records truthful evidence. Keep existing uncommitted AI Memory fixes intact. Do not install or rewrite this machine's host configuration, commit, or push.

## Global constraints

- Work in the current project checkout because it contains authorized, uncommitted AI Memory fixes; do not discard or rewrite them.
- Use Bun/TypeScript for Tyrant runtime and tests. Host adapters must use supported host lifecycle surfaces.
- Matt's built-in policy runs first on every task. The upstream `ask-matt` body remains for explicit user requests; its method/evidence is reported accurately and never implied by the built-in policy.
- ai-memory remains historical/untrusted; Graphify remains derived/current-code context. Both are called by the existing Tyrant prepare flow.
- Do not store prompt transcripts, secrets, or full skill bodies in Tyrant event logs.
- Codex hook trust and DSH plugin enablement are host-controlled. Report pending activation accurately.
- Bundle allowlisted skill files from exact upstream pins, record each source/license/hash, and never execute upstream scripts during setup.
- Do not publish, push, or modify installed global host settings.

## Interfaces

- `prepareTaskInput` and `TyrantStore.prepare()` currently create a new task unless an explicit task ID is provided. Host automation needs stable session-based reuse.
- The MCP server already exposes prepare/checkpoint/finish and provider injection points, so the host runner should call the actual tool contract instead of duplicating routing/provider logic.
- Hook protocol differences belong in thin adapters. The common runner receives `{ host_id, event, cwd, session_id, turn_id?, prompt? }` and emits the host's documented output shape.
- DSH Cordis `agent/pre-step` uses claimed `UserMessage[]`; OpenCode server plugin hooks can insert model context; Codex and Claude Code use `UserPromptSubmit` additional context and session-end hooks.

## Task 1 — Session-aware task reuse (TDD)

1. Add failing store/MCP tests showing that two auto-prepared prompts for the same host and session reuse one active task, while a completed/handoff task is not silently reused.
2. Add a bounded session lookup in `TyrantStore`, and an internal `resume_session` option to task preparation. Resolve the matching active task before loading providers so AI Memory receives the correct resume identity.
3. Add session-targeted task lookup for end hooks; ensure request IDs remain idempotent and scope stays project-local.
4. Run `bun test tests/task-tools.test.ts` and `bun run typecheck`.

Expected: tests fail before the store/API implementation, then pass with exactly one active task for one host/session.

## Task 2 — Shared automatic preflight runner (TDD)

1. Add failing tests for hook input validation, safe request-ID derivation, provider-blocked context, bounded formatting, and skill-loading evidence.
2. Implement one common host-hook runner that calls Tyrant's actual MCP tools in-process over `InMemoryTransport`; keep routing and provider behavior in the existing server.
3. Format returned context with an always-on Matt workflow section, separate historical/current-code sections, selected specialist instructions, and explicit blockers. Redact user text before sending it to Tyrant and never echo secrets into logs.
4. Record `skill_loaded` only after the hook has actually returned that skill's instructions, using a host-event reference; distinguish `adapter_injected` from host-native tool invocation.
5. Run the focused tests and typecheck.

Expected: fake host events receive a deterministic context envelope, a missing provider remains blocked, and skill evidence records the exact loading method.

## Task 3 — Host adapters (TDD)

1. Add failing contract tests for Codex/Claude Code command-hook JSON, DSH Cordis pre-step injection, and OpenCode server-plugin context injection.
2. Add the Codex/Claude Code hook entrypoint for `UserPromptSubmit` and reliable session-end events.
3. Add a DSH plugin that automatically calls the shared runner before each claimed user prompt, loads a verified project-pinned body before trying DSH's skill registry, and injects the returned context into the pre-step decision.
4. Add an OpenCode server plugin using the documented session hooks; cache per-session preflight results so one prompt does not rerun provider extraction on every tool step.
5. Add no-claim fallback behavior for Claude Desktop (MCP/static instructions only) and for hosts that skip/untrust hooks.
6. Fail closed when required providers or routed skill bodies are unavailable: use the host's prompt/step rejection surface and do not record skill injection for a blocked request.
7. Test the host adapters with fixture events; do not claim a real desktop smoke from fixture tests.

Expected: each configured host adapter injects context before model action, or blocks prompt/step admission when required context is missing; DSH and Codex are the primary acceptance paths; every unsupported lifecycle state is explicit.

## Task 4 — Automatic close and Memory handoff (TDD)

1. Add failing tests for session-end lookup, terminal-task no-op, one-time handoff sync, and idempotent retry.
2. Implement a common session-end path that finds the current host/session task, leaves completed tasks unchanged, and writes a conservative handoff plus next action to AI Memory only when a reliable session-end event is supplied.
3. Wire Codex and Claude Code session-end hooks and DSH agent disposal to that path. OpenCode only uses a lifecycle event after verifying that it means session close; ordinary turn idle must not close a task.
4. Record sync success/failure and expose pending sync when the host has no reliable close callback.
5. Run focused tests.

Expected: only real end events create handoffs; turn-idle/step events never mark a task completed or handed off.

## Task 5 — Project-scoped setup and recovery (TDD)

1. Add failing tests for an install preview, repeat install, unrelated hook/config preservation, modified managed entries, backup restore, and conservative uninstall.
2. Implement a project-scoped setup/status/rollback module that writes only Tyrant-owned adapter files/config fragments and the allowlisted project-local skill bundle. Verify pinned source/tree/file hashes and licenses, copy into `.tyrant/skills`, never run package scripts, and create backups plus an owner manifest with exact paths/hashes before changing content.
3. On malformed or user-modified targets, stop without writing and report the affected path. Codex setup must report `configured_pending_trust` until Codex confirms execution.
4. Add DSH plugin install guidance using its plugin manager rather than direct edits to unknown Desktop internals. Report Claude Desktop as MCP-only.
5. Record successful context emission separately from blocked preflight execution; do not mark skills loaded on a blocked prompt.
6. Run setup tests and typecheck.

Expected: repeated setup is idempotent; unrelated settings survive; changed files are never overwritten by rollback/uninstall.

## Task 6 — Docs and full verification

1. Update host compatibility and setup docs to match shipped adapter files, pinned skill bundles, hard-gate behavior, and exact limits.
2. Run `bun test`, `bun run typecheck`, and `git diff --check`; inspect the final diff and ensure the previous AI Memory changes remain present.
3. Record which host behaviors were fixture-tested versus actually run in a desktop/CLI.

Expected: the full suite passes; no claim of real-host acceptance unless that host has actually executed the adapter.
