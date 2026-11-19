# SPEC-08 — Full AI-Memory MCP and Automatic Matt Orchestration

Status: Implemented; automated verification passed; one live DSH Desktop coding task observed; full profile-switch and lifecycle acceptance pending
Depends on: SPEC-02, SPEC-03, SPEC-06, SPEC-07

## Purpose

Expose the complete AI-Memory MCP tool surface through Tyrant and make Tyrant's Matt Pocock-inspired orchestration policy the automatic decision-maker for repository work. The host should receive the route and only the specialist instructions that match the task.

## AI-Memory tool surface

- Register every operation advertised by the pinned AI-Memory server as a distinct `tyrant_<upstream-name>` MCP tool (the resulting names are `tyrant_memory_*`).
- Preserve each upstream description and JSON Schema so hosts can select operations and validate arguments accurately.
- Check in a generated contract snapshot with the upstream version and commit. Refresh it only through an explicit sync script and reviewed diff.
- Resolve the AI-Memory profile from the initialized project's stored vault-profile binding; use that profile's endpoint, credential source, and timeout with the project's complete `workspace`/`project` scope. The user's active default selects profiles only for new `tyrant init` operations. Preserve explicitly requested profile/global scope and upstream-supported destinations, and label such cross-project/profile access as explicit.
- `tyrant setup [<vault-path>]` selects that vault as the per-user default for future project initialization; without a path, it selects the current directory. `tyrant init` saves the resolved profile and project scope locally. If no profile was selected or configured, initialization stops with a setup instruction instead of guessing.
- Changing the active default must not change any existing project's provider endpoint, scope, or memory history. If the bound profile is missing or its endpoint identifies another data directory, return a visible blocker instead of using the current default or another server.
- Return bounded, redacted upstream results and safe error codes. Do not persist raw tool arguments, memory bodies, RPC payloads, or credentials.
- Record each forwarded operation and outcome against the active Tyrant task when one exists. The local event stores the tool name and outcome only.
- All 27 operations are available to the model; availability does not trigger every operation. Existing automatic project-context retrieval, outcome sync, and handoff behavior remain unchanged.

## Matt orchestration

- Tyrant runs its own built-in Matt Pocock-inspired task-shaping and routing policy on every repository task.
- The built-in policy chooses the applicable Matt engineering workflow and specialist skill route, orders the work, and reports a concise reason. The host adapter loads the selected pinned skill bodies and blocks work when a required body is unavailable.
- Do not load the upstream `ask-matt` body as the automatic orchestrator. Upstream `ask-matt` is manual-only and remains available only when the user explicitly asks to choose a Matt skill or flow.
- For routine scoped repository work, proceed without asking the user to approve each read, edit, or check. Infer a reversible default and record it as an assumption. Ask only when a missing decision materially changes the result and cannot be inferred safely; require explicit user intent for destructive or externally visible actions.
- Never claim that a host-native skill was invoked without host-provided evidence. Tyrant's internal policy and host-native skill invocation remain distinct in route and event data.

## Acceptance

- The Tyrant MCP lists all 27 pinned AI-Memory operations with distinct names and equivalent input schemas, in addition to its existing tools.
- Representative read, write, profile/global-scope, and message operations reach the correct upstream operation with the expected scope and authentication. Errors are redacted and bounded.
- With two vault profiles and at least three project roots, switching the active default sends each new project to the selected profile while existing projects remain bound to their original profile. Shared-profile projects with identical basenames remain isolated; no ordinary context query or handoff crosses project or profile scope.
- Fresh generated root bearer tokens and custom `bearer_token_file` paths authenticate through the selected profile without leaking credential bytes into tool output, host config, event logs, or project files.
- Operation events contain no raw arguments or memory contents.
- Every repository task applies the built-in Matt policy without loading native `ask-matt`; eligible specialist skills are selected and loaded automatically. Explicit `ask-matt` requests remain routable.
- Tests cover all operation registrations, schema preservation, scope defaults/overrides, safe logging, provider errors, and route/skill injection behavior.
- Run the full Bun test suite, typecheck, and integration build. A live AI-Memory check may call read-only operations only; do not execute mutating tools merely to prove reachability.

## Known live-host boundary

Fixture acceptance proves Tyrant's route and host-adapter behavior. It does not prove that DSH Desktop or another host's model followed the injected route. Record DSH native registry evidence only after an actual DSH session reaches Tyrant.

## Recorded acceptance

See [SPEC-08 acceptance report](../docs/reports/SPEC-08-ACCEPTANCE-2026-11-18.md) for test, typecheck, build, and live-host boundaries.
