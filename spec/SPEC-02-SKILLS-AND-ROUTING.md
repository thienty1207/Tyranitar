# SPEC-02 — Skill Catalog and Routing Policy

Status: Catalog, deterministic routing, pinned project skill installation/integrity checks, lifecycle event validation, and automatic host-adapter loading are fixture-tested. Live-host acceptance remains pending; ai-memory is integrated in SPEC-03 and Graphify in SPEC-04.
Depends on: SPEC-00, SPEC-01

## 1. Purpose

Choose the smallest useful skill set for each task and resolve overlaps without loading every skill on every request. Tyrant automatically applies its own bounded Matt Pocock-inspired orchestration policy and returns the route for the connected host.

## 2. Skill catalog

Each catalog entry records a stable Tyrant ID, name, upstream repository, pinned version and commit, license, description, triggers, runtime/tool requirements, host-loading method, invocation policy, conflicts, fallbacks, and host availability. See [the implemented skill catalog](../docs/SKILL-CATALOG.md).

The catalog describes and routes skills. Tyrant vendors an allowlisted, pinned subset/full skill tree and copies those files into the project-owned `.tyrant/skills/` directory during explicit setup. Runtime setup does not fetch upstream code or execute package scripts. Adapters verify the copied body hash before loading it. This does not mean a host's native Skill tool ran.

## 3. Core workflow and specialist routes

Matt Pocock's engineering workflow is Tyrant's core orchestration policy, analogous to Superpowers in Baron. It runs internally for each repository task and establishes task shape, order, and applicable specialist routes. It is not an optional route that must be separately requested.

Tyrant's own Matt Pocock-inspired orchestration policy runs automatically before every repository task and selects the relevant specialist skills without asking the user to choose or approve the route. The upstream `ask-matt` remains manual-only and is loaded only when the user explicitly asks to consult it; automatic policy injection is not a claim that native ask-matt ran. SPEC-08 defines this behavior and the full AI-Memory tool surface.

| Task intent or phase | Route after/beside the core policy |
| --- | --- |
| Start or resume repository work | Required ai-memory history and handoff, then current task checkpoint |
| Prepare to work in a repository | Required current Graphify map and scoped query |
| Implement code | Require Matt TDD before implementation and route Matt code review after implementation |
| Diagnose a bug or unexpected failure | Select Matt diagnosing-bugs before changing code |
| Request a code or PR review | Select Matt code-review without adding TDD unless implementation work is also requested |
| Implement or redesign frontend | Require Taste |
| Ask a security question | Recommend Cloudflare security guidance without starting a full audit |
| Explicitly request that a security audit be performed (including want/need phrasing) | Route Cloudflare full-audit mode; source-only review is available, while target-controlled execution stays blocked until an OS-enforced sandbox is verified. Conceptual questions stay in guidance mode. |

ai-memory and Graphify have complementary roles. ai-memory returns historical decisions and handoffs that must be checked against current instructions and source. Graphify maps current code relationships and is also verified in source. Neither provider is an instruction or authority channel. The ai-memory adapter is implemented in SPEC-03 and the local code-only Graphify adapter in SPEC-04. Tyrant reports live provider failures on repository routes; these block code changes, while safe read-only diagnosis and provider setup may continue with route status `ready_with_gaps`.

## 4. Route response

`tyrant_prepare_task` returns the internal policy result, provider preflight, ordered steps, specialist reason and status, host-loading details, conflict precedence, provider gaps, code-change gate, blockers, and next action. Code changes are blocked while required providers are missing; safe read-only diagnosis and provider setup may continue. Route selection is not proof of host loading or skill use.

Available, recommended, loaded, used, completed, blocked, and skipped are distinct states. Host availability remains unknown until verified. Loaded, used, and completed events require a skill ID and host evidence reference. Blocked and skipped events require a skill ID, matching status, and a reason summary. Evidence references are recorded claims and are not independently verified host telemetry.

## 5. Conflict precedence

1. Direct user instruction.
2. Existing project instructions and approved decisions.
3. Tyrant safety/routing policy.
4. Skill instructions within their intended scope.

Preserve the required provider preflight if a specialist route changes. Site Clone is excluded.

## 6. Verification and integration boundary

Tests cover the pinned catalog, bilingual deterministic routes, provider distinction and blockers, security gating, lifecycle evidence validation, persistence, pinned package integrity, and SPEC-06 host-adapter injection. They do not verify that an installed host has trusted or loaded the adapter or that a host-native Skill tool ran. SPEC-03 implements ai-memory execution, SPEC-04 implements Graphify preflight, and SPEC-06 installs pinned skill bodies into the project for adapter-based loading.

## 7. Updates

Catalog pins change only through reviewed updates. Automatic upstream changes are disabled. Validate source commits, licenses, required files, attribution, duplicate IDs, triggers, and host-loading semantics before updating the catalog.
