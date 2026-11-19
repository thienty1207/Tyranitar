# SPEC-00 — Tyrant Product Charter

Status: Draft for owner review  
Scope: Product intent and architecture  
Implementation authorization: None

## 1. Product intent

Tyrant is a compact, installable MCP orchestrator for software-development agents. It gives multiple AI clients a shared way to identify the project, route work to existing skills, recover task state and record evidence and handoffs.

Tyrant borrows design lessons from Baron—clear ownership, bounded context, recoverable state and evidence-based completion—while keeping a much narrower scope. It is a new product, not a Baron edition or wholesale port.

## 2. Users and hosts

The main user is a developer who wants an AI coding agent to keep project context and use specialist skills consistently without learning each client’s internal setup.

- Primary: Codex Desktop and CLI; DeepSeek Harness Desktop and CLI.
- Supported: OpenCode clients that connect to MCP.
- Compatibility: Claude Desktop and CLI, with smoke-level rather than deep testing.
- Distribution goal: any user can install Tyrant and connect it to supported clients without Baron or a hosted account.

The client supplies the model and credentials. Tyrant is provider-agnostic and does not require a DeepSeek API key.

## 3. Goals

1. Provide one stable MCP interface across supported hosts.
2. Route tasks by user intent, project evidence and applicable instructions.
3. Keep active task state compact and recoverable across sessions and context compaction.
4. Require ai-memory and Graphify as the shared project memory and code-map baseline for repository work.
5. Record which skills and checks were actually used, with reasons and evidence.
6. Make setup, update and removal understandable to non-technical users.
7. Keep Tyrant small by coordinating specialist tools instead of rebuilding them.

## 4. Non-goals

Tyrant does not provide its own model, chat UI, agent runtime or billing. It does not reimplement ai-memory, Graphify, Cloudflare’s audit method or the listed skills. It does not build frontend pages or run security scans itself. It does not execute arbitrary skill scripts or shell commands outside the host’s normal permission boundary. Local use does not require a cloud account or telemetry.

A skill being installed or recommended is never proof that the agent followed it.

## 5. Responsibility boundaries

| Part | Owns |
| --- | --- |
| AI client | Model calls, conversation, native tools, permissions and code edits |
| Tyrant Core | Project/task identity, route recommendation, task state, checkpoints and evidence references |
| Tyrant MCP | Versioned tools, resources and prompts that expose Core behavior |
| Host adapter | Minimal client setup and skill/lifecycle fallback |
| External skills | Specialist instructions and their own resources/scripts |
| ai-memory | Captured session observations, searchable history and explicit handoffs |
| Graphify | Derived repository code graph and graph queries |
| Git and project documents | Source code and approved project decisions |

Tyrant owns active task state. ai-memory provides required project history and handoffs, not authority to overwrite approved project decisions. Graphify provides the required derived code map and can be rebuilt from files.

Tyrant keeps named AI-Memory vault profiles and one active default in a per-user registry. Running `tyrant setup` inside a vault selects that vault; `tyrant setup <path>` selects the given vault from anywhere. The selection applies to future `tyrant init` operations across the user's projects. `tyrant init` saves the selected profile and a stable, project-specific AI-Memory scope. Changing the active default never rebinds an initialized project; it continues using its saved profile until the user explicitly rebinds it. Several projects may share one profile while retaining separate scopes. Graphify output remains local to each repository.

## 6. Initial routing policy

Matt Pocock’s engineering workflow is Tyrant’s **core orchestration skill family**, analogous to Superpowers in Baron. For every eligible software-development task, Tyrant routes the agent through the relevant Matt Pocock workflow first: understand the request, establish scope and constraints, choose a work sequence, and maintain engineering feedback. This is the default orchestration path, not an optional specialist route. If the host cannot load the native skill, Tyrant must report the limitation and use only a documented fallback rather than claim the skill ran.

For every repository task, preparation also retrieves the relevant ai-memory brief/handoff and the current Graphify map or scoped map result. This is required project context, not an optional specialist route. Keep both bounded to the active task; initialize or refresh them when missing or stale. If either required provider cannot be used, report the gap and block code-level work until it is restored; safe read-only diagnosis and setup may continue.

After that core workflow selects the task shape, Tyrant routes applicable specialists:

- Frontend implementation or redesign: Taste is required, respecting explicit user choices and established project design constraints.
- Security audit: Cloudflare security-audit when explicitly requested or required by an approved risk policy; source-only review is allowed, and target-controlled execution requires a verified OS-enforced sandbox.
- Continuity: retrieve relevant ai-memory context at task start/resume and save useful project handoffs as work progresses.

Select only the smallest useful skill set. A route recommendation is not proof of skill invocation.

## 7. Architecture

A host connects to Tyrant MCP. A short host instruction or adapter calls task preparation. Tyrant returns bounded project context, current state, route, skill IDs, requirements and next action. The host loads the selected skill natively where possible; other hosts may receive bounded instructions through MCP resources/prompts. Hooks report lifecycle events when supported; explicit checkpoints are the fallback.

MCP does not control or start the host’s model. The MCP interface, routing policy and host instructions work together.

## 8. Language and platform

Initial runtime preference: TypeScript on Bun. The official MCP TypeScript SDK supports Bun, so Tyrant does not need to default to Node.js. Use Node only when a particular external skill explicitly requires it; that does not change Tyrant’s runtime.

Keep the MVP to a small number of runtimes. Add Go, Python or Rust only for a concrete integration, distribution or maintenance benefit. MCP schemas and persisted event/state contracts remain language-neutral and versioned.

Cross-platform distribution is a product goal. Windows is the first development environment; operating-system support claims require evidence in SPEC-07.

## 9. Open decisions

Remaining decisions are the release/update format, exact pinned-client hook capabilities, and whether shared remote hosting is needed. Vault-profile selection, project binding, and pinned skill installation are specified in SPEC-03 and SPEC-06. Local-only is the MVP assumption.
