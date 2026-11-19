# SPEC-07 Acceptance Report — 2026-11-18

## Result

Tyrant's provider and MCP acceptance passed against the configured local environment. Fixture-driven adapter checks also passed. **Live DSH host acceptance remains pending**: the isolated DSH CLI profile had no credential and stopped with `MISSING_CREDENTIAL` before the plugin made a Tyrant tool call; the DSH Desktop profile was not exercised because the Windows UI was locked.

This is not a release acceptance. Codex, OpenCode, Claude Code, and DSH need their own live-host checks.

## Environment and scope

- OS: Windows 11 Pro, build `10.0.26300` (`win32`)
- Tyrant: `0.1.0`
- Bun: `1.4.4`
- DeepSeek Harness CLI: `0.2.2-rc.3`
- Graphify: `0.9.109`
- AI-Memory MCP server: 27 tools returned by its authenticated `tools/list`
- AI-Memory data directory: `D:\AI-MEMORY`
- Acceptance scope: workspace `tyrant-healthcheck`, disposable project `mini-api-spec07-23ec5500688c`

The smoke test used a unique project scope, created and removed four temporary AI-Memory pages, and rolled back the temporary project adapter setup. It did not print or store the vault token.

## Observed provider and tool results

| Surface | Result | Evidence |
| --- | --- | --- |
| AI-Memory connection | Passed | Authenticated tool discovery returned 27 tools. Tyrant's required query, page read/write, and handoff operations were present. |
| AI-Memory context | Passed | Frontend, security, and resumed-task contexts returned `ready`; session-end sync returned `synced`; a fresh task claimed its handoff. |
| Graphify connection | Passed | Local executable found; frontend, security, and resume refresh/query results were `ready`; all maps were `current`; frontend returned 2 references. |
| Tyrant MCP | Passed | Real local MCP server listed 9 `tyrant_*` tools; `tyrant_list_skills` returned successfully. |
| Project isolation | Passed in fixture | Two agent scopes were checked; tools were bound to the project-specific MCP client and disposed with their DSH agent. |
| Upstream feature parity | Selective | Tyrant uses selected AI-Memory MCP operations and Graphify `extract`/`query`; it does not expose all 27 AI-Memory operations or all Graphify commands as Tyrant behavior. |

The returned Tyrant tool names were `tyrant_checkpoint`, `tyrant_finish_task`, `tyrant_get_task`, `tyrant_list_skills`, `tyrant_prepare_task`, `tyrant_record_event`, `tyrant_record_evidence`, `tyrant_sync_memory`, and `tyrant_transition_task`.

## Automatic routing observed in the acceptance fixture

| Task | Automatically loaded | Provider and gate result |
| --- | --- | --- |
| Frontend implementation | Matt main flow, TDD, Taste | AI-Memory and Graphify ready; route and code gate ready; 47,907 characters of context including 44,714 skill-body characters. |
| Security audit | Matt main flow, Cloudflare Security Audit | Providers ready; route `ready_with_gaps`; source-only review is permitted, while target-controlled builds, tests, and fuzzing remain blocked without an OS-enforced sandbox. |
| Resume from handoff | Matt main flow | Providers ready; prior handoff claimed and local checkpoint included. |

These skill results came from a fixture that read the project's staged `.agents/skills` files. **It was not a live call to DSH's skill service.** The acceptance verifies Tyrant's automatic policy, routing, context construction, and fixture injection path, not that a running DSH model followed those instructions.

Tyrant applies its Matt Pocock-inspired task-shaping and routing policy before each repository task and auto-loads the trusted `ask-matt` body through the adapter. The upstream `ask-matt` skill is manual-only; Tyrant does **not** claim it invoked a host-native Skill tool. A real DSH native registry call still needs live-host evidence.

## DSH host status

- DSH CLI `0.2.2-rc.3`: local plugin was listed in a disposable CLI profile. A model smoke ended with `MISSING_CREDENTIAL`; no Tyrant tool-call event was observed. This is blocked, not passed.
- DSH Desktop: pending. The Electron-owned Desktop profile was not read or changed, and the locked UI prevented a live session check.
- The DSH agent-scope, registration-failure, tool forwarding, and disposal behavior is covered by automated adapter tests and the acceptance fixture. It has not yet been observed in an actual DSH agent session.
- Codex Desktop/CLI, OpenCode, Claude Code CLI, and Claude Desktop: fixture-only or MCP-only; no live host acceptance was performed in this run.

## Security review and hardening

Codex Security scan `5d1c1615-8832-472f-a82c-dde1e18b0d47` completed with **partial** source coverage and 3 findings against its captured pre-hardening worktree snapshot: project-controlled skill authenticity (medium), generated hook command substitution (low, host-shell dependent), and unbounded activation-receipt reads (low). The scan covered the principal adapter/provider boundaries, not the entire 1,735-file inventory. Its workbench also reports that the worktree changed while the scan ran; the results apply to the original snapshot.

After that snapshot, the current worktree was hardened and given regression tests:

- Required skill bodies must match a trusted runtime SHA-256 pin; a project-writable manifest or untrusted native/project skill cannot satisfy the route.
- Generated hook paths containing shell/environment substitution characters are rejected.
- Activation receipts are read with a fixed 64 KiB bound; the local adapter manifest read is capped at 1 MiB.

The focused tests and full suite passed after these changes. This is targeted regression evidence, not a new full security scan of the final worktree.

## Verification

- `bun test`: 127 passed, 0 failed; 939 assertions.
- Focused DSH/host/setup tests: 54 passed, 0 failed; 319 assertions.
- Runtime skill-pin catalog check: 1 passed, 0 failed; 13 assertions across all six vendored skills.
- `bun run typecheck`: passed.
- `bun run build:integrations`: passed for command hook, DSH, and OpenCode bundles.
- `bun scripts/spec07-acceptance.ts`: passed against real AI-Memory and Graphify services; four temporary memory pages removed, zero cleanup failures; project setup rolled back.
- The DSH CLI model smoke: blocked by missing CLI credential before Tyrant preflight; Desktop pending.

## Remaining acceptance work

1. In a future unlocked session, run one DSH Desktop task and record actual tool registration, pre-step invocation, native skill-registry method, task events, and session handoff.
2. Repeat live-host acceptance independently for Codex, OpenCode, and Claude Code.
3. Run a full source security scan against the final post-hardening worktree before treating its findings as closed.
4. Keep AI-Memory and Graphify feature claims limited to the selected operations Tyrant actually calls.
