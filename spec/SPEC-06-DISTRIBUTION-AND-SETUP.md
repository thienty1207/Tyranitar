# SPEC-06 — Distribution, Setup and Automatic Host Adapters

Status: Approved; pinned skill packages, project installation/version checks, automatic adapters, and fail-closed admission are implemented and fixture-tested; real-host acceptance remains pending
Depends on: SPEC-00, SPEC-01, SPEC-02, SPEC-03, SPEC-04, SPEC-05

## 1. Purpose

Make Tyrant usable by a non-technical developer across supported AI coding hosts. Setup must install a host adapter that runs the same project preflight automatically before eligible model work; an MCP entry by itself is not considered automatic orchestration.

## 2. What “automatic” means

For every configured repository task, the host adapter must run before the model acts and must:

1. Pass the host, session, project root, and bounded user task to Tyrant.
2. Call Tyrant’s task-preparation flow once per admission attempt. Use a host turn/event ID for idempotency within one attempt; if admission fails and that host retries the same ID, advance an attempt ID. Command hooks assign a fresh invocation ID, while DSH and OpenCode keep a bounded retry counter for a repeated turn/message ID and include an adapter-instance ID so host replays after a restart cannot reuse the prior idempotency key. If no host ID exists, use a fresh invocation ID rather than a prompt hash. `resume_session` keeps task continuity across attempts.
3. Apply Tyrant’s Matt Pocock-inspired main-flow policy first, then select specialist skills.
4. Load the selected skill instructions into the host’s model context before model work. The adapter must not wait for the model to decide whether it wants to call an MCP preparation tool. Label each specialist with its route phase; a preloaded `post_implementation` skill such as code review must be deferred until implementation is complete. If a required skill body is missing, block that prompt/step.
5. Load bounded ai-memory history and a fresh, task-scoped Graphify result automatically. Keep historical memory marked untrusted and Graphify marked as derived current-code context.
6. Return a visible, bounded status when a required provider or skill cannot be loaded. Required provider gaps block code changes; they never become an empty success.
7. If a task is still blocked solely by an earlier required-provider failure, and its checkpoint preserves that provider-only blocker, automatically record a real `tyrant_transition_task` from `blocked` to `planned` after all current providers, selected required skills, and context-size checks pass. Never auto-clear a task with another blocker; if the transition fails or returns an invalid state, keep the prompt blocked.
8. Record task, route, provider, skill-loading method, admission outcome, lifecycle transition, and outcome evidence without storing prompt transcripts, credentials, or full skill bodies in Tyrant logs. A blocked prompt is recorded as blocked and never as injected.
9. Include the latest local checkpoint in every injected context. For a fresh session, automatically claim and include one unambiguous prior handoff and its local checkpoint. If multiple handoffs exist, block code work and require explicit task selection. Retry an incomplete saved handoff sync before attempting to claim it.

“Loaded” means the adapter verified the project-pinned skill file against `.tyrant/skills/manifest.json` (or obtained a body from an allowed host registry/file fallback) and returned it in the pre-model context. Setup validates every vendored file hash and source pin before copying it; adapters recheck the copied skill hash at load time. A changed pinned file closes the required-skill gate. “Native skill tool invoked” is a separate claim and may be recorded only when host telemetry confirms an actual skill-tool invocation. An adapter must never fabricate native tool evidence.

The Matt Pocock-inspired main flow is always on through Tyrant’s built-in policy, which shapes each eligible task and selects its specialist routes. The adapter injects that Tyrant-owned policy before model work and loads only the selected specialist skill bodies. The upstream `ask-matt` body is installed and remains available for an explicit user request; it is not the automatic router because its own metadata disables model invocation and its purpose is to help a user choose a workflow. The route and event log preserve the actual loading method. Tyrant never claims native skill-tool invocation without host evidence.

## 3. Skill and provider policy

