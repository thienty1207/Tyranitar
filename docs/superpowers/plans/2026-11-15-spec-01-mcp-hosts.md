# SPEC-01 MCP Contract and Host Compatibility Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` inline; follow the test-first steps and keep Baron as the development workflow only.

**Goal:** Implement and verify one local Bun MCP server that exposes Tyrant’s versioned tool contract over stdio for all planned hosts.

**Architecture:** Keep the MCP adapter thin over a project-scoped task service. Persist bounded task/checkpoint/event/evidence data locally with SQLite, expose the seven SPEC-01 tools plus bounded read-only resources/prompts, and return Matt Pocock as the mandatory first workflow with ai-memory and Graphify as required context. The server makes no model calls; detailed specialist routing belongs to later specs.

**Tech Stack:** TypeScript on Bun 1.4.4, official MCP TypeScript server/client SDK v2, Zod v4, Bun’s built-in SQLite, and `bun test`.

**Spec:** `spec/SPEC-01-MCP-AND-HOSTS.md`

## Global Constraints

- Use stdio as the initial local transport; do not add a model runtime or remote hosting.
- Prefix tools with `tyrant_` and include `schema_version: 1` in persisted and returned contract objects.
- Keep outputs bounded; do not persist transcripts, source files, full shell output, or provider secrets.
- Status reads are read-only; mutations are project-scoped and idempotent by request ID.
- Never write protocol or diagnostic logs to stdout.
- Keep host differences in small launch/configuration notes; the server does not claim a host app was tested unless it actually was.
- Baron is only the development workflow; Tyrant’s core agent workflow remains Matt Pocock.

## Review Focus

- A task ID from one project must never expose or mutate another project’s state.
- Repeating a mutation with the same request ID and payload returns the original result; reusing the ID with a different payload is a conflict.
- Invalid or oversized tool input returns a safe, bounded protocol error without leaking paths, SQL, or stack traces.
- Stdio stays valid MCP JSON-RPC even when diagnostics or failures occur.
- A restarted server can recover a task and its latest checkpoint from local state.

---

### Task 1: MCP Contract and Project-Scoped State

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/contracts.ts`, `src/state/store.ts`
- Create: `tests/stdio.test.ts`, `tests/task-tools.test.ts`
- Modify: `src/index.ts`, `src/mcp/server.ts`

**Interfaces:**
- `TyrantStore` resolves the canonical project scope and opens the local SQLite state.
- `TyrantStore.prepare`, `getTask`, `checkpoint`, `recordEvent`, `recordEvidence`, and `finish` implement project-scoped state operations.
- `createTyrantServer() -> McpServer`

- [x] Configure the Bun package and write a Bun-spawned stdio protocol test for `initialize` and `tools/list`. Confirmed the expected red test before the MCP shell existed. Handler coverage uses the runtime-neutral in-memory transport.
- [x] Implement the MCP server shell and handlers for initialization and tool discovery.
- [x] Write behavior tests for project read/write isolation, persistence after process restart, request-ID retry behavior, conflicting request reuse, and bounded errors.
- [x] Implement the SQLite-backed store and versioned Zod contracts, project isolation, retry safety, migration, bounded local-state quotas, and best-effort credential redaction.
- [x] Implement all seven tools, bounded safe errors, resource/prompt guidance, Matt Pocock-guided routing, required ai-memory/Graphify context, and no model calls.
- [x] Exercise every tool and resource/prompt, verify read/write semantics, and restart the stdio process to recover a checkpoint and finish next action.
- [x] Run `bun test` and `bun run typecheck`; latest results are 9 tests passing with 72 assertions and exit 0 for typecheck.

### Task 2: Host Compatibility Contract and Evidence

**Files:**
- Create: `docs/MCP-HOST-COMPATIBILITY.md`
- Modify: `README.md`, as created by Task 1
- Test: `tests/stdio.test.ts`

**Interfaces:**
- Consumes: `createTyrantServer` and the seven versioned SPEC-01 tool contracts from Task 1.
- Produces: a host matrix and a repeatable generic stdio smoke command; no host-specific installer ownership.

- [x] Document the command/working-directory contract and primary, supported, and compatibility tiers from SPEC-01.
- [x] Add a stdio smoke that parses MCP protocol output; diagnostics are directed to stderr by the Bun entry point.
- [x] Run the full SPEC-01 local verification set and record real host apps/CLIs not smoke-tested; documentation makes no compatibility claim beyond local protocol evidence.

