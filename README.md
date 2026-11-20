# Tyrant Engine

## Install and set up

Windows source install (Bun 1.4+ and Git required):

```powershell
git clone --depth 1 https://github.com/thienty1207/Tyranitar.git Tyranitar
Set-Location .\Tyranitar
bun install --frozen-lockfile
bun install --global .
```

This installs the current source checkout and its `tyrant` command. If Windows cannot find `tyrant`, add the path from `bun pm bin -g` to your user PATH and open a new terminal. Checksum-verified Tyrant release packages are not published yet.

Create or select any AI-Memory vault profile. The label is yours; Tyrant does not assign project types:

```powershell
tyrant setup "D:\path\to\your\vault" --name "your label"
```

Or, from inside an existing vault folder, run `tyrant setup --name "your label"`. Setup privately downloads AI-Memory `3.4.7` when no matching executable is available, verifies the official Windows archive checksum, extracts only `ai-memory.exe` into Tyrant's user runtime, and initializes a fresh vault using its configured token file. It then installs or checks Graphify `0.9.109`, selects that vault as the default for future projects, and ensures the Tyrant plugin is installed in the DSH user profile when the `dsh` CLI is available. That DSH plugin is shared across projects; it reads the current agent's project root and that project's saved vault binding for every task. Tyrant keeps its AI-Memory, Graphify, uv, and Python runtimes in its own user state; you do not need to install those runtimes manually. The pinned AI-Memory source and checksum are published on the [v3.4.7 release](https://github.com/akitaonrails/ai-memory/releases/tag/v3.4.7).

Initialize a project from its root:

```powershell
Set-Location "D:\path\to\project"
tyrant init
```

Use another saved vault deliberately with `tyrant init --vault "your label"`. A project already initialized stays bound to its saved profile when the default changes; explicit `--vault` is the rebind path. Running `tyrant setup` for another vault changes the default for projects initialized afterward. `tyrant setup` and `tyrant init` automatically manage one shared Tyrant plugin in the selected DSH user profile. They install or update it only when it is missing, points to another Tyrant checkout, or its installed integration bundle is stale; switching projects or vaults does not reinstall it. For a project with a saved vault binding, Tyrant ignores global AI-Memory environment overrides from DSH and uses that project's profile; unbound projects can still use explicit environment configuration. If DSH was open during its first install or an update, restart DSH once so it reloads the plugin. Run `tyrant status` to inspect the current binding without displaying credentials, or `tyrant doctor` to check provider connectivity.

Tyrant is a local MCP orchestrator for coding agents. It applies its Matt Pocock-inspired workflow policy, routes work to host skills, and keeps durable task state. It does not call a model.

Task state is stored in plaintext SQLite. Common credential patterns are redacted before persistence, but detection is best-effort and incomplete: do not put passwords, API keys, tokens, or other secrets in task, checkpoint, event, or evidence text. The MVP caps the database at 64 MiB, limits each project to 250 tasks, and stops accepting new writes after 1,000 stored mutations.

## Requirements

- Bun 1.4 or newer
- Install dependencies with `bun install`

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
