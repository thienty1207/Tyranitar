# SPEC-01 — MCP Contract and Host Compatibility

Status: Implemented locally; generic MCP verification passed; live host smoke pending  
Depends on: SPEC-00

## 1. Purpose

Define one stable MCP contract for Codex, DeepSeek Harness, Claude and OpenCode. Host differences belong in thin setup/fallback adapters, not separate routing engines.

## 2. Operating model

The MVP is a local MCP server written in TypeScript and run with Bun; STDIO is the initial transport unless a client requires another supported option. Remote multi-user hosting is out of scope until a real need appears.

Development runs the TypeScript entry point with Bun. Release packaging should evaluate Bun’s standalone compile output so end users may not need to install a JavaScript runtime. Verify the compiled executable’s stdio behavior and path/config handling on each supported OS before selecting it as the release format.

Tyrant does not call a model or initiate a conversation. The client asks for task state and routing, then uses its own tools and skill-loading path.

## 3. Initial MCP tools

Names are namespaced with tyrant_ and use versioned JSON schemas.

| Tool | Purpose |
| --- | --- |
| tyrant_prepare_task | Identify/create a task; return bounded state, route, skills and next action |
| tyrant_get_task | Read current task and latest checkpoint |
| tyrant_list_skills | List names, descriptions, versions, requirements and invocation policy |
| tyrant_checkpoint | Save phase, last reliable step, evidence references, blocker and next action |
| tyrant_record_event | Record a route, skill invocation or lifecycle event |
| tyrant_record_evidence | Record a check result and evidence reference |
| tyrant_finish_task | Mark completed, blocked or handed off with a concise summary |

Outputs are bounded; they must not copy full transcripts or large repository files into context. Status reads are read-only. Writes are project-scoped and safe to retry where possible. Exact fields, errors and versioning follow host capability checks.

## 4. Resources and prompts

Tyrant may expose read-only resources for project profile, routing policy and task summary, plus reusable prompts for task start, checkpoint and handoff. Host instructions remain short and do not duplicate the full skill catalog or history.

## 5. Skill-loading boundary

Tyrant can recommend skill IDs and order; it cannot force a client to invoke a native skill. Hosts with a skill loader use it. Hosts without one may receive bounded instructions through Tyrant resources/prompts. Skill scripts still run under host tool permissions.

## 6. Compatibility tiers

| Client | Tier | Initial requirement |
| --- | --- | --- |
| Codex Desktop and CLI | Primary | Connect, prepare, route, checkpoint and recover |
| DeepSeek Harness Desktop and CLI | Primary | Connect through supported MCP/plugin configuration and load available skills |
| OpenCode | Supported | Use common MCP contract; verify CLI path |
| Claude Desktop and CLI | Compatibility | Smoke test connect, prepare, status and checkpoint |

Verify exact client versions. A server entry in a config file alone does not prove compatibility.

## 7. Failures and retries

If Tyrant is unavailable, report missing routing/state and proceed only when safe without it. Missing required ai-memory or Graphify blocks repository code work until restored; a missing optional specialist returns a named fallback. Incomplete MCP discovery is visible and cannot be called complete. Retries must not duplicate checkpoints or completion. Host setup preserves unrelated settings and is reversible.
