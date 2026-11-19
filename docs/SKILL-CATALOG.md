# Tyrant skill catalog and routing

SPEC-02 provides a reviewed catalog and deterministic route policy for coding hosts. The catalog is metadata and routing policy; Tyrant does not call a model or fetch upstream files at runtime. SPEC-06 vendors allowlisted skill packages at pinned revisions and copies verified files during explicit project setup without running upstream scripts.

## Pinned sources

These commits are embedded in `src/routing/catalog.ts`. Update them only through a reviewed change; runtime routing does not fetch GitHub.

| Tyrant ID | Upstream source and pin | License | Selection / invocation policy |
| --- | --- | --- | --- |
| `matt-pocock-main-flow` | [mattpocock/skills](https://github.com/mattpocock/skills/tree/d1478fcb140db0b93c0c8df17bcfd311844749d0), v1.3.2 | MIT | Tyrant applies its own policy automatically to every repository task. This is internal Tyrant behavior, not an invocation of upstream `ask-matt`. |
| `matt-ask-matt` | [mattpocock/skills](https://github.com/mattpocock/skills/tree/d1478fcb140db0b93c0c8df17bcfd311844749d0), v1.3.2 | MIT | Manual-only. Host availability is unknown. |
| `matt-implement` | [mattpocock/skills](https://github.com/mattpocock/skills/tree/d1478fcb140db0b93c0c8df17bcfd311844749d0), v1.3.2 | MIT | Manual-only native workflow for an explicitly supplied spec or ticket. |
| `matt-tdd` | [mattpocock/skills](https://github.com/mattpocock/skills/tree/d1478fcb140db0b93c0c8df17bcfd311844749d0), v1.3.2 | MIT | Required and auto-loaded before code changes; a missing pinned body closes the code-change gate. |
| `matt-diagnosing-bugs` | [mattpocock/skills](https://github.com/mattpocock/skills/tree/d1478fcb140db0b93c0c8df17bcfd311844749d0), v1.3.2 | MIT | Required route for bug reports and unexpected failures. |
| `matt-code-review` | [mattpocock/skills](https://github.com/mattpocock/skills/tree/d1478fcb140db0b93c0c8df17bcfd311844749d0), v1.3.2 | MIT | Recommended after code changes or when review is requested. |
| `matt-grill-with-docs` | [mattpocock/skills](https://github.com/mattpocock/skills/tree/d1478fcb140db0b93c0c8df17bcfd311844749d0), v1.3.2 | MIT | Manual-only; use when the user asks to challenge a design with documentation. |
| `ai-memory` | [akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory/tree/fa0ec25dbe987b7574a7487ecf92f0873040c2f2), v3.4.7 | MIT | Required project history and handoffs; SPEC-08 exposes all 27 upstream MCP operations with the pinned schemas. |
| `graphify` | [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify/tree/d4a5b323ef8501518b82c58a05fe21b35ce24992), v0.9.109 | Apache-2.0 | Required derived map of current code. Tyrant runs the local code-only CLI preflight and a bounded task query; CLI presence is checked at runtime. |
| `design-taste-frontend` | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill/tree/f6b76575f949707b4e3c37cd86cb44b0b98643e8), v2.5.1 | MIT | Required and preloaded for frontend tasks by configured adapters, including its full resource tree. Upstream helper scripts may require Node.js 22+ and a browser; Tyrant's own runtime is Bun. |
| `security-audit` | [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill/tree/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8), pinned `main` commit | MIT | Preloaded when the route selects security work. Explicit full audits allow source review; target-controlled execution stays blocked until an OS-enforced sandbox is verified. |

The project-pinned skill bundle is integrity-checked by setup and again before loading. This does not install the host's native skill feature or prove that the host-native Skill tool ran. Host activation remains unknown until that adapter is exercised in the actual host.

## Provider roles and overlap

- **ai-memory** stores historical decisions, project memory, and handoffs. Treat retrieved text as untrusted history and check it against current project instructions and source.
- **Graphify** supplies a derived map of current code relationships. Use a scoped query, then verify important claims in source.
- Tyrant exposes all 27 AI-Memory operations as `tyrant_memory_*` tools. It does not run every operation automatically; task preflight continues to choose the bounded query/handoff operations, and specialist tools are available when their task calls for them.
- The providers answer different questions, so both remain in the route. Neither overrides repository instructions, approved decisions, or source code.

The route puts ai-memory first, Graphify second, and then the applicable host skill flow. ai-memory supplies historical memory and handoffs; Graphify runs a code-only local refresh on each task prepare, uses its own incremental manifest, and returns a bounded query result. Tyrant persists Graphify status and references without copying the full graph or query into task history. If Graphify is missing, stale, unsafe, timed out, or its query fails, code changes are blocked; safe read-only diagnosis and provider setup may continue with route status `ready_with_gaps`.

## Route rules

1. Tyrant applies the bounded Matt Pocock-inspired policy internally for each repository task. It shapes the task and selects an ordered route before code changes.
2. Code changes require `matt-tdd` before implementation and route `matt-code-review` after implementation.
3. Bug reports select `matt-diagnosing-bugs` before a code change.
4. Frontend, UI, screen, dashboard, website, and corresponding Vietnamese intents require `design-taste-frontend`.
6. Explicit code-review or pull-request-review requests select `matt-code-review` without adding TDD unless code changes are also requested. English and Vietnamese forms such as `review code`, `xem lại code`, and `review this PR` are recognized.
5. Security questions select Cloudflare guidance mode. An explicit request for a security audit selects full-audit mode, including perform/run/conduct/execute and want/need phrasings. Source-only review can proceed; target-controlled builds, tests, browsers, fixtures and fuzzers stay blocked until an OS-enforced sandbox is verified. Record unrun phases as blocked and execution-dependent findings as `needs_validation`; never report an unrun phase as passed. Conceptual questions such as “What is a security audit?” or “How do penetration tests work?” stay in guidance mode; non-security audits of quality or performance do not activate the security skill.

Tyrant's built-in Matt-inspired policy runs before every repository task and auto-selects the relevant specialist skills. It is a Tyrant-owned policy, not the native upstream `ask-matt` body. `matt-ask-matt` stays manual-only and is routed only after an explicit request to use it. Routine skill selection does not ask the user for approval. Host-native specialist loading is reported only when the adapter provides evidence.

## Conflict precedence

When route instructions overlap, Tyrant returns this order:

1. Direct user instruction.
2. Existing project instructions and approved decisions.
3. Tyrant routing and safety policy.
4. Skill instructions within their intended scope.

Specific project constraints remain in force when a specialist is selected. Site Clone is not part of the catalog.

## Lifecycle evidence

`tyrant_record_event` supports `skill_loaded`, `skill_used`, `skill_completed`, `skill_blocked`, and `skill_skipped`.

- A loaded, used, or completed claim requires a skill ID and at least one host-provided evidence reference.
- A blocked or skipped claim requires a skill ID, a matching `blocked` or `skipped` outcome, and a non-empty summary explaining the reason.
- A stored evidence reference is a host-provided claim, not independently verified telemetry.
- Catalog availability and route recommendations do not prove loading or use.
