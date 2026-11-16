# SPEC-07 — Acceptance, Evaluation and Roadmap

Status: Draft for owner review  
Depends on: SPEC-00 through SPEC-06

## 1. End-to-end acceptance scenarios

1. New software-development task: automatically route through the relevant Matt Pocock core workflow before specialist selection and save a plan checkpoint. Record whether the host actually loaded the core skill.
2. Repository preflight: every repo task retrieves bounded ai-memory context and the Tyrant checkpoint, verifies a current Graphify map, and records evidence for both before code work.
3. Missing context provider: if ai-memory or Graphify is unavailable, preparation reports the missing required prerequisite and blocks code-level work until restored.
4. Frontend implementation: automatically load Taste while honoring project conventions and the user’s visual choices.
5. Security audit: route Cloudflare security-audit for an explicit audit; missing sandbox keeps execution-dependent work blocked or needs_validation.
6. Context recovery: a fresh session receives the latest checkpoint and next action without the whole transcript.
7. Handoff: ai-memory and Tyrant refer to the same project/task without duplicating or overwriting state.
8. Host support: each primary client can connect, prepare, checkpoint and resume.
9. Setup safety: configuration changes preserve unrelated settings and can roll back.
10. Privacy: no tokens or secrets appear in Tyrant event records.

## 2. Verification depth

- Codex Desktop/CLI and DeepSeek Harness Desktop/CLI: full supported workflow contract.
- OpenCode: MCP connection, routing, checkpoint and recovery contract.
- Claude Desktop/CLI: smoke checks for connection, prepare and status; deep workflow testing is not required initially.

Report exact tested client versions and OS. Document unsupported hooks instead of simulating them.

## 3. Quality measures

Track correct route rate, unnecessary skill activation, resume success, checkpoint/context size, duplicate events under retry, connection/setup rollback success, and security results left blocked/needs_validation when evidence is missing. These measures do not prove an audit found every vulnerability.

## 4. Suggested delivery sequence

- Stage A: owner review of this spec pack and MVP scope.
- Stage B: define versioned MCP schemas and task-state contracts.
- Stage C: build the small local router and checkpoint/event store.
- Stage D: connect ai-memory and Graphify through supported interfaces.
- Stage E: validate Codex and DeepSeek Harness first, then OpenCode.
- Stage F: add Claude compatibility smoke coverage and public setup/update docs.

Each stage needs its own implementation plan and review. This spec pack does not authorize coding, publishing or installing tools.

SPEC-03 and SPEC-04 have been implemented in Tyrant and locally tested against isolated provider fixtures. This does not claim a live ai-memory service, installed Graphify CLI, or any host desktop/CLI integration was tested.

## 5. Release gate

A release candidate is ready when a user can install Tyrant, connect a primary client, route a task to the right skill, save a checkpoint, resume in a fresh session, inspect what happened, and uninstall without losing unrelated settings or project data.
