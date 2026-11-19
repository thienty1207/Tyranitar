# Host adapters

Build the self-contained command adapter and the DSH/OpenCode bundles from the Tyrant checkout:

```powershell
bun run build:integrations
```

Preview then install adapters for one project. The setup command writes only inside that project:

```powershell
bun run src/adapters/project-setup.ts preview --project-root "D:\Projects\my-app" --tyrant-root "D:\Working\Tyrant-Engine" --hosts codex,claude-code,opencode,dsh
bun run src/adapters/project-setup.ts setup --project-root "D:\Projects\my-app" --tyrant-root "D:\Working\Tyrant-Engine" --hosts codex,claude-code,opencode,dsh
bun run src/adapters/project-setup.ts status --project-root "D:\Projects\my-app"
```

`rollback` and `uninstall` restore exact prior bytes only while all Tyrant-managed files still match the saved hashes. If a managed file was edited after installation, the operation reports the path and leaves every file untouched. Backups and the owner manifest live below `.tyrant/adapters/` in the target project.

## Codex Desktop and CLI

Setup adds a project-scoped MCP entry and inline lifecycle hooks to `.codex/config.toml`, and installs the pinned skills under `.tyrant/skills/`. The user prompt hook returns the bounded preflight through `additionalContext`; its handler sets `additionalContextLimit = 0` so Codex does not spill Tyrant context to a temp file, paired with Tyrant's strict 52,000-character context bound. If required providers or skill bodies are missing, it returns Codex's blocking decision and does not record skills as injected. The session-end hook writes an unfinished task handoff. Project-local hooks and MCP config require the project to be trusted. Tyrant status remains `configured_pending_trust` until the hook runs; afterward it reports `hook_executed` or `hook_blocked`.

## Claude Code CLI

Setup merges a project-scoped Tyrant server into `.mcp.json` and adds prompt/session hooks to `.claude/settings.json`. Claude Code may ask for approval before using the project MCP server. The hook inserts context before the model request, or blocks that prompt if required providers or skill bodies are missing. Its inline context is capped at 9,000 characters: Tyrant reduces provider text first, preserves full skill bodies, and blocks if the complete required context still cannot fit under Claude Code's 10,000-character hook ceiling. The prompt hook has a 60-second timeout, and each Graphify child command is capped at 18 seconds. `onFailure: "block"` also blocks a failed or timed-out prompt hook and requires Claude Code v2.1.295 or later. Session-end hooks request 60 seconds for memory sync. The bundled hook command uses Bun.

## OpenCode Desktop and CLI

Setup places the project plugin at `.opencode/plugins/tyrant-engine.js`, installs the pinned skills under `.tyrant/skills/`, and merges a local Tyrant MCP server into `.opencode/opencode.jsonc`. OpenCode discovers direct JavaScript plugin files in `.opencode/plugins/`. Its prompt hook prepares context once at prompt admission, and its context hook injects the matching result by message ID on the initial request and tool continuations. A missing, mismatched, or blocked preflight prevents prompt admission/model dispatch. `session.deleted` releases cached context and saves an unfinished-task handoff.

## DeepSeek Harness Desktop and CLI

Setup prints instructions instead of editing unknown DSH profile internals. Add the Tyrant plugin to the profile the user actually runs:

```powershell
dsh plugin --profile <active-profile> add "D:\Working\Tyrant-Engine"
```

The plugin registers Cordis `agent/pre-step` and `agent/disposed` handlers. It prepares every claimed user prompt before the model step, loads a verified project-pinned skill body from `.tyrant/skills/` first, then falls back to DSH's registry, inserts a source-tagged context message, and rejects the model step when required project context is blocked. It saves a handoff when the agent is disposed. Also add the Tyrant MCP server through that profile's MCP settings (`stdio`, command `bun`, args `run <Tyrant checkout>\src\index.ts`, cwd set to the target project) to expose `tyrant_*` tools in the DSH tool list. The setup result prints this separate profile action.

The plugin itself calls Tyrant's real MCP tool contract through an in-process transport for preflight. This is what makes automatic context injection work even before a user-facing MCP entry is activated. DSH's `agent/disposed` callback is fire-and-forget from the host, so remote Memory sync is best effort; Tyrant saves local task state first and retries an incomplete handoff when one unambiguous fresh-session resume is requested.

## Claude Desktop

Claude Desktop is MCP-only in this release; it has no supported pre-prompt hook in this adapter. Connect Tyrant through Claude Desktop's MCP settings and use Tyrant's tools or static project instructions explicitly. Session-end handoff must be finished explicitly.

## Skills, providers, and evidence

Every automatic preflight calls `tyrant_prepare_task`, which loads bounded ai-memory history and a fresh, task-scoped Graphify result before returning context. Tyrant then applies its own Matt Pocock-inspired orchestrator policy and automatically loads only the routed specialist bodies. Native `ask-matt` remains manual-only and loads when explicitly requested. The MCP server exposes all 27 pinned AI-Memory operations; proxy events record only operation and outcome. Setup verifies and copies the pinned Matt specialist set, full Taste tree/resources, Cloudflare Security Audit, and their MIT licenses under `.tyrant/skills/`; it does not run third-party scripts. The adapter verifies project-pinned file hashes before injection. The bundle is about 38 MB per project. Missing required providers or skill bodies block prompt/step admission on configured adapters. Taste loads only for routed frontend work, and Cloudflare Security Audit only for security work.

`hook_executed` means the adapter ran and emitted context for an admitted prompt; it does not prove the model followed the instructions or that a host-native Skill tool was invoked. `hook_blocked` means required context was unavailable and the adapter returned a blocking outcome. Tyrant records those states without storing prompt transcripts or full skill bodies in the adapter receipt.

## Session-end capability

Codex `SessionEnd`, Claude Code `SessionEnd`, DSH `agent/disposed`, and OpenCode `session.deleted` trigger a conservative handoff. Codex caps `SessionEnd` at 3 seconds; DSH does not await disposal listeners. Those remote syncs are best effort, but the local handoff is persisted before sync and a fresh host session retries an incomplete sync before claim. Claude Code requests a 60-second session-end budget. Claude Desktop has no reliable close callback in this adapter, so it reports `explicit_only`.

On a fresh session, Tyrant includes the latest local checkpoint in the injected preflight and claims one matching AI Memory handoff when exactly one unclaimed local handoff exists. It records the claim on the source task. If multiple candidates exist, Tyrant blocks code work until the user selects the intended task. Same-session prompts receive the current local checkpoint as well.

## Verification boundary

Tests exercise fixture host events and Tyrant's actual in-process MCP server. They do not prove that a user's installed host loaded or trusted its adapter. Confirm the active DSH profile, Codex trust, Claude Code project approval, and OpenCode plugin load in that host before calling the integration accepted.
