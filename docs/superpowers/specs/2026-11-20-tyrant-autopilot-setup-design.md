# Tyrant Autopilot Setup Design

## Intent

Make Tyrant own host/provider setup so a user installs the Tyrant adapter once, then can change project folders and AI-Memory vault defaults without reinstalling DSH plugins or manually installing Graphify/uv.

## Goals

- `tyrant setup` provisions AI-Memory and Graphify and ensures the DSH user-profile plugin is installed or current.
- `tyrant init` binds the current project to its selected vault, writes the project-local Codex/Claude Code/OpenCode configuration, and ensures the DSH plugin only if it is missing or points at another Tyrant installation.
- DSH resolves the current project root from its session on every agent and resolves that project's saved vault binding; switching projects or the active default never requires a plugin reinstall.
- Graphify and AI-Memory runtime health are recovered automatically when the pinned managed runtime is missing or stopped and the project has a valid profile binding.
- No successful setup output labels a supported, automatable DSH step `manual_required`.

## Non-goals and boundaries

- Tyrant does not disable a host's project trust, security, or approval controls.
- DSH must reload its plugin after the one-time migration or a plugin version update because its host loads plugins at startup. Project/vault changes do not require that reload.
- Missing DSH itself is reported as not detected; Tyrant does not install the DSH application.
- A project keeps its existing vault binding unless the user explicitly runs `tyrant init --vault <profile>`.

## Approaches

1. **Per-project DSH installation:** rejected because it repeats host wiring for each project and couples plugin installation to the selected vault.
2. **One user-profile DSH plugin plus project-local bindings (selected):** install/update the plugin idempotently from `tyrant setup`/`tyrant init`; the plugin uses the session `cwd` and project binding at runtime. Host setup is performed once and task context remains project-specific.
3. **MCP-only connection:** rejected for DSH automatic orchestration because an MCP server alone does not run Tyrant's pre-step before model work.

## Design calls

- Keep the DSH plugin installation at user/profile scope and the AI-Memory binding at project scope.
- For bound projects, construct the DSH MCP child environment from the saved Tyrant profile and strip global AI-Memory endpoint, vault-path, token, token-file, and scope overrides. Keep unrelated safe settings such as Graphify executable and provider timeout. Unbound projects retain explicit environment-based AI-Memory configuration.
- Use the DSH `desktop` profile by default; allow an explicit profile selector for users who run another profile. Repeated setup checks the installed package identity and does nothing when it already matches.
- Run the pinned Graphify bootstrap through Tyrant-managed uv/Python, then extract/query the map automatically per project. Users never need to install uv themselves.
- If automatic runtime recovery fails, retain the fail-closed code-change gate and record a bounded, actionable provider error.
- Preserve any host-owned trust or plugin-reload boundary rather than silently bypassing it.

## Acceptance

- Running setup twice for the same DSH profile does not reinstall its plugin.
- Setting up a second vault does not change already-bound projects and does not reinstall the DSH plugin.
- Initializing two projects selects the active default for each new project, records different project scopes, and configures each supported project adapter without a DSH `manual_required` result.
- A DSH agent in either project receives that project's own AI-Memory and Graphify context.
- A global DSH `.env` AI-Memory token/path/scope cannot override a project's saved vault; an unbound project still receives supported explicit environment configuration.
- Graphify missing from the managed runtime is installed and verified automatically; a missing uv/Python host install is not required.
- A stopped managed AI-Memory service is restarted and identity-checked before context is admitted.
- Provider failure remains blocked and visible in Tyrant state; the engine never claims a ready context without evidence.
