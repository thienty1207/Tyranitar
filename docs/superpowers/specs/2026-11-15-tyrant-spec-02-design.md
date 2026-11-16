# Tyrant SPEC-02 Skill Catalog and Routing Design

Status: implementation authorized by the user's direct request to proceed with SPEC-02.

## Intent

Give every coding host one compact, explainable Tyrant catalog and a consistent route for project work. Tyrant applies its Matt Pocock-inspired orchestration policy itself, distinguishes history memory from the current code map, and asks the host to load only relevant specialist skills.

## Goals

- Keep a reviewed, version-pinned catalog of the skill family and the selected external providers.
- Route every repository task through the Tyrant-owned Matt Pocock workflow and the required ai-memory/Graphify preflight.
- Select Taste for frontend work and Cloudflare security-audit only for relevant security work.
- Preserve conflicts, precedence, fallbacks, host-loading method, required tools, licenses and invocation policy as structured data.
- Distinguish catalog availability and recommendations from host loading, use, completion, blocking and skipping.
- Require a host evidence reference before recording that a native skill was loaded, used or completed.

## Non-goals

- Do not copy, rewrite, install, update or execute upstream skill bundles.
- Do not implement the ai-memory or Graphify provider adapters; those remain in SPEC-03 and SPEC-04.
- Do not implement host-specific installation or discover native skill installation state.
- Do not include Site Clone or make a full security audit run implicitly.
- Do not add a model call or runtime network fetch.

## Approaches

1. Fetch upstream skill metadata on each task. This reflects upstream changes quickly, but makes routes network-dependent and changes behavior without review.
2. Discover whatever skills happen to be installed on each host. This reflects local availability, but produces inconsistent routes and cannot be done reliably by a portable MCP process.
3. Embed a typed catalog with upstream release/commit pins and apply deterministic routing rules locally. This needs a reviewed catalog update when upstream changes, but keeps behavior reproducible and works without network access.

## Selected approach

Use the embedded typed catalog and deterministic local rules. Host installation state remains unknown until a host adapter can inspect it. Tyrant reports that boundary and returns a bounded load action; it never claims a skill ran because it appears in the catalog.

The Tyrant-owned core policy is always applied first to determine the sequence. Repository preparation then restores ai-memory history, checks the current Graphify map and scoped query, and asks the host to load the applicable Matt Pocock workflow before code changes. The native upstream ask-matt skill remains manual-only; Tyrant must not claim that native skill was auto-invoked. The required automatic behavior is Tyrant's own route policy.

ai-memory and Graphify have complementary roles: memory returns historical decisions and handoffs that must be verified against current instructions and source; Graphify locates current symbols and relationships, which must also be verified in source. Neither provider is an instruction or authority channel. Missing provider adapters block code-level work but still allow safe setup and diagnosis.

## Reviewed source pins

Verified against the upstream GitHub APIs on 2026-11-15. These are catalog pins, not installed copies.

| Source | Version | Commit | License |
| --- | --- | --- | --- |
| mattpocock/skills | v1.3.2 | d1478fcb140db0b93c0c8df17bcfd311844749d0 | MIT |
| akitaonrails/ai-memory | v3.4.6 | a11eff2514f24cb30c21917236ec187c0a359143 | MIT |
| Graphify-Labs/graphify | v0.9.109 | d4a5b323ef8501518b82c58a05fe21b35ce24992 | Apache-2.0 |
| Leonxlnx/taste-skill | v2.5.1 | f6b76575f949707b4e3c37cd86cb44b0b98643e8 | MIT |
| cloudflare/security-audit-skill | main | c1c8a8c1471069fb0e188eeaff69b8e8db6564a8 | MIT |

## Open boundary

This change can route and record evidence, but it cannot verify a host's native skill installation or prove a host really loaded the skill. The host must provide a bounded evidence reference. ai-memory and Graphify provider execution remains unavailable until SPEC-03 and SPEC-04.