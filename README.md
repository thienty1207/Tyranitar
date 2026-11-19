# Tyrant Engine

Tyrant is a local MCP orchestrator for coding agents. It applies its Matt Pocock-inspired workflow policy, routes work to host skills, and keeps durable task state. It does not call a model.

Task state is stored in plaintext SQLite. Common credential patterns are redacted before persistence, but detection is best-effort and incomplete: do not put passwords, API keys, tokens, or other secrets in task, checkpoint, event, or evidence text. The MVP caps the database at 64 MiB, limits each project to 250 tasks, and stops accepting new writes after 1,000 stored mutations.

## Requirements

- Bun 1.4 or newer
- Install dependencies with bun install

## Run

From the project the agent should work on:

    bun --cwd="D:\path\to\project" run "D:\path\to\Tyrant-Engine\src\index.ts"

The server uses TYRANT_PROJECT_ROOT when set; otherwise it scopes tasks to its process working directory. State is stored under %LOCALAPPDATA%\Tyrant\tyrant.sqlite3 on Windows, or the platform state directory. Set TYRANT_STATE_DIR to change that location.

## Current implementation

- **SPEC-01:** project-scoped MCP task tools, local SQLite persistence, retry-safe mutations, and bounded error responses.
- **SPEC-02:** deterministic skill catalog and routing. Tyrant applies its internal Matt Pocock-inspired workflow before returning ordered host skill instructions. Host-native skill execution is not independently verified by Tyrant.
- **SPEC-03:** task lifecycle, rich checkpoints/events, additive legacy database migration, and a direct ai-memory MCP adapter. Setup and recovery details are in [Task continuity](docs/TASK-CONTINUITY.md).
- **SPEC-08:** all 27 pinned AI-Memory tools are exposed through Tyrant MCP, with scoped proxying, redacted bounded results, and outcome-only task events. Tyrant's Matt-inspired orchestrator runs automatically and selects relevant specialist skills without approval prompts for routine route selection.
- **SPEC-04:** Graphify's local code-only CLI adapter refreshes the derived map at task preparation, runs a bounded query, and persists graph/query references separately from ai-memory history. Missing or stale Graphify still blocks code changes; safe diagnosis and provider setup can continue.
- **SPEC-05:** explicit audits route to Cloudflare Security Audit; source review is available, while target-controlled execution stays blocked until an OS-enforced sandbox is verified.
- **SPEC-06:** automatic DSH, Codex, OpenCode, and Claude Code adapters; project-scoped setup/rollback; pinned skill files and resource bundles installed with hash checks. Fixtures pass; live host activation is still pending.

Matt Pocock orchestration is Tyrant's required first policy. Tyrant applies its own built-in Matt-inspired policy on every repository task, then automatically loads the relevant specialist skills. The upstream `ask-matt` skill remains available when the user explicitly asks to consult it; Tyrant does not claim an implicit native invocation. Taste loads for frontend routes and Cloudflare Security Audit for security routes. Site Clone is not included.

## Provider and privacy boundaries

ai-memory stores searchable historical observations and handoffs. Tyrant stores active task state and logs proxy operation names/outcomes without copying tool arguments or memory results. Retrieved history is marked untrusted and must be checked against current project instructions and source. Tyrant does not mirror the ai-memory wiki or store full transcripts.

See [Skill catalog and routing](docs/SKILL-CATALOG.md) for pinned sources and trigger rules, and [MCP host compatibility](docs/MCP-HOST-COMPATIBILITY.md) for supported host boundaries.