- ai-memory and Graphify are required for repository coding tasks. Run both on each new prompt/resume before code work. On session close, supported host adapters persist a bounded local handoff first, then attempt ai-memory sync. Codex limits `SessionEnd` hooks to 3 seconds and DSH disposal callbacks are not awaited by the host, so treat those remote syncs as best effort; a fresh session retries an incomplete handoff sync before claiming it. If no close event runs, local task state remains available for explicit finish/sync.
- Taste loads automatically for frontend implementation, redesign, or visual polish. Do not load it for unrelated backend work.
- Cloudflare Security Audit loads automatically for an explicit security audit or a routed security-sensitive task. An audit request permits source review; target-controlled builds, tests, browsers, fixtures, and fuzzing remain blocked until SPEC-05’s OS-enforced sandbox gate passes.
- Matt engineering specialists such as TDD, diagnosing-bugs, and code-review load only when the route selects them.
- Site Clone is not part of Tyrant.
- Setup copies allowlisted skill files from the Tyrant checkout into project-local `.tyrant/skills/` after verifying the pinned source, Git tree, license metadata, per-file SHA-256, and recomputed Git blob SHA-1. The checked-in manifest is part of the trusted Tyrant checkout; signed release verification is a separate release requirement. It copies the Matt Pocock `ask-matt`, `tdd`, `diagnosing-bugs`, and `code-review` skills; the complete Taste skill tree and resources; and Cloudflare Security Audit. The installer never executes third-party scripts. The current install is about 38 MB per project. Site Clone is excluded; ai-memory and Graphify remain required providers rather than copied skill packages.

## 4. Host adapter tiers

An adapter must use the host’s supported lifecycle/plugin API, not prompt text that merely asks the model to remember to call Tyrant.

| Host | Adapter contract | Status reporting |
| --- | --- | --- |
| DeepSeek Harness Desktop/CLI | Cordis `agent/pre-step` plugin prepares each claimed prompt, injects context, and rejects the model step when required context is blocked; disposal may sync a handoff. | Adapter fixtures pass; active-profile install and live host acceptance remain pending. |
| Codex Desktop/CLI | Project-scoped MCP entry and inline `UserPromptSubmit`/`SessionEnd` hooks prepare before model work; `UserPromptSubmit` blocks when the required context gate is closed. The prompt handler disables Codex's default output spill only because Tyrant bounds the complete context to 52,000 characters. | Adapter fixtures pass; hook trust and live host acceptance remain pending. |
| OpenCode Desktop/CLI | Project-scoped MCP entry and server plugin prepare on prompt admission and inject matching context before model requests; a blocked preflight prevents prompt admission. | Adapter fixtures pass; live plugin loading/behavior remains pending. |
| Claude Code CLI | Project-scoped MCP entry plus `UserPromptSubmit` and session-end hooks prepare context and sync a handoff; the prompt hook blocks when required context is unavailable or the command fails. Inline context is capped at 9,000 characters; provider text is reduced first, and the hook blocks if complete instructions still do not fit. The prompt deadline is 60 seconds, with Graphify invocations capped at 18 seconds each; `onFailure: "block"` requires Claude Code v2.1.295 or later. | Adapter fixtures pass; project-server approval and live CLI acceptance remain pending. |
| Claude Desktop | MCP connection and static orchestration instructions only unless Claude Desktop publishes a reliable pre-prompt hook/plugin API. | Compatibility only; never described as auto-preparing tasks. |

The adapter reports unsupported host surfaces instead of emulating lifecycle events. A configured hook that the host has not trusted/enabled is `configured_pending_trust`, not `active`.

## 5. Setup flow and managed files

### User-facing CLI and AI-Memory vault profiles

The root README provides a checksum-verified Tyrant install command, then the vault and project commands below. The installer puts the Tyrant CLI and its required runtimes in a per-user location; users do not manually install Bun, Python, or `uv` when the supported installer can provision the pinned tools.

