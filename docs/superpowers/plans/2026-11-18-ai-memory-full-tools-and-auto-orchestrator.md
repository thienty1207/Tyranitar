# Full AI-Memory Tools and Automatic Matt Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Expose the full pinned AI-Memory tool surface through Tyrant and auto-run Tyrant's Matt-inspired skill routing policy on repository tasks.

**Architecture:** Generate a reviewed JSON Schema contract from the connected AI-Memory server and register one namespaced Tyrant wrapper per upstream operation. Proxy calls use the existing authenticated provider, apply configured scope defaults, return redacted bounded results, and record operation/outcome metadata only. The host preflight will load Tyrant's built-in Matt policy without invoking manual-only upstream `ask-matt`, then load only the routed specialist skills.

**Tech Stack:** Bun, TypeScript, `@modelcontextprotocol/server` v2 `fromJsonSchema`, MCP client, Zod v4, Bun test.

**Spec:** `spec/SPEC-08-AI-MEMORY-ALL-TOOLS-AND-MATT-ORCHESTRATION.md`

Implementation status: complete; automated tests, typecheck, and integration builds passed. Live AI-Memory status and DSH Desktop tool invocation remain unverified.

## Global Constraints

- Keep AI-Memory history untrusted and project-scoped.
- Preserve explicit configured URL, auth, timeout, and scope.
- Never persist raw proxy arguments, memory bodies, RPC payloads, or credentials.
- Never label manual-only upstream `ask-matt` as auto-invoked.
- Keep the existing uncommitted worktree changes intact.
- Do not perform mutating live AI-Memory calls for acceptance.

## Review Focus

- Upstream schemas with `$defs`, `$ref`, unions, and nested objects remain discoverable and validate calls; test all 27 registrations and a nested-schema call.
- `scope: profile`/`global` must not accidentally inherit project/workspace; test both special scopes and default project scoping.
- Cross-project destinations must preserve their explicit fields without changing the default sender/project scope; test one message-like tool.
- Tool failures and large/secret values must not leak into Tyrant event history or response text; test redaction, truncation, and failed calls.
- A normal repository task must auto-run the internal Matt policy without loading `ask-matt`; an explicit ask-matt request must remain routable; test preflight output and selected skills.

---

### Task 1: Pin the complete AI-Memory tool contract

**Files:**
- Create: `vendor/ai-memory/tools.json`
- Create: `scripts/sync-ai-memory-tools.ts`
- Modify: `package.json`
- Modify: `src/routing/catalog.ts`
- Test: `tests/ai-memory-tools.test.ts`

**Interfaces:**
- Produces: `AI_MEMORY_UPSTREAM_TOOLS`, loaded from the generated JSON contract with exact upstream `name`, `description`, and `inputSchema`.

- [x] Add a failing test asserting the pinned contract is version 3.4.7, has 27 unique `memory_*` names, and carries valid object schemas.
- [x] Run `bun test tests/ai-memory-tools.test.ts` and confirm it fails because the contract is absent.
- [x] Implement the sync script using `getAiMemoryConfig`, authenticated `tools/list`, and atomic JSON output; it must never print the token.
- [x] Generate the checked-in contract from the live server and update the catalog pin to the matching verified v3.4.7 commit.
- [x] Run `bun test tests/ai-memory-tools.test.ts` and confirm the contract assertions pass.

### Task 2: Proxy all 27 operations through Tyrant

**Files:**
- Modify: `src/providers/ai-memory.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/contracts.ts`
- Modify: `src/state/store.ts`
- Modify: `tests/ai-memory.test.ts`
- Modify: `tests/task-tools.test.ts`
- Modify: `tests/stdio.test.ts`
- Test: `tests/ai-memory-tools.test.ts`

**Interfaces:**
- Consumes: `AI_MEMORY_UPSTREAM_TOOLS`.
- Produces: `AiMemoryProvider.invokeTool(name, args, sessionId?)` and one `tyrant_memory_<name>` MCP tool per contract entry.

- [x] Add failing tests for registration of all 27 wrappers and preservation of the upstream `inputSchema`.
- [x] Run the focused test and confirm it fails because only the nine Tyrant tools are registered today.
- [x] Add provider proxy with schema-aware scope defaults, auth/session headers, safe errors, redacted bounded responses, and rejection of names outside the pinned contract.
- [x] Register each upstream schema via SDK `fromJsonSchema`; keep all internal `tyrant_*` tools unchanged.
- [x] Add `ai_memory_tool_called` events that store only operation name, status, and host/session identity when available; never include raw arguments or results.
- [x] Add fixture coverage for read, write, profile/global, message destination, failure, and secret/size handling.
- [x] Run focused AI-Memory and MCP tests and confirm pass.

### Task 3: Make Matt orchestration automatic without native ask-matt

**Files:**
- Modify: `src/routing/catalog.ts`
- Modify: `src/routing/router.ts`
- Modify: `src/adapters/auto-preflight.ts`
- Modify: `src/adapters/dsh.ts` only if loader typing requires it
- Modify: `docs/SKILL-CATALOG.md`
- Modify: `spec/SPEC-02-SKILLS-AND-ROUTING.md`
- Modify: `tests/routing.test.ts`
- Modify: `tests/host-adapters.test.ts`
- Modify: `tests/task-tools.test.ts`

**Interfaces:**
- Produces: an internal `tyrant-matt-orchestrator` load result with method `tyrant_builtin_policy`; the upstream `matt-ask-matt` entry remains manual-only.

- [x] Add failing tests that ordinary repository work loads the built-in Matt policy and never calls the host loader for `ask-matt`.
- [x] Add failing tests that explicit ask-matt questions select the manual route while feature, bug, frontend, review, and security work selects matching specialists automatically.
- [x] Run focused routing/adapter tests and confirm the expected failures.
- [x] Implement built-in policy injection, safe-default/no-per-step-approval wording, explicit manual ask-matt routing, and truthful event/source metadata.
- [x] Run focused routing and adapter tests and confirm pass.

### Task 4: Document acceptance and verify the complete route

**Files:**
- Modify: `spec/SPEC-03-TASK-STATE-AND-CONTINUITY.md`
- Modify: `spec/SPEC-07-ACCEPTANCE-AND-ROADMAP.md`
- Modify: `docs/MCP-HOST-COMPATIBILITY.md`
- Modify: `docs/TASK-CONTINUITY.md`
- Modify: `docs/SKILL-CATALOG.md`
- Modify: `README.md`

- [x] Add acceptance tests that `tools/list` returns all 27 AI-Memory wrappers plus the existing Tyrant MCP tools.
- [x] Run focused acceptance tests.
- [x] Run `bun test`, `bun run typecheck`, and `bun run build:integrations`.
- [ ] Against live AI-Memory, verify schema/version discovery and use read-only status/briefing/query calls only; do not call mutating tools.
- [x] Inspect `git diff --check` and the final diff; preserve unrelated pre-existing dirty files.
- [x] Record that real DSH Desktop model invocation remains pending if the host still cannot complete a credentialed task.
