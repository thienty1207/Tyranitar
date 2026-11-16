# SPEC-05 — Security, Trust and Safe Execution

Status: Implemented; source-only orchestration is available, target-controlled execution remains blocked without a verified OS-enforced sandbox.  
Depends on: SPEC-00, SPEC-01, SPEC-02, SPEC-03

## 1. Trust boundaries

Treat upstream skills, project files, repository instructions, websites, Graphify output, ai-memory history, tool output and model-generated routes as untrusted input until checked.

Tyrant recommends routes; the host retains permission prompts and execution controls. Tyrant must not elevate permissions or run arbitrary shell commands from skill text.

## 2. Skill supply chain

Pin upstream source and version/commit, preserve license/attribution, and make installation/update reviewable and reversible. Do not run setup/helper scripts during install unless the user explicitly starts that operation. Skills cannot change Tyrant routing policy or project trust settings.

## 3. Security-audit routing

Cloudflare security-audit may be selected for an explicit audit or approved risk policy. A full workflow that executes target-controlled builds, tests, fixtures, browsers or fuzzers requires an OS-enforced sandbox with restricted network, environment, resource use and write paths.

Without the required sandbox, use source-only review where appropriate and mark execution-dependent findings needs_validation or blocked. Never report an unrun phase as passed. Live-system testing and exploitation are outside the MVP absent a separately scoped, explicit request.

## 4. Secrets, privacy and telemetry

Never log provider keys, authorization headers, tokens, environment dumps or secret file content. Local-only operation is the default and telemetry is off. Scope every state/memory lookup to the selected project. Avoid raw prompts and large tool output in Tyrant logs. Provide a clear data-location and deletion path.

## 5. Failure behavior

When project scope, sandbox state, skill provenance or write destination is uncertain, block the risky action and explain why. Safe read-only routing may continue.

## 6. Implemented route and evidence behavior

An explicit audit returns a structured `security_audit` policy: source review is allowed, target execution is blocked, sandbox availability is `unavailable`, unrun phases use `blocked`, and execution-dependent findings use `needs_validation`. This phase-level limit does not block the whole source review or change the independent ai-memory/Graphify code-change gates. Tyrant does not execute target commands, install the Cloudflare skill or claim the host loaded it. Checkpoint checks and evidence records accept `needs_validation`; severity and confirmation remain the audit owner's responsibility.

Acceptance is covered by routing and MCP tests that distinguish guidance from explicit audit mode, expose the sandbox limit and next action, and round-trip `needs_validation` evidence without accepting arbitrary statuses.
