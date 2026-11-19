# SPEC-07 — Acceptance, Evaluation and Roadmap

Status: Implemented; provider acceptance passed; live host acceptance partial
Depends on: SPEC-00 through SPEC-06

## 1. End-to-end acceptance scenarios

1. **Automatic Matt orchestration:** submitting a repository task to a configured host invokes Tyrant before model work. Tyrant applies its built-in Matt-inspired policy and automatically selects matching pinned specialist bodies. The upstream `ask-matt` body remains manual-only and is loaded only when the user explicitly requests it; native skill-tool invocation is claimed only with host evidence.
2. **Automatic project context:** every new task or resumed session retrieves bounded ai-memory history and refreshes/queries the current Graphify map before code work. Both provider states and references appear in the checkpoint.
3. **Provider or skill failure:** if ai-memory scope/auth, Graphify setup/freshness, or a task-required skill body is missing, the host sees the blocker and its prompt/step admission gate closes. Only adapters with a live-tested safe-action path may allow diagnosis/provider setup while keeping code writes blocked.
4. **Session continuity:** multiple prompts in the same host session resume one active Tyrant task. A fresh session automatically claims exactly one unclaimed handoff and receives that handoff plus its local checkpoint without loading the prior transcript. Multiple candidates block until a task is selected; an incomplete close-time Memory sync is retried before claim.
5. **Automatic outcome sync:** a host session-end event persists an unfinished task locally first, then attempts a bounded ai-memory sync. Codex's `SessionEnd` is limited to 3 seconds and DSH disposal is best effort; the next fresh session retries an incomplete sync. A host with no close callback keeps the local state for explicit finish/sync.
6. **Automatic frontend skill:** Taste is loaded before frontend implementation and is not loaded for unrelated backend work.
7. **Automatic security skill:** Cloudflare Security Audit is loaded for explicit audits and routed security-sensitive work. Without an approved OS sandbox, execution-dependent checks stay blocked or `needs_validation`.
8. **Other Matt specialists:** TDD, diagnosing-bugs, and code-review load only when selected by the route, with a reason and host-loading evidence.
9. **Host setup safety:** setup preserves unrelated MCP servers, hooks, and settings; repeated setup is idempotent; a user-modified managed entry is not overwritten; rollback restores captured bytes and recovers a recorded interrupted setup.
10. **Host trust and support:** Codex hooks remain `configured_pending_trust` until the user reviews/trusts them. Claude Desktop without a lifecycle hook is reported as MCP-only compatibility, never as automatically prepared.
11. **Host context limits:** Codex receives the complete context within Tyrant's 52,000-character cap; Claude Code receives at most 9,000 inline characters, with provider text reduced first and admission blocked if the complete required context still does not fit. Claude Code's prompt hook timeout is 60 seconds, each Graphify child invocation is capped at 18 seconds, and v2.1.295 or later blocks admission if the command hook fails or times out.
12. **Privacy:** prompt transcripts, credentials, and full skill bodies do not appear in Tyrant event logs. Memory history is marked untrusted and is verified against current source.
13. **Provider-only recovery and retries:** when a checkpoint proves a task was blocked solely by missing required providers, a later preflight refreshes providers and routed skills, records the explicit blocked-to-planned transition, and only then admits the host request. A different task blocker stays closed, even after its event ages out of the bounded recent-event list. Command hooks, DSH same-turn retries, and OpenCode retries with the same message ID use a fresh attempt identity; DSH/OpenCode also change identity across adapter restarts so replay cannot return the prior blocked response.
14. **User-level vault default and project binding:** set up `AI-MEMORY-WEBDEV` and initialize project A; set up `AI-MEMORY-DESKTOPDEV` and initialize project B. A must continue to query only Web; B must query only Desktop. A new project C uses Desktop until the user returns to the Web vault and runs `tyrant setup`, after which a new project uses Web. The switch applies across project roots for that user and never rebinds an existing project. Each project has a stable, distinct `workspace`/`project` scope even when two repositories share a basename or one vault profile.
15. **Provider setup and authentication:** a clean setup provisions or reuses AI-Memory and Graphify, verifies the selected profile's service identity and Graphify CLI version, and does not add duplicate AI-Memory or Graphify native hooks/skills. A fresh AI-Memory root token and a custom configured `bearer_token_file` are consumed without printing, persisting in host configuration, or rotating existing credentials. Missing credentials, an unavailable profile, or a port/endpoint collision blocks setup or code work rather than falling back to another profile.
16. **Repeatable onboarding and project instructions:** running setup repeatedly for the same canonical vault preserves profiles and data while making that profile the active default; setup in a different vault changes the default for future init only. Repeated init preserves an existing project's profile unless an explicit rebind is supplied. Init without any selected/default profile gives a clear setup instruction. Managed `AGENTS.md` guidance is additive and does not overwrite user instructions or contain credentials. `doctor` reports active default and project binding independently.

## 2. Host verification depth

### 2026-11-18 baseline with follow-up through 2026-11-19

