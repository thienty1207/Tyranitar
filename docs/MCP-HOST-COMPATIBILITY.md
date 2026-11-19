# MCP Host Compatibility

## Runtime and project scope

Tyrant currently runs as a local Bun process over MCP stdio. It reads `TYRANT_PROJECT_ROOT` when present and otherwise uses its process working directory as the project boundary. `TYRANT_STATE_DIR` selects the local SQLite state directory. The default is `%LOCALAPPDATA%\Tyrant` on Windows and `$XDG_STATE_HOME/tyrant` (or `~/.local/state/tyrant`) on Unix-like systems. State is plaintext and capped at 64 MiB; the MVP also caps each project at 250 tasks and the database at 1,000 stored mutations. Common credential patterns are redacted before persistence, but this is best-effort and cannot detect every secret, so do not pass credentials in task, checkpoint, event, or evidence text.

Example command for a host that accepts a command and argument array:

```json
{
  "command": "bun",
  "args": [
    "--cwd=D:\\path\\to\\active-project",
    "run",
    "D:\\path\\to\\Tyrant-Engine\\src\\index.ts"
  ],
  "env": {
    "TYRANT_STATE_DIR": "D:\\path\\to\\Tyrant-State"
  }
}
```

Use the actual project root and Tyrant installation path. A host without a per-server working-directory option can set `TYRANT_PROJECT_ROOT` to the active project root. One global MCP process with a fixed project-root environment value will scope all calls to that same project; do not reuse that configuration across unrelated projects.

## Contract

The server advertises nine core task/state tools and all 27 AI-Memory operations as `tyrant_<upstream-name>` wrappers (36 tools total; the proxy names are `tyrant_memory_*`). Examples include `tyrant_prepare_task`, `tyrant_transition_task`, `tyrant_memory_query`, `tyrant_memory_write_page`, and `tyrant_memory_forget_sweep`. Each AI-Memory wrapper keeps its pinned upstream description and JSON Schema; it uses the configured endpoint/token and applies scope defaults only where the schema supports them.

- `tyrant_prepare_task`
- `tyrant_transition_task`
- `tyrant_get_task`
- `tyrant_list_skills`
- `tyrant_checkpoint`
- `tyrant_record_event`
- `tyrant_record_evidence`
- `tyrant_finish_task`
- `tyrant_sync_memory`

Tool data uses `schema_version: 1`. Inputs and outputs are bounded; task state is stored locally. Automatic host adapters run Tyrant before model work, load eligible skill instructions from the hash-verified project bundle first (then a host registry/file fallback where supported), inject them into the request, and record the loading method. This does not prove that the host's native Skill tool was invoked.

## Skill routing policy

1. Apply Tyrant's built-in Matt Pocock-inspired policy automatically, then load only the specialist skills matched to this task. Routine skill selection proceeds without asking the user to approve the route. The upstream `ask-matt` body is manual-only and loads only when explicitly requested; Tyrant never claims an implicit native Skill invocation.
2. ai-memory and Graphify are required context providers for repository work. ai-memory supplies historical decisions and handoffs; Graphify supplies the current derived code map. Tyrant calls them independently and keeps their references and trust roles separate.
3. Taste is required when a task is classified as frontend work.
4. Cloudflare Security Audit is an optional specialist for security work. Explicit full audits allow source review, while target-controlled execution stays blocked until an OS-enforced sandbox is verified.
5. Site Clone is not registered.

The native skill IDs are `ask-matt` (manual-only upstream), `design-taste-frontend`, and `security-audit`. ai-memory and Graphify are required providers, not aliases for Matt Pocock skills. Specialist context labels the selected route phase; code-review may be preloaded as `post_implementation` guidance, and the model must defer it until implementation is complete. The current Taste upstream scripts require Node.js 22+ and Chrome, Edge, or Chromium; Tyrant's own MCP runtime remains Bun.