- `tyrant setup [<vault-path>] [--name <profile>]` creates or adopts the selected AI-Memory data directory, installs or validates the pinned AI-Memory and Graphify providers, verifies their health, and makes that vault the active default in the per-user registry for future project initialization across all project roots. With no path, it uses the current directory; thus running `tyrant setup` from inside `AI-MEMORY-WEBDEV` selects that vault, and running it later inside `AI-MEMORY-DESKTOPDEV` switches the default to Desktop. The profile name defaults to the vault folder name when `--name` is omitted. Setup is idempotent and preserves existing AI-Memory data, authentication, other profiles, and initialized project bindings. Selecting another vault does not rewrite, migrate, or delete existing projects or prior profiles.
- A profile stores a stable ID, display name, canonical data directory, server URL/port, AI-Memory configuration location, and a reference to the configured credential file. It never stores the bearer value in the project, host configuration, or profile registry. Separate data directories must have identity-verified endpoints that cannot silently resolve to another profile; a port collision or endpoint mismatch must be resolved explicitly or block setup, never silently attach one profile to another vault. Reusing the same canonical data directory reuses its profile instead of starting a duplicate service.
- Provider provisioning must not invoke AI-Memory's broad agent-discovery setup in a way that adds duplicate MCP entries, hooks, or skills to the user's clients. Tyrant owns client integration. If the upstream command cannot provision the data directory/service without wiring agents, use supported lower-level AI-Memory initialization and service operations or add a supported provider-only mode; do not edit harness files as a workaround.
- Graphify setup installs the pinned CLI/runtime only. It does not run Graphify's host installer by default because Tyrant owns automatic graph preflight and context delivery. The user-facing flow verifies the exact pinned CLI and its required commands; `uv` is an internal package-management choice, not a manual user prerequisite.
- `tyrant init [--vault <profile>]` runs from a project root. A new project uses the explicit profile or current default, stores the profile ID, creates a stable project identity and complete AI-Memory `workspace`/`project` scope, and installs the project-scoped Tyrant adapter and concise managed agent guidance. If neither an explicit profile nor an active default exists, init fails with instructions to run setup; it never guesses from a folder name or connects to an arbitrary reachable server. A repeated init without an explicit profile preserves the existing project binding. Supplying an explicit profile is the deliberate rebind path.
- The active default is user-level and is used only when initializing a new project. Every later task in an initialized project resolves the project's stored profile, even after the user changes the default. Multiple projects in one profile get separate stable scopes even if their folder basenames match. Profile/project scope mismatches, missing profiles, unavailable endpoints, and endpoint identity mismatches block code changes; Tyrant never falls back to the current default or another reachable server.
- `tyrant status`/`tyrant doctor` reports the active default separately from the current project's bound profile, its non-secret endpoint/data-directory identity, AI-Memory authentication status, Graphify version/map status, and actual host-adapter activation receipt. It never prints the bearer token.
- Project init merges only a Tyrant-owned managed block into `AGENTS.md` or creates a separate Tyrant instruction file when that is safer. It preserves user-authored instructions. Guidance states the project-bound profile and scope, treats AI-Memory history as untrusted historical context and Graphify as derived current-code context, and forbids reading or exposing credentials. The host adapter remains the enforcement path; `AGENTS.md` is fallback guidance.

1. Install Tyrant from a trusted, checksum-verified release; Bun is Tyrant’s supported runtime during the source/development phase. A standalone binary may replace the Bun prerequisite only after its stdio and host-hook behavior is verified per OS.
2. Build the adapters and preview selected hosts with `bun run src/adapters/project-setup.ts preview --project-root <project> --tyrant-root <tyrant-checkout> --hosts <host-list>`.
3. Project setup writes Codex's `.codex/config.toml`, Claude Code's `.mcp.json` and `.claude/settings.json`, and OpenCode's `.opencode/opencode.jsonc` and `.opencode/plugins/tyrant-engine.js`. It never writes a machine-wide host config. The MCP entries point to the local Tyrant checkout and the target project scope.
4. For DSH, setup prints the `dsh plugin --profile <active-profile> add <tyrant-checkout>` action and separate stdio MCP server settings for the active profile. Claude Desktop remains MCP-only. Neither adapter is reported active before its actual host connection is confirmed.
5. Setup copies the pinned skills and source/license manifest into `.tyrant/skills/`; preflight checks each skill hash and loads the pinned project copy before a host fallback. Setup verifies both SHA-256 and recomputed Git blob SHA-1 against the checked-in manifest. That manifest is part of the trusted Tyrant checkout; signed release artifacts remain a separate release requirement. Setup never runs package scripts. DSH uses the project-pinned body before its plugin registry. A missing or changed required body/provider closes the prompt/step gate on hosts with a blocking lifecycle contract. Codex receives the complete Tyrant-bounded context (maximum 52,000 characters); Claude Code receives at most 9,000 inline characters, with provider text reduced before any skill body, and blocks if the complete required context cannot fit. Claude Code prompt hooks have a 60-second timeout and a per-Graphify-command ceiling of 18 seconds. Claude Code v2.1.295 or later is required for `onFailure: "block"` to also block when Tyrant's command hook fails or times out.
6. Setup is idempotent and project-scoped. It creates backups and an `installing` owner manifest with exact paths and hashes before changing adapter/config/skill content; backup paths are checked for symlink/junction parents. `status` checks current hashes and a non-secret hook-execution receipt; the latest outcome controls the displayed hook state. `repair` reports status without overwriting edits; `rollback` and `uninstall` restore prior bytes only while ownership and hashes match, and can retry after a partial restore.
7. Verify that the MCP server exposes its tools and the hook can prepare a sample task, return provider/route context, and record evidence. Fixture tests do not claim that a desktop application trusted or executed its hook.
8. Show the exact remaining host action, such as trusting Codex hooks, approving Claude Code's project server, or enabling DSH's adapter and MCP entry, then provide a status command to check whether the hook ran.

