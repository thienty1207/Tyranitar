# Tyrant Autopilot Setup Implementation Plan

> **For agentic workers:** Execute natively in this session. Steps use checkbox syntax for tracking.

**Goal:** Make setup idempotently install the DSH host adapter once, keep project/vault resolution dynamic, and self-heal managed AI-Memory and Graphify runtimes before model work.

**Architecture:** Add a user-profile DSH plugin manager and invoke it from `tyrant setup` and DSH-enabled `tyrant init`. Keep host configuration project-local while provider bindings remain in `.tyrant/project.json`. Add guarded runtime recovery to Graphify and AI-Memory preflight paths so only verified managed runtimes become ready.

**Tech Stack:** Bun 1.4+, TypeScript, DSH CLI/profile package manifests, AI-Memory MCP runtime, managed Graphify/uv/Python runtime.

**Spec:** `docs/superpowers/specs/2026-11-20-tyrant-autopilot-setup-design.md`, `spec/SPEC-04-GRAPHIFY-INTEGRATION.md`, `spec/SPEC-06-DISTRIBUTION-AND-SETUP.md`, `spec/SPEC-07-ACCEPTANCE-AND-ROADMAP.md`

## Global Constraints

- Vault selection is user-default state; project bindings remain pinned until explicitly rebound.
- DSH plugin installation is user/profile-scoped and idempotent; project/vault selection is task/project-scoped.
- Graphify stays pinned to `0.9.109`; AI-Memory stays pinned to `3.4.7`.
- Runtime downloads retain checksum and identity verification; never expose credentials in output or logs.
- Provider gaps still block code changes; automatic recovery must not weaken the gate.
- Do not overwrite host-owned settings or bypass host trust/approval controls.

## Review Focus

- DSH package already points to the current Tyrant root: verify the CLI skips installation.
- DSH package points to an older local root: verify one update occurs and later project/vault changes skip it.
- DSH supplies global AI-Memory credentials while the project is vault-bound: ensure the child receives only that saved profile's auth, endpoint and scope.
- DSH profile is absent or malformed: bootstrap the selected profile safely or return a stable error without corrupting the profile.
- Graphify executable/version is missing or mismatched: use the pinned managed runtime, preserve explicit user overrides, and keep the provider blocked if verification fails.
- AI-Memory endpoint is stopped or belongs to another vault: restart only the configured profile and reject foreign endpoint identity.

---

### Task 1: Idempotent DSH user-profile plugin manager

**Files:** Create `src/setup/dsh-runtime.ts`; create `tests/dsh-runtime.test.ts`.

**Interface:** `ensureDshPlugin(options) -> Promise<{ status: "installed" | "ready" | "not_detected"; profile: string; packageRoot?: string }>` with injectable `command`, `profile`, `env`, and `runCommand` for tests.

- [x] Test missing plugin installs into the selected profile with scripts disabled.
- [x] Test matching local package identity returns `ready` without invoking DSH CLI.
- [x] Test a different local package path triggers one update; a second call is a no-op.
- [x] Test missing DSH CLI returns `not_detected`, and malformed profile metadata returns a stable error.
- [x] Run `bun test tests/dsh-runtime.test.ts` and observe the expected failures.
- [x] Implement safe profile resolution, package identity comparison, and `dsh plugin --profile <name> add --ignore-scripts file:<root>` execution.
- [x] Run `bun test tests/dsh-runtime.test.ts` and confirm all cases pass.

### Task 2: CLI and project adapter automation

**Files:** Modify `src/cli.ts`, `src/adapters/project-setup.ts`; modify `tests/cli.test.ts`, `tests/project-setup.test.ts`.

- [x] Add a failing test proving `tyrant setup` invokes the DSH manager once and reports its result.
- [x] Add a failing test proving DSH-enabled `tyrant init` ensures the profile plugin before project writes.
- [x] Replace DSH `manual_required` project status/manual command with a user-profile-managed status.
- [x] Verify changing a vault default and initializing/reinitializing another project does not reinvoke DSH install when its package identity already matches.
- [x] Run the focused CLI and project setup tests before and after implementation.

### Task 3: Provider runtime recovery during automatic preflight

**Files:** Modify `src/providers/graphify.ts`, `src/providers/ai-memory.ts`; modify `tests/graphify.test.ts`, `tests/ai-memory.test.ts`.

- [x] Test that missing Graphify runtime invokes the pinned manager before project extraction and query.
- [x] Test that a failed Graphify bootstrap remains unavailable and does not produce a ready map.
- [x] Test that a bound AI-Memory profile invokes `ensureAiMemoryProfile` before loading context and refreshes the config after service recovery.
- [x] Test that unbound projects do not start any AI-Memory runtime and remain `scope_missing`.
- [x] Run focused provider tests, then the complete `bun test` and `bun run typecheck`.

### Task 4: Acceptance specs, onboarding and built integrations

**Files:** Modify `README.md`, `spec/SPEC-04-GRAPHIFY-INTEGRATION.md`, `spec/SPEC-06-DISTRIBUTION-AND-SETUP.md`, `spec/SPEC-07-ACCEPTANCE-AND-ROADMAP.md`.

- [x] Document one-time DSH profile installation through Tyrant commands; remove per-project `dsh plugin add` instructions.
- [x] Document vault switching and project binding behavior, including explicit rebind for existing projects.
- [x] State that Tyrant manages uv/Python and Graphify automatically.
- [x] Run `bun test`, `bun run typecheck`, and `bun run build:integrations`; inspect `git diff --check` and the final diff.
- [x] Run a real project preflight for `D:\Working\fiber-api` and record provider, route, project, and DSH profile status without exposing credentials.
- [ ] Filter DSH global AI-Memory auth/path/scope overrides only for projects with an explicit vault binding, and retain environment-based config for unbound projects.
- [ ] Rebuild and reinstall the DSH bundle, then run the actual desktop pre-step after one host reload.