The MCP route's code-change gate represents provider and task-state prerequisites. Automatic adapters also close the prompt/step gate when a required skill body is unavailable. If the checkpoint proves a task was blocked only by a required-provider failure, an adapter records an explicit `tyrant_transition_task` to `planned` after all current provider, skill, and context gates pass; unrelated blocked tasks remain blocked. Other closed gates reject the whole prompt/step; they do not preserve a separate read-only/provider-setup path in the same blocked host session. MCP-only clients may use `safe_work_allowed` for bounded fallback work. A ready gate does not prove that a model followed injected instructions.

Setup installs 1,666 pinned files (about 37 MB) for Matt Pocock's `ask-matt`, TDD, bug-diagnosis and code-review skills; the complete Taste skill tree/resources; and Cloudflare Security Audit, with their MIT licenses. The package manifest records repositories, commit/tree IDs and SHA-256 values. Setup verifies SHA-256 and recomputes each Git blob SHA-1 before copying; the checked-in manifest is part of the trusted Tyrant source, while signed release verification remains separate. Project setup copies verified files into `.tyrant/skills/`; preflight verifies the selected skill again before loading it. It does not fetch upstream code or execute third-party scripts. Tyrant does not install Site Clone.

Tyrant reports the security-audit policy in the route; it does not execute target-controlled build/test/browser/fuzz commands or claim a native skill was loaded. Without a verified OS-enforced sandbox, the host may continue source-only review, must leave unrun execution phases blocked, and should record execution-dependent findings as `needs_validation`.

The heuristic specialist route is an initial bounded contract. Host-specific skill loading and more complete task classification remain separate work.

## Graphify provider

`tyrant_prepare_task` runs Graphify's local code-only extraction before each task query, then asks a task-scoped question with depth `2` and a `500` token budget. Graphify's own incremental manifest decides whether source extraction needs work. Tyrant passes `GRAPHIFY_BACKEND=none`, excludes model credentials from the child environment, disables Graphify's home-directory query log, and scopes graph output to `<project>/graphify-out`. This keeps docs, PDFs, images, and query logs out of automatic extraction/storage and avoids adding a second graph/index. The returned context is capped at 3,000 characters; the task record and event log keep only the graph/query hashes and provider state. Verify graph context against current source.

The server discovers `graphify` on `PATH` by default. Set `TYRANT_GRAPHIFY_BIN` if it lives elsewhere and `TYRANT_GRAPHIFY_TIMEOUT_MS` to a value from 1,000 to 300,000 milliseconds (default 120,000). Claude Code adapter calls cap each Graphify child invocation at 18,000 milliseconds to fit its 60-second fail-closed prompt hook. A missing CLI, unsafe output path, stale/unreadable graph, timeout, or failed scoped query blocks code changes and appears in `graphify_context` and the task's `graphify` state. Tyrant does not install Graphify or change host settings.

## Host integration evidence

| Host | Adapter contract | Evidence and remaining check |
| --- | --- | --- |
| Codex Desktop and CLI | Project MCP config, `UserPromptSubmit`/`SessionEnd`, hard prompt block on missing prerequisites | Fixture-tested; trust, installed-host execution, and live smoke remain pending |
| DeepSeek Harness Desktop and CLI | DSH Cordis `agent/pre-step` and `agent/disposed`; load project-pinned skills before DSH registry, reject blocked steps, record blocked activation | Fixture-tested; active-profile install and live smoke remain pending |
| OpenCode Desktop and CLI | Project MCP config, prompt admission and context injection hooks; reject and record blocked preflight | Fixture-tested; live plugin load/behavior remains pending |
| Claude Code CLI | Project MCP config, prompt/session-end hooks, hard block on missing prerequisites | Fixture-tested; project approval and live CLI smoke remain pending |
| Claude Desktop | MCP/static instructions only | Compatibility only; no automatic pre-prompt adapter is claimed |

An MCP server appearing in a host configuration is not compatibility evidence by itself. Before release, run the same prepare, checkpoint, restart, and recovery path in each listed host and record its version and result.

## Local smoke checks

Run from `D:\Working\Tyrant-Engine`:

```powershell
bun test
bun run typecheck
```

The stdio test launches Tyrant as a child Bun process and checks MCP protocol output. It does not claim that any of the desktop applications or external CLIs accepted their configuration.
