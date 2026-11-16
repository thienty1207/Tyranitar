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

The server advertises these tools:

- `tyrant_prepare_task`
- `tyrant_get_task`
- `tyrant_list_skills`
- `tyrant_checkpoint`
- `tyrant_record_event`
- `tyrant_record_evidence`
- `tyrant_finish_task`

Tool data uses `schema_version: 1`. Inputs and outputs are bounded; task state is stored locally. MCP is an orchestration boundary: it recommends a skill and records evidence, but it cannot execute the host's native skill loader.

## Skill routing policy

1. Apply the Matt Pocock main-flow routing policy first. In the upstream repository, `ask-matt` is user-invoked, so Tyrant identifies it as the workflow source and returns a host action instead of falsely claiming to invoke it.
2. ai-memory and Graphify are required context providers for repository work. ai-memory supplies historical decisions and handoffs; Graphify supplies the current derived code map. Tyrant calls them independently and keeps their references and trust roles separate.
3. Taste is required when a task is classified as frontend work.
4. Cloudflare Security Audit is an optional specialist for security work. Explicit full audits allow source review, while target-controlled execution stays blocked until an OS-enforced sandbox is verified.
5. Site Clone is not registered.

The native skill IDs are `ask-matt` (manual-only upstream), `design-taste-frontend`, and `security-audit`. ai-memory and Graphify are required providers, not aliases for Matt Pocock skills. The current Taste upstream scripts require Node.js 22+ and Chrome, Edge, or Chromium; Tyrant's own MCP runtime remains Bun.

Tyrant reports the security-audit policy in the route; it does not execute target-controlled build/test/browser/fuzz commands or claim a native skill was loaded. Without a verified OS-enforced sandbox, the host may continue source-only review, must leave unrun execution phases blocked, and should record execution-dependent findings as `needs_validation`.

The heuristic specialist route is an initial bounded contract. Host-specific skill loading and more complete task classification remain separate work.

## Graphify provider

`tyrant_prepare_task` runs Graphify's local code-only extraction before each task query, then asks a task-scoped question with depth `2` and a `500` token budget. Graphify's own incremental manifest decides whether source extraction needs work. Tyrant passes `GRAPHIFY_BACKEND=none`, excludes model credentials from the child environment, disables Graphify's home-directory query log, and scopes graph output to `<project>/graphify-out`. This keeps docs, PDFs, images, and query logs out of automatic extraction/storage and avoids adding a second graph/index. The returned context is capped at 3,000 characters; the task record and event log keep only the graph/query hashes and provider state. Verify graph context against current source.

The server discovers `graphify` on `PATH` by default. Set `TYRANT_GRAPHIFY_BIN` if it lives elsewhere and `TYRANT_GRAPHIFY_TIMEOUT_MS` to a value from 1,000 to 300,000 milliseconds (default 120,000). A missing CLI, unsafe output path, stale/unreadable graph, timeout, or failed scoped query blocks code changes and appears in `graphify_context` and the task's `graphify` state. Tyrant does not install Graphify or change host settings.

## Host tiers from SPEC-01

| Host | Intended tier | Evidence in this SPEC |
| --- | --- | --- |
| Codex Desktop and CLI | Primary | Generic MCP stdio initialize, discovery, tool-call, and restart-recovery smoke; real Codex app/CLI not connected here |
| DeepSeek Harness Desktop and CLI | Primary | Generic MCP stdio contract only; DSH was not installed for a live host smoke |
| OpenCode | Supported | Generic MCP stdio contract only; live host smoke not run |
| Claude Desktop and CLI | Compatibility | Generic MCP stdio contract only; live host smoke not run |

An MCP server appearing in a host configuration is not compatibility evidence by itself. Before release, run the same prepare, checkpoint, restart, and recovery path in each listed host and record its version and result.

## Local smoke checks

Run from `D:\Working\Tyrant-Engine`:

```powershell
bun test
bun run typecheck
```

The stdio test launches Tyrant as a child Bun process and checks MCP protocol output. It does not claim that any of the desktop applications or external CLIs accepted their configuration.