| Surface | Status | Evidence and limit |
| --- | --- | --- |
| AI-Memory and Graphify providers | Passed | Authenticated AI-Memory discovery returned 27 upstream tools; required operations, three context scenarios, handoff sync, and live Graphify refresh/query passed using `D:\AI-MEMORY` and Graphify `0.9.109`. Tyrant uses a selected provider contract, not full upstream feature parity. |
| Tyrant MCP and routing | Passed in acceptance fixture | Nine tools listed; Matt on every task; Taste on frontend; Cloudflare Security Audit on audit task; handoff resumed. The DSH skills registry was simulated by reading staged project files. |
| DSH CLI | Blocked | Version `0.2.2-rc.3`; isolated CLI profile had no credential and returned `MISSING_CREDENTIAL` before Tyrant tool execution. |
| DSH Desktop | Partial | A 2026-11-19 login implementation task ran in a real DSH Desktop session and exercised Tyrant context plus native TDD/Taste skill calls. The final checkpoint and follow-up task read returned `Not connected`; session-end persistence, reconnect recovery, multi-profile setup, and full host acceptance remain pending. |
| Codex, OpenCode, Claude Code | Fixture-only | Automated adapter/MCP tests passed; no live host task was run in this acceptance. |
| Claude Desktop | MCP-only | No automatic lifecycle hook is claimed. |
| Source security scan | Partial, pre-hardening snapshot | Scan recorded three findings and partial coverage; targeted fixes and regression tests were added afterward. Run a full scan against the final worktree before treating the scan findings as closed. |

See [`docs/reports/SPEC-07-ACCEPTANCE-2026-11-18.md`](../docs/reports/SPEC-07-ACCEPTANCE-2026-11-18.md) for exact versions, operation names, gates, cleanup, and evidence.

- DeepSeek Harness Desktop/CLI and Codex Desktop/CLI: primary automatic workflow contract; adapter fixtures cover prepare, skill injection, required-context blocking, provider-only recovery, retry identity, session resume, context bounds, and handoff. Verify all of these plus restart recovery and trust/enablement on the exact host versions before claiming acceptance.
- OpenCode Desktop/CLI: supported server-plugin contract; fixture tests are complete, but test prompt/context hooks against the supported plugin API version in a live host.
- Claude Code CLI: the compatibility adapter, fail-closed `onFailure`, 60-second hook deadline, 18-second per-command Graphify deadline, and 9,000-character inline-context gate are fixture-tested; use v2.1.295 or later, and run the project-server approval and hook handoff smoke before claiming acceptance.
- Claude Desktop: MCP connection and manual/static instructions only until an official lifecycle mechanism is available.

For every row, report the exact host version, OS, configured files, actual hook/plugin execution evidence, and unsupported behavior. A generic MCP stdio test proves only the MCP contract.

## 3. Quality measures

Track automatic preflight coverage, provider readiness, route accuracy, selected-skill loading evidence, unnecessary specialist activation, same-session task reuse, provider-only lifecycle recovery, handoff sync success, context size, duplicate events under retry, setup/rollback integrity, and host trust/activation status. These measures do not prove an audit found every vulnerability or that the model followed every loaded instruction.

## 4. Delivery order

- **Stage A — Spec and host contracts:** define observable auto behavior and document host APIs/limitations. Owner approval is recorded in SPEC-06.
- **Stage B — Automatic preflight core:** per-attempt host/session identity, task reuse, context formatting, skill/provider events, safe failure status, and explicit provider-only lifecycle recovery.
- **Stage C — Primary adapters:** DSH pre-step plugin and Codex prompt hook, followed by OpenCode plugin and Claude Code hook.
- **Stage D — Durable outcomes:** session-end handoff where the host has a reliable lifecycle event; explicit finish/status fallback elsewhere.
- **Stage E — Setup and recovery:** project preview/install, project MCP entries where supported, pinned skill packages and license files, per-file integrity checks, status, backups, owner manifest, interrupted-setup rollback, report-only repair, and conservative uninstall. Fixture coverage is in place; live host acceptance, package release signing, and release distribution remain in Stage F.
- **Stage F — Host acceptance and release:** run real host smoke tests, record versions and results, and publish only after the release gate below passes.

The owner explicitly authorized SPEC-06 implementation in the current work session. This authorization covers local source/spec changes and verification; publishing, pushing, or changing the user’s installed host configuration remains a separate action.

The 2026-11-19 vault-profile plan is normative for onboarding: changing the user-level active default affects future project initialization only; previously initialized projects continue using their stored profile. Profile-switch, project-isolation, token-resolution, and provider-only setup tests are required before the setup workflow can pass acceptance.

## 5. Release gate

A release candidate is ready when a new user can install Tyrant and its exact, integrity-verified skill set, create/select a vault profile, initialize projects against the active default, switch defaults without rebinding existing projects, verify cross-profile/project isolation, activate a supported host adapter, see automatic preflight run before model work, confirm the host received Matt and required provider/specialist context, observe a real block when prerequisites are missing, resume the same project task in a fresh session, inspect actual evidence, and roll back/uninstall without losing unrelated configuration or project data. Host-specific gates must pass independently; one host’s success cannot imply another host is automatic.
