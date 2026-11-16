# SPEC-06 — Distribution, Setup and Updates

Status: Draft for owner review  
Depends on: SPEC-00, SPEC-01, SPEC-05

## 1. Purpose

Let a non-technical user install Tyrant and connect several AI clients without manually learning each host’s configuration.

## 2. Setup flow

1. Install Tyrant from a trusted public release.
2. Select one or more supported AI clients.
3. Add/update only Tyrant’s MCP entry for each client.
4. Verify each client can prepare a task and read its state.
5. Provision and verify the required Matt Pocock workflow, ai-memory and Graphify baseline; enable Taste for frontend work. Cloudflare security-audit is an optional specialist route.

Preferred direction: build the Tyrant MCP server with Bun and evaluate a standalone executable per supported operating system, so users do not have to install Node.js or Bun just to run Tyrant. Final installer/package format stays open until the standalone build is checked against client stdio startup, paths, configuration and updates.

## 3. Configuration safety

Preserve unrelated MCP servers, hooks, settings and custom skills. Show which entries Tyrant manages. Use an ownership manifest/markers. Back up changes and support rollback. Do not overwrite ambiguous or manually modified entries. Support user-level and project-level configuration with clear precedence.

## 4. Skill/provider setup

Use an explicit allowlist and record pinned source/version/license. Do not automatically install every repository skill or run arbitrary post-install scripts. ai-memory and Graphify are required providers for repository work; setup must verify both and explain any missing prerequisite. Taste is required when the task involves frontend implementation or redesign. Cloudflare security-audit remains an optional route selected by task intent and SPEC-05.

Several local clients may use the same Tyrant server. Client settings remain separate; task state is scoped to the repo.

## 5. Update and removal

Updates are versioned and checksum-verified through the chosen release channel. They preserve user-owned data and are recoverable. Uninstall removes only Tyrant-owned host entries and files after a user-visible preview. Deleting task history is a separate explicit action; uninstall does not erase project files or ai-memory data.

## 6. Platform support

Cross-platform use is a product goal. The support matrix distinguishes OS packaging from client compatibility. Windows is the first development environment; macOS/Linux are claimed only after setup and recovery are verified.
