# Tyrant Vault Setup and Project Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `tyrant setup` and `tyrant init` so users can select any AI-Memory vault as their per-user default while every initialized project remains pinned to its own profile and scope.

**Architecture:** Store named vault profiles in a per-user Tyrant registry and save a stable profile ID plus project scope in each initialized repository. Resolve AI-Memory endpoint/auth from that binding, provision AI-Memory without its broad host installer, manage the pinned Graphify CLI/runtime separately, and expose the workflow through a Bun CLI.

**Tech Stack:** Bun 1.4+, TypeScript, Node-compatible filesystem/crypto/process APIs, AI-Memory CLI, Graphify CLI, uv as Tyrant-managed Python tooling.

**Spec:** `spec/SPEC-03-TASK-STATE-AND-CONTINUITY.md`, `spec/SPEC-04-GRAPHIFY-INTEGRATION.md`, `spec/SPEC-06-DISTRIBUTION-AND-SETUP.md`, `spec/SPEC-07-ACCEPTANCE-AND-ROADMAP.md`

## Global Constraints

- `tyrant setup [<vault-path>] [--name <profile>]` uses the current directory when no path is supplied and selects that vault for future project initialization.
- Vault/profile names are user-defined labels; Tyrant has no Web/Desktop profile defaults or project-type inference.
- `tyrant init [--vault <profile>]` uses the explicit profile or current user default; re-running init without an override preserves an existing project binding.
- An initialized project resolves AI-Memory through its stored profile ID and complete, stable `workspace`/`project` scope; it never falls back to the active default.
- Fresh AI-Memory setup reuses the upstream configured bearer-token file; token bytes never enter argv, host settings, project files, logs, or the profile registry.
- Provider setup must not run AI-Memory's broad harness installer or Graphify's host installer; Tyrant owns host wiring.
- Graphify is pinned to version `0.9.109`, runs code-only extraction, and writes only to each project’s `graphify-out/`.
- Users do not manually install Python or `uv`; Tyrant provisions a managed runtime when required.
- A missing or conflicting profile, endpoint, auth file, or provider closes setup/preflight with an actionable error; no silent fallback is allowed.

## Review Focus

- Windows case-insensitive paths and symlink aliases: canonicalize once and reuse the same profile instead of creating duplicates.
- Two vaults with arbitrary names and multiple projects with identical folder basenames: keep endpoint and memory scopes isolated.
- Existing configured and generated `bearer_token_file` paths: read the configured path without rotating or logging the token.
- Repeated `setup`/`init` and a changed active default: preserve prior data, profiles, and initialized project bindings.
- An occupied local port or a service that answers for another vault: reject identity mismatch; never use whichever server responds.

---

### Task 1: Per-user vault profile registry and project binding

**Files:**
- Create: `src/setup/profiles.ts`
- Create: `tests/profile-registry.test.ts`
- Modify: `spec/SPEC-06-DISTRIBUTION-AND-SETUP.md`
- Modify: `spec/SPEC-07-ACCEPTANCE-AND-ROADMAP.md`

**Interfaces:**
- `getTyrantUserDirectory(env?, platform?) -> string`
- `loadProfileRegistry({ stateDirectory? }) -> Promise<ProfileRegistry>`
- `activateVaultProfile({ vaultPath, name?, endpoint, configPath, tokenFile? }, options?) -> Promise<Profile>`
- `bindProjectProfile({ projectRoot, profile, explicitRebind? }, options?) -> Promise<ProjectBinding>`
- `resolveProjectProfile(projectRoot, options?) -> Promise<{ profile: Profile; binding: ProjectBinding } | undefined>`

- [x] Write tests for current-directory/default selection, arbitrary names, canonical-path reuse, profile-name collisions, no-default init, explicit rebind, repeat init preservation, and distinct scopes for same-basename projects.
- [x] Run `bun test tests/profile-registry.test.ts` and confirm the new behavior fails for the expected missing API/behavior.
- [x] Implement the user registry and project binding with atomic writes and profile IDs; do not change the active default until setup has completed provider validation.
- [x] Run `bun test tests/profile-registry.test.ts` and `bun run typecheck`.
- [x] Record the chosen stable project-scope format in the SPEC-06 acceptance section.

### Task 2: Profile-aware AI-Memory config and provider runtime

**Files:**
- Create: `src/setup/ai-memory-runtime.ts`
- Create: `tests/ai-memory-profile.test.ts`
- Modify: `src/providers/ai-memory.ts`
- Modify: `src/mcp/server.ts`

**Interfaces:**
- `readAiMemoryProfileConfig(profile) -> { url, configPath, tokenFile?, authToken?, bindHost, port }`
- `ensureAiMemoryProfile(profile, dependencies?) -> Promise<{ endpoint, authStatus, version }>`
- `AiMemoryProvider` continues accepting an explicit config for fixtures and otherwise resolves the current project’s saved binding.

- [x] Write tests proving a bound project selects its saved profile after the user default changes, a custom configured token-file path is used, fresh upstream `auth-tokens/default` works, and missing credentials/identity mismatch produce safe blockers.
- [x] Run `bun test tests/ai-memory-profile.test.ts` and confirm expected failures.
- [x] Implement profile resolution and configured token parsing; remove the hardcoded `D:\AI-MEMORY` and `auth-token` guesses for bound projects.
- [x] Provision only with AI-Memory `init`/`serve` commands, assign isolated loopback endpoints, and verify the profile identity before storing the endpoint. Never call `ai-memory setup` or pass a bearer on argv.
- [x] Run focused AI-Memory tests, the full `bun test` suite, and `bun run typecheck`.

### Task 3: Managed Graphify CLI and Python runtime

**Files:**
- Create: `src/setup/graphify-runtime.ts`
- Create: `tests/graphify-setup.test.ts`
- Modify: `src/providers/graphify.ts`
- Modify: `spec/SPEC-04-GRAPHIFY-INTEGRATION.md`

**Interfaces:**
- `ensureGraphifyRuntime(options?) -> Promise<{ executable: string; version: string; source: "system" | "managed" }>`
- `graphifyRuntimeStatus(options?) -> Promise<{ status: "ready" | "missing" | "version_mismatch"; version?: string; executable?: string }>`

- [x] Write tests for using a matching installed Graphify, installing pinned `graphifyy==0.9.109` into Tyrant’s managed location, bootstrapping missing uv/Python without host installers, and refusing an unverified version.
- [x] Run `bun test tests/graphify-setup.test.ts` and confirm expected failures.
- [x] Implement managed tool resolution/install and keep the project provider’s output local to `graphify-out/`.
- [x] Run Graphify setup tests, `bun test`, and `bun run typecheck`.

### Task 4: Bun CLI, project init, status, and onboarding docs

**Files:**
- Create: `src/cli.ts`
- Create: `tests/cli.test.ts`
- Modify: `package.json`
- Modify: `src/adapters/project-setup.ts`
- Modify: `README.md`
- Modify: `spec/README.md`
- Modify: `spec/SPEC-06-DISTRIBUTION-AND-SETUP.md`
- Modify: `spec/SPEC-07-ACCEPTANCE-AND-ROADMAP.md`

**Interfaces:**
- `runTyrantCli(args, dependencies?) -> Promise<number>` supports `setup`, `init`, `status`, and `doctor`; no subcommand runs the existing stdio MCP server.
- `tyrant setup [<vault-path>] [--name <profile>]` provisions providers, verifies them, then atomically selects the user default.
- `tyrant init [--vault <profile>] [--hosts <list>]` persists the project binding/scope and installs the existing project adapter set without replacing user-owned config.
- `tyrant status` and `tyrant doctor` distinguish active default from the current project binding and never print bearer bytes.

- [x] Write CLI tests for setup by path/current directory, arbitrary profile labels, default switching, no-default init, init preserving an existing profile, explicit rebind, status redaction, and adapter setup delegation.
- [x] Run `bun test tests/cli.test.ts tests/project-setup.test.ts` and confirm expected failures.
- [x] Implement the Bun CLI entry and package bin; connect profile/provider setup to project adapter setup and add copy/paste onboarding commands to README.
- [x] Run CLI/setup tests, `bun test`, `bun run typecheck`, and `bun run build:integrations`.
- [x] Review the complete diff against SPEC-03/04/06/07; record any unsupported host operation as pending rather than claiming it ran.

---
