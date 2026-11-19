# SPEC-08 Acceptance Report

## Result

The complete pinned AI-Memory MCP surface is available through Tyrant, and Tyrant's built-in Matt-inspired policy runs automatically during repository-task preflight. The upstream `ask-matt` skill remains a manual host-native route; Tyrant does not falsely report that it invoked the native skill when only its own policy ran.

## AI-Memory tools

- Pinned upstream contract: AI-Memory 3.4.7, 27 operations.
- Tyrant exposes 27 namespaced AI-Memory tools alongside 9 existing Tyrant tools, for 36 total MCP tools.
- Upstream descriptions, JSON Schemas, and annotations are retained.
- Calls use the configured AI-Memory endpoint and token, apply project/workspace defaults only to schema-supported fields, and preserve explicit profile/global scopes and destinations.
- Responses and errors are bounded and redacted. Task events store the operation and outcome, not tool arguments or memory content.
- The test suite covers all 27 registrations, DSH adapter discovery, schema preservation, representative calls, scopes, redaction, and event content.

## Automatic orchestration

- Tyrant injects its own Matt-inspired routing policy for repository tasks without asking for approval on each routine route decision.
- Coding tasks require the TDD specialist; frontend tasks select Taste; security-audit requests select the security specialist; bug reports select debugging guidance.
- The selected host-native specialist bodies are loaded through the adapter and the route is logged with truthful source/method metadata.
- Native `ask-matt` remains manual-only and is selected when the user explicitly requests that consultation. Generic task routing does not imply it was called.
- AI-Memory and Graphify remain available as default context providers; listing all AI-Memory tools does not mean Tyrant invokes every operation on every task. Mutating memory operations still require relevant task intent.

## Automated verification

Recorded implementation verification:

- `bun test`: 136 passed, 0 failed; 1,145 expectations across 11 files.
- `bun run typecheck`: passed.
- `bun run build:integrations`: passed for command-hook, DSH, and OpenCode bundles.
- `git diff --check`: passed; Git reported only line-ending conversion warnings.

## Live-host boundary

The automated tests prove Tyrant's MCP registration, provider proxy behavior, and DSH adapter's tool-list construction. They do not prove that the running DSH Desktop session has reconnected to Tyrant, that the DeepSeek model actually called a tool, or that a host-native skill registry executed the injected skill. Those require a live DSH session and are not claimed as accepted here. No mutating live AI-Memory operation was used for acceptance.
