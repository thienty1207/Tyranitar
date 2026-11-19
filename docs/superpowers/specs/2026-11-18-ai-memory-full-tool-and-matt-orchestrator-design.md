# AI-Memory Full Tool Surface and Matt Orchestrator Design

## Intent

Tyrant should give connected agents all 27 operations from the configured AI-Memory server while retaining automatic project memory, task handoff, Graphify context, and bounded local state. Matt Pocock's engineering approach should operate as Tyrant's always-on router; the manual-only upstream `ask-matt` skill must not become a gate for normal work.

## Goals

- Make all upstream AI-Memory operations available through distinct Tyrant MCP tools with their original schemas and descriptions.
- Preserve explicit project scope, authentication, bounded output, secret redaction, and minimal local operation logs.
- Automatically route and load relevant Matt, Taste, and security skills for each repository task.
- Proceed through ordinary scoped coding work without asking for approval at each step, recording safe assumptions.

## Non-goals

- Do not invoke all 27 AI-Memory tools on every task.
- Do not persist full memory content or tool arguments in Tyrant's event log.
- Do not claim native `ask-matt` invocation or DSH live acceptance based on fixtures.
- Do not change DSH's host-level command permission configuration.

## Approaches

1. A single generic `call` tool with an operation name and untyped arguments. It is small but hides per-operation schemas from hosts and makes accurate selection harder.
2. A generated, versioned upstream tool contract registered as one Tyrant wrapper per operation. This keeps all 27 operations discoverable with accurate descriptions and validation, while allowing the runtime to fail closed if an operation is absent upstream. **Chosen** because it gives the model precise tools and makes version drift reviewable.
3. Connect to AI-Memory before serving and build all schemas only from the live server. This adapts to upstream automatically, but tool discovery then depends on the memory service being available during Tyrant startup.

## Design decisions

- Use one static contract snapshot generated from `tools/list`, pinned to the AI-Memory version/commit observed at generation. A sync script refreshes the snapshot for reviewed upgrades.
- Name wrappers `tyrant_memory_<upstream-name>` and keep Tyrant's existing internal memory lifecycle calls on the same authenticated provider.
- Inject configured workspace/project only for schema-supported fields that the caller omitted. Preserve explicit profile/global scope and upstream-supported destination fields.
- Bound and redact proxied results. Persist only operation name and outcome against the current task; never persist raw arguments or memory bodies.
- Build a first-party Matt routing policy inside Tyrant. Always run it; auto-select and inject required/relevant specialist bodies. Keep upstream `ask-matt` manual-only and select it only on an explicit user request.
- Treat routine repository reads, edits, and checks as approved by the user's task request; use safe assumptions rather than approval prompts. Destructive or externally visible operations still require explicit user intent. Host-level command permissions remain controlled by the host.

## Constraints and risks

- AI-Memory schemas and operation names can drift. The generated contract's version/commit and a refresh script make that drift visible.
- Full tool descriptions increase the host tool menu. Per-tool routing and task-specific skill loading keep irrelevant instructions out of the model context.
- Cross-project, profile/global, destructive, and LLM-backed operations have broader effects than normal project retrieval. Preserve upstream descriptions and explicit scope; do not auto-run such operations as routine preflight.
- DSH live acceptance has previously stopped before Tyrant due to missing credentials. This implementation can prove adapter fixtures and real read-only AI-Memory calls; it cannot claim a live DSH model used the tools until that session is observed.
