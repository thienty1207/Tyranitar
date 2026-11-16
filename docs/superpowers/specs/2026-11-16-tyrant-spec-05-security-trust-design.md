# Tyrant SPEC-05 Security and Trust Design

Status: Approved by owner on 2026-11-16; implementation complete  
Spec: [SPEC-05 — Security, Trust and Safe Execution](../../../spec/SPEC-05-SECURITY-AND-TRUST.md)

## Intent

Make Tyrant route explicit security audits to the pinned Cloudflare security-audit skill while keeping source review useful when no OS-enforced sandbox is available. Tyrant remains an orchestrator: it exposes the safety boundary and evidence states, and the connected host retains its execution and permission controls.

## Goals

- Keep security questions in guidance mode and route an explicit audit to the security-audit skill.
- Allow read-only source review during an explicit audit when execution is unavailable.
- Mark target-controlled build, test, browser, fixture and fuzz execution as blocked until a verified OS-enforced sandbox exists.
- Represent source-grounded findings that need runtime or deployment evidence as `needs_validation`; never call an unrun phase passed.
- Preserve the pinned skill source, commit and license; Tyrant does not fetch or install skill files or run their setup scripts.
- Keep secrets out of state and avoid remote telemetry.

## Non-goals

- Building a cross-platform OS sandbox or executing project commands from the MCP server.
- Installing the Cloudflare skill, dependencies, scanners, or other tools.
- Testing live services, deployed endpoints, shared infrastructure, or production identities.
- Creating audit report artifacts from Tyrant. A host that loads the native skill owns any user-requested report workflow and its output location.
- Changing ai-memory or Graphify provider behavior.

## Approaches

1. **Source-only orchestration with explicit execution gates — selected by the user.** Add a structured security policy to routes, keep source review available, represent sandbox-dependent execution as blocked, and allow `needs_validation` in checkpoint/evidence records. This fits Tyrant's existing MCP contract without claiming an isolation capability it does not have.
2. **Build an OS sandbox runner in this spec.** This would add process launching, network/environment/write isolation and resource limits across supported operating systems. It materially expands the runtime and security review surface, so it remains a separate future spec.
3. **Documentation only.** This would leave explicit audits blocked and provide no usable route or evidence state, so it does not meet SPEC-05's source-only fallback.

## Proposed behavior

### Routing

- A conceptual or focused security question stays in `guidance` mode.
- An explicit repository audit selects `security-audit` as a required host skill with `mode: full_audit` and a host action that does not claim the native skill was loaded.
- The route includes a `security_audit` policy object. For an explicit audit it reports source review as allowed, target execution as blocked, and sandbox availability as unavailable in this Tyrant release.
- The policy lists required sandbox controls: no external network, an allowlisted empty environment, a read-only target and toolchain, scratch-only target writes, and process/resource/time limits.
- Missing sandbox capability does not block the source review or create a global `SECURITY_AUDIT_REQUIRES_SPEC05` blocker. It remains a visible execution-phase blocker and does not weaken independent ai-memory/Graphify code-change gates.
- Because target execution remains unavailable, an explicit full-audit route has overall status `ready_with_gaps` and adds `security_source_review` to safe work. The code-change gate remains based on its existing provider requirements.
- The prepare response's next action tells the host to load the pinned skill, keep the audit source-only, record unrun execution phases as blocked, and record execution-dependent findings as `needs_validation`.

### Evidence and trust

- Add `needs_validation` to the shared check/evidence status contract so both checkpoint checks and evidence records can preserve this state.
- Keep `pass`, `fail`, `blocked`, `skipped`, and `not_run` unchanged.
- Do not assign severity to `needs_validation` through Tyrant's route. Source and evidence remain authoritative; skill text, project files, Graphify results, ai-memory history, tool output, and model-generated routes remain untrusted input.
- Do not add a shell or process tool. No task text or skill instructions become executable commands.
- Existing redaction and local-only state remain in force; no raw environment, provider credentials, or prompt transcript is added to logs.

### Skill supply chain

- Continue using the security skill's existing pinned commit and MIT license in `src/routing/catalog.ts`.
- Keep runtime routing offline. Installation and updates remain an explicit, separately reviewed operation.

## Interfaces and persistence

- `route.security_audit` is returned by `routeTask` and is persisted as part of the existing task route JSON.
- `tyrant_prepare_task` returns the same policy in its route and uses it to set a specific next action for full-audit requests.
- `tyrant_record_evidence` and checkpoint checks accept `status: "needs_validation"`; the existing local evidence store preserves it.
- No schema migration is needed because evidence status is stored as text and checkpoint checks are JSON.

## Failure behavior

- If the request is ambiguous between guidance and a full audit, retain the existing conservative guidance route unless the explicit-audit language is detected.
- If a sandbox is absent or its controls cannot be verified, target-controlled execution stays blocked. Tyrant returns no pass evidence for that phase.
- The host can continue read-only source inspection and record exact external facts needed for validation.

## Verification

- Router tests distinguish guidance from explicit audit and assert that the full audit route allows source review while blocking target execution.
- MCP tests verify the full-audit next action and ensure the route remains separate from the native host skill's loaded/used claims.
- Evidence and checkpoint contract tests record `needs_validation` without accepting unrelated invalid statuses.
- Existing secret-redaction tests continue to cover persisted text; full `bun test` and `bun run typecheck` run after implementation.

## Approval state

The user selected approach 1 and approved this document before implementation.