For AI-Memory and Graphify setup, acceptance must verify fresh and existing data directories, reuse of the configured root bearer without printing or rotating it, custom `bearer_token_file` resolution, provider-only installation without duplicate upstream host wiring, Graphify runtime bootstrapping without a manual `uv` prerequisite, profile endpoint separation, and correct provider selection for projects bound to different profiles.

Setup must be idempotent and transactional. It writes only project-scoped Tyrant entries/files, preserves unrelated settings and skills, creates backups and an `installing` owner manifest before replacing managed content, and records exact paths and hashes. If a target is malformed, ownership is ambiguous, or a user changed a Tyrant-managed file, setup stops before changing it and prints the affected path.

## 6. Configuration safety, update and removal

- Provide `setup`, `status`, `repair`, `rollback`, and `uninstall` operations with a preview before writes.
- **Current limit:** setup refuses to replace an already managed adapter or skill package when its bytes differ; roll back before retrying. The pinned package refresh script is a maintainer operation; it queries the pinned GitHub commit/tree and verifies each Git blob before updating the vendored bundle.
- **Release requirement:** updates must verify release checksums, preserve the user’s state and custom skills, and roll back to the prior managed version.
- Uninstall removes only files and entries whose ownership and current hashes still match Tyrant’s manifest. Modified entries are left in place and reported for manual review.
- Uninstall never deletes project source, task history, ai-memory pages, Graphify output, skills installed by another tool, or user-owned host configuration.
- Deleting Tyrant task history or ai-memory data is a separate explicit operation.
- No secrets or skill bodies are included in hook logs. Project/task summaries are bounded and redacted before persistence; local Tyrant state remains plaintext as described in SPEC-05.

## 7. Platform and release support

Windows is the first supported setup environment. macOS and Linux remain unclaimed until install, hook execution, backup, rollback, update, and removal are verified on those operating systems. Keep host compatibility separate from OS packaging compatibility.

## 8. SPEC-06 implementation acceptance

- A fake-host test proves preflight runs before model context is returned and that Matt, AI Memory, Graphify, and routed specialist loading are recorded accurately.
- A session-resume test proves prompts in one host session reuse the same active Tyrant task rather than creating one task per turn.
- A new-session handoff test proves exactly one saved, unclaimed handoff is resumed with its local checkpoint; ambiguous multiple handoffs block, and an incomplete handoff sync is retried before claim.
- A provider failure test proves the host receives the blocker and no “ready” state is reported; a provider-only recovery test proves the adapter records the explicit blocked-to-planned transition before admitting code, while an unrelated blocker remains closed.
- Adapter contract tests prove provider/required-skill gaps reject the prompt or model step on Codex, Claude Code, OpenCode, and DSH; host enforcement remains pending until live acceptance.
- Context-bound tests prove Codex's complete formatted context is not silently spilled/truncated, Claude Code stays below its 10,000-character `additionalContext` ceiling, and an oversized required skill set blocks instead of injecting an incomplete body.
- A setup test proves repeated install is idempotent, unrelated entries survive, changed managed entries are not overwritten, junction-based backup escape is blocked, and rollback restores exact prior bytes after an interrupted restore.
- A session-close test proves an unfinished task writes a handoff to ai-memory only when the host supplied a reliable end event.
- Each integration has a host-level checklist. Unit or generic MCP tests alone do not count as real desktop/CLI acceptance.
