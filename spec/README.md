# Tyrant Spec Pack

Status: Draft for owner review. Documentation only; no product code or installation changes.

## Count: 9 specifications

There are **9 specs total: 1 master spec and 8 focused specs.**

| ID | File | Scope |
| --- | --- | --- |
| SPEC-00 | [Product charter](SPEC-00-PRODUCT-CHARTER.md) | Purpose, boundaries, architecture and direction |
| SPEC-01 | [MCP and hosts](SPEC-01-MCP-AND-HOSTS.md) | Common MCP contract and client compatibility |
| SPEC-02 | [Skills and routing](SPEC-02-SKILLS-AND-ROUTING.md) | Skill catalog, selection, conflicts and evidence |
| SPEC-03 | [Task state and continuity](SPEC-03-TASK-STATE-AND-CONTINUITY.md) | State, checkpoints, logs, hooks and ai-memory |
| SPEC-04 | [Graphify integration](SPEC-04-GRAPHIFY-INTEGRATION.md) | Repository code graph |
| SPEC-05 | [Security and trust](SPEC-05-SECURITY-AND-TRUST.md) | Privacy, permissions, sandbox and audit routing |
| SPEC-06 | [Distribution and setup](SPEC-06-DISTRIBUTION-AND-SETUP.md) | Install, update, rollback and uninstall |
| SPEC-07 | [Acceptance and roadmap](SPEC-07-ACCEPTANCE-AND-ROADMAP.md) | User outcomes, evaluation and staged delivery |
| SPEC-08 | [Full AI-Memory tools and Matt orchestration](SPEC-08-AI-MEMORY-ALL-TOOLS-AND-MATT-ORCHESTRATION.md) | Complete AI-Memory MCP surface, project-bound profiles and automatic orchestration |

Read SPEC-00 first. SPEC-01 through SPEC-06 define product contracts. SPEC-07 brings them together into acceptance criteria. SPEC-08 extends the AI-Memory tool and orchestration contract.

Tyrant is a new, independently installable MCP orchestrator inspired by useful Baron design ideas, not a Baron port. Matt Pocock’s engineering workflow is its core orchestration skill family. ai-memory and Graphify are required project-context providers; Taste is required for frontend work; Cloudflare security-audit is a specialist route. Codex Desktop/CLI and DeepSeek Harness Desktop/CLI are primary targets; OpenCode is supported; Claude Desktop/CLI receives compatibility smoke coverage.

No implementation is authorized by this spec pack. Language remains flexible; choose by component need, keep contracts language-neutral, and avoid polyglot complexity without a concrete benefit.
