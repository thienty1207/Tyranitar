import { createHash, randomUUID } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactSensitiveText } from "../state/redaction";
import { SKILL_CATALOG } from "../routing/catalog";
import { isTrustedSkillBody } from "../routing/skill-integrity";

const MAX_TASK_CHARS = 8_000;
const MAX_SKILL_CHARS = 40_000;
const MAX_PROVIDER_CHARS = 7_000;
const MAX_CONTEXT_CHARS = 52_000;
const MAX_CLAUDE_CONTEXT_CHARS = 9_000;
const MATT_ORCHESTRATOR_POLICY = [
  "Tyrant built-in Matt Pocock-inspired orchestration policy; automatically applied to every task before the host model request.",
  "Shape the task into a clear outcome, identify constraints and the smallest useful workflow, then select matching specialist skills from the Tyrant route without asking the user to choose or approve routine skill selection.",
  "Use the specialist bodies below as operational instructions when their triggers match. Run TDD before code changes, Taste for frontend work, Cloudflare security audit for explicit security audits, and the routed review or debugging workflow when applicable.",
  "Proceed with the user's directly requested work and existing safety rules. Ask a question only when a real ambiguity blocks progress; never claim that the upstream manual-only ask-matt skill was invoked unless the user explicitly requested it and the host provides evidence.",
].join("\n");

export type HostHookInput = {
  host_id: string;
  cwd: string;
  session_id: string;
  prompt: string;
  turn_id?: string;
  invocation_id?: string;
};

export type HostSkillLoadRequest = {
  host_id: string;
  cwd: string;
  skill_id: string;
  source_skill_id: string;
};

export type HostSkillLoadResult = {
  status: "loaded" | "missing" | "too_large";
  skill_id: string;
  source_skill_id: string;
  method: "host_skill_registry" | "host_skill_file" | "tyrant_builtin_policy";
  source_ref?: string;
  resource_base?: string;
  content?: string;
  reason?: string;
};

export type TyrantToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export type HostSkillLoader = (input: HostSkillLoadRequest) => Promise<HostSkillLoadResult>;

type CatalogSkill = (typeof SKILL_CATALOG)[number];

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, max = 8_000): string {
  if (typeof value !== "string") return "";
  return redactSensitiveText(value).trim().slice(0, max);
}

export function automaticPreflightBlockReason(preflight: { provider_gaps?: unknown[]; required_skill_gaps?: unknown[]; host_context_error?: unknown; task_lifecycle_blocked?: boolean }): string {
  if (safeString(preflight.host_context_error, 96) === "context_limit_exceeded") {
    return "Tyrant blocked model work because the complete required project and skill context exceeds this host's inline context limit. Reduce the required skill bundle or provider context and retry.";
  }
  const missing = new Set<string>();
  for (const gap of preflight.provider_gaps ?? []) {
    const provider = isRecord(gap) ? gap.provider : gap;
    const label = safeString(provider, 96);
    if (label) missing.add(label);
  }
  for (const gap of preflight.required_skill_gaps ?? []) {
    const label = safeString(gap, 96);
    if (label) missing.add(label);
  }
  const summary = [...missing].slice(0, 8).join(", ");
  if (summary) return `Tyrant blocked model work because required project context is unavailable: ${summary}.`;
  if (preflight.task_lifecycle_blocked === true) {
    return "Tyrant blocked model work because the task remains blocked. Resolve its recorded blocker, then call tyrant_transition_task to move it to planned or in_progress before code changes.";
  }
  return "Tyrant blocked model work because required project context is unavailable.";
}

function unwrapToolResponse(response: unknown): Record<string, any> {
  if (!isRecord(response)) throw new Error("Tyrant returned an invalid tool response.");
  if (response.isError === true) throw new Error("Tyrant tool call failed.");
  if (isRecord(response.structuredContent)) return response.structuredContent;
  const textBlock = Array.isArray(response.content)
    ? response.content.find((item: unknown) => isRecord(item) && item.type === "text")
    : undefined;
  if (isRecord(textBlock) && typeof textBlock.text === "string") {
    try {
      const parsed: unknown = JSON.parse(textBlock.text);
      if (isRecord(parsed)) return parsed;
    } catch {
      throw new Error("Tyrant returned malformed tool data.");
    }
  }
  return response;
}

export function deriveHostRequestId(input: HostHookInput): string {
  const eventKey = input.invocation_id?.trim()
    ? `invocation:${safeString(input.invocation_id, 256)}`
    : input.turn_id?.trim() ? `turn:${input.turn_id.trim()}` : `invocation:${randomUUID()}`;
  const key = [input.host_id.trim(), input.session_id.trim(), eventKey].join("\n");
  return `host-${createHash("sha256").update(key).digest("hex").slice(0, 56)}`;
}

function getCatalogSkill(skillId: string): CatalogSkill | undefined {
  return SKILL_CATALOG.find((item) => item.id === skillId);
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function skillRoots(hostId: string, cwd: string): string[] {
  const home = homedir();
  const roots = [
    resolve(cwd, ".tyrant", "skills"),
    resolve(cwd, ".agents", "skills"),
    resolve(cwd, ".dsh", "skills"),
    resolve(cwd, ".codex", "skills"),
    resolve(cwd, ".claude", "skills"),
    resolve(cwd, ".opencode", "skills"),
    resolve(home, ".agents", "skills"),
  ];
  if (hostId === "dsh") roots.unshift(resolve(process.env.DSH_HOME?.trim() || join(home, ".dsh"), "skills"));
  if (hostId === "codex") roots.unshift(resolve(process.env.CODEX_HOME?.trim() || join(home, ".codex"), "skills"));
  if (hostId === "claude-code") roots.unshift(resolve(home, ".claude", "skills"));
  if (hostId === "opencode") roots.unshift(resolve(process.env.OPENCODE_CONFIG_DIR?.trim() || join(home, ".config", "opencode"), "skills"));
  return [...new Set(roots)];
}

function stripFrontmatter(content: string): string {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const closing = normalized.indexOf("\n---", 4);
  if (closing < 0) return normalized.trim();
  const end = normalized.indexOf("\n", closing + 1);
  return (end < 0 ? "" : normalized.slice(end + 1)).trim();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isPinnedProjectSkillIntact(projectRoot: string, skillRootRealPath: string, fileRealPath: string, sourceSkillId: string): Promise<boolean> {
  if (!isInside(skillRootRealPath, fileRealPath)) return false;
  let manifestRealPath: string;
  try {
    manifestRealPath = await realpath(join(skillRootRealPath, "manifest.json"));
  } catch {
    return false;
  }
  if (!isInside(skillRootRealPath, manifestRealPath)) return false;
  try {
    const manifestBytes = await readFile(manifestRealPath);
    if (manifestBytes.length > 1_000_000) return false;
    const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
    if (!isRecord(manifest) || manifest.schema_version !== 1 || !Array.isArray(manifest.files)) return false;
    const relativeSkillPath = relative(projectRoot, fileRealPath).replaceAll(sep, "/");
    const record = manifest.files.find((item: unknown) => isRecord(item) && item.project_path === relativeSkillPath);
    if (!isRecord(record) || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) return false;
    const bytes = await readFile(fileRealPath);
    if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) return false;
    return isTrustedSkillBody(sourceSkillId, stripFrontmatter(bytes.toString("utf8")));
  } catch {
    return false;
  }
}

export async function loadPinnedProjectSkillFile(input: HostSkillLoadRequest): Promise<HostSkillLoadResult> {
  const missing: HostSkillLoadResult = {
    status: "missing", skill_id: input.skill_id, source_skill_id: input.source_skill_id,
    method: "host_skill_file", reason: "skill_not_installed",
  };
  const rootPath = resolve(input.cwd, ".tyrant", "skills");
  let rootRealPath: string;
  try {
    rootRealPath = await realpath(rootPath);
  } catch {
    return missing;
  }
  const projectRoot = await realpath(input.cwd).catch(() => resolve(input.cwd));
  if (!isInside(projectRoot, rootRealPath)) return { ...missing, reason: "pinned_skill_integrity_mismatch" };
  const names = [...new Set([input.source_skill_id, input.skill_id])].filter(Boolean);
  for (const name of names) {
    const candidates = [join(rootPath, name, "SKILL.md"), join(rootPath, name, "skill.md"), join(rootPath, name, ".md")];
    for (const candidate of candidates) {
      let fileRealPath: string;
      try {
        fileRealPath = await realpath(candidate);
      } catch {
        continue;
      }
      if (!isInside(rootRealPath, fileRealPath) || !(await isPinnedProjectSkillIntact(projectRoot, rootRealPath, fileRealPath, input.source_skill_id))) {
        return { ...missing, source_ref: fileRealPath, reason: "pinned_skill_integrity_mismatch" };
      }
      let content: string;
      try {
        content = stripFrontmatter(await readFile(fileRealPath, "utf8"));
      } catch {
        return { ...missing, source_ref: fileRealPath, reason: "pinned_skill_integrity_mismatch" };
      }
      if (!content) return { ...missing, source_ref: fileRealPath, reason: "pinned_skill_integrity_mismatch" };
      if (content.length > MAX_SKILL_CHARS) {
        return {
          ...missing, status: "too_large", source_ref: fileRealPath, resource_base: dirname(fileRealPath),
          reason: "skill_body_exceeds_context_limit",
        };
      }
      return {
        status: "loaded", skill_id: input.skill_id, source_skill_id: input.source_skill_id,
        method: "host_skill_file", source_ref: fileRealPath, resource_base: dirname(fileRealPath), content,
      };
    }
  }
  return missing;
}

export async function loadHostSkillFile(input: HostSkillLoadRequest): Promise<HostSkillLoadResult> {
  const pinned = await loadPinnedProjectSkillFile(input);
  if (pinned.status !== "missing" || pinned.reason?.startsWith("pinned_skill_")) return pinned;
  const names = [...new Set([input.source_skill_id, input.skill_id])].filter(Boolean);
  const pinnedRoot = resolve(input.cwd, ".tyrant", "skills");
  for (const rootPath of skillRoots(input.host_id, input.cwd).filter((path) => resolve(path) !== pinnedRoot)) {
    if (!(await fileExists(rootPath))) continue;
    let rootRealPath: string;
    try {
      rootRealPath = await realpath(rootPath);
    } catch {
      continue;
    }
    for (const name of names) {
      const candidates = [
        join(rootPath, name, "SKILL.md"),
        join(rootPath, name, "skill.md"),
        join(rootPath, name, ".md"),
      ];
      for (const candidate of candidates) {
        let fileRealPath: string;
        try {
          fileRealPath = await realpath(candidate);
        } catch {
          continue;
        }
        if (!isInside(rootRealPath, fileRealPath)) continue;
        let content: string;
        try {
          content = stripFrontmatter(await readFile(fileRealPath, "utf8"));
        } catch {
          continue;
        }
        if (!isTrustedSkillBody(input.source_skill_id, content)) {
          return { status: "missing", skill_id: input.skill_id, source_skill_id: input.source_skill_id, method: "host_skill_file", source_ref: fileRealPath, reason: "pinned_skill_integrity_mismatch" };
        }
        if (!content) continue;
        if (content.length > MAX_SKILL_CHARS) {
          return {
            status: "too_large", skill_id: input.skill_id, source_skill_id: input.source_skill_id,
            method: "host_skill_file", source_ref: fileRealPath, resource_base: dirname(fileRealPath), reason: "skill_body_exceeds_context_limit",
          };
        }
        return {
          status: "loaded", skill_id: input.skill_id, source_skill_id: input.source_skill_id,
          method: "host_skill_file", source_ref: fileRealPath, resource_base: dirname(fileRealPath), content,
        };
      }
    }
  }
  return {
    status: "missing", skill_id: input.skill_id, source_skill_id: input.source_skill_id,
    method: "host_skill_file", reason: "skill_not_installed",
  };
}

function specialistRoutes(prepared: Record<string, any>): Array<Record<string, any>> {
  return Array.isArray(prepared.route?.specialists) ? prepared.route.specialists.filter(isRecord) : [];
}

function hasLaterTaskBlock(prepared: Record<string, any>): boolean {
  if (safeString(prepared.task?.finish_summary, 500)) return true;
  if (isRecord(prepared.latest_block_event)) return true;
  return Array.isArray(prepared.events) && prepared.events.some((event: unknown) => isRecord(event)
    && (event.event_type === "task_blocked"
      || (event.event_type === "task_state_changed" && event.new_state === "blocked")));
}

function skillBlock(skill: HostSkillLoadResult, phase = ""): string {
  if (skill.status !== "loaded") return "";
  const source = skill.source_ref ? ` source=\"${skill.source_ref.replaceAll("\"", "&quot;")}\"` : "";
  const base = skill.resource_base ? ` resource_base=\"${skill.resource_base.replaceAll("\"", "&quot;")}\"` : "";
  const phaseAttribute = phase ? ` phase=\"${phase.replaceAll("\"", "&quot;")}\"` : "";
  return `<tyrant-skill id=\"${skill.skill_id}\" upstream=\"${skill.source_skill_id}\" method=\"${skill.method}\"${source}${base}${phaseAttribute}>\n${skill.content}\n</tyrant-skill>`;
}

function contextFor(input: HostHookInput, prepared: Record<string, any>, skillLoads: HostSkillLoadResult[], requiredSkillGaps: string[]) {
  const memorySource = safeString(prepared.memory_context?.context, MAX_PROVIDER_CHARS);
  const graphSource = safeString(prepared.graphify_context?.context, MAX_PROVIDER_CHARS);
  const providerGaps = Array.isArray(prepared.route?.provider_gaps) ? prepared.route.provider_gaps : [];
  const blockers = Array.isArray(prepared.blockers) ? prepared.blockers.filter(isRecord) : [];
  const localCheckpoint = isRecord(prepared.checkpoint) ? prepared.checkpoint : undefined;
  const resumeContext = isRecord(prepared.resume_context) ? prepared.resume_context : undefined;
  const resumeCheckpoint = resumeContext && isRecord(resumeContext.checkpoint) ? resumeContext.checkpoint : undefined;
  const route = specialistRoutes(prepared);
  const render = (memory: string, graph: string, providerTextReduced: boolean) => {
    const lines = [
      "## Tyrant automatic preflight",
      `Host: ${input.host_id}; task: ${safeString(prepared.task?.id, 128) || "unknown"}; session: ${safeString(input.session_id, 256)}.`,
      ...(safeString(prepared.task?.finish_summary, 500) ? [`Latest task outcome: ${safeString(prepared.task.finish_summary, 500)}.`] : []),
      ...(isRecord(prepared.latest_block_event) && safeString(prepared.latest_block_event.summary, 500)
        ? [`Latest blocked-state event: ${safeString(prepared.latest_block_event.summary, 500)}.`] : []),
      "This preflight completed before the host model request. Do not call prepare again for this same user prompt.",
      "",
      "### Matt Pocock main flow (always on)",
      "Tyrant automatically applied its built-in Matt Pocock-inspired orchestration policy to shape this task and select the specialist route. Skill selection is automatic; do not ask the user to approve the route. Native ask-matt remains manual-only and was not invoked.",
      "",
      "### Required project context",
      `ai-memory: ${safeString(prepared.memory_context?.status, 40) || "unavailable"} (historical, untrusted; verify against current project instructions and source).`,
      memory || (memorySource ? "ai-memory text was reduced to fit the host's inline context limit." : "No ai-memory text was returned."),
      `Graphify: ${safeString(prepared.graphify_context?.status, 40) || "unavailable"}; map=${safeString(prepared.graphify_context?.mapStatus, 40) || "unknown"} (derived current-code context; verify against source).`,
      graph || (graphSource ? "Graphify text was reduced to fit the host's inline context limit." : "No Graphify text was returned."),
      ...(providerTextReduced ? ["Provider context was reduced to fit this host's inline context limit; required skill bodies remain complete."] : []),
      ...(localCheckpoint ? [
        "",
        "### Latest Tyrant checkpoint",
        `Phase: ${safeString(localCheckpoint.phase, 80) || "unknown"}.`,
        `Last reliable step: ${safeString(localCheckpoint.last_reliable_step, 500) || "not recorded"}.`,
        `Next action: ${safeString(localCheckpoint.next_action, 500) || "not recorded"}.`,
        ...(safeString(localCheckpoint.blocker, 500) ? [prepared.task_lifecycle_transition === "resumed"
          ? `Prior blocker (cleared by this preflight): ${safeString(localCheckpoint.blocker, 500)}.`
          : `Blocker: ${safeString(localCheckpoint.blocker, 500)}.`] : []),
        ...(Array.isArray(localCheckpoint.changed_files) && localCheckpoint.changed_files.length
          ? [`Changed files: ${localCheckpoint.changed_files.slice(0, 8).map((item: unknown) => safeString(item, 180)).filter(Boolean).join(", ")}.`] : []),
        ...(Array.isArray(localCheckpoint.evidence_refs) && localCheckpoint.evidence_refs.length
          ? [`Evidence references: ${localCheckpoint.evidence_refs.slice(0, 8).map((item: unknown) => safeString(item, 180)).filter(Boolean).join(", ")}.`] : []),
      ] : []),
      ...(resumeCheckpoint ? [
        "",
        "### Prior task handoff and local checkpoint",
        `Source task: ${safeString(resumeContext?.source_task_id, 128) || "unknown"}; ${safeString(resumeContext?.source_task_summary, 500) || "prior project task"}. The handoff was claimed from ai-memory; treat it as historical evidence and verify against the current repository.`,
        `Phase: ${safeString(resumeCheckpoint.phase, 80) || "unknown"}.`,
        `Last reliable step: ${safeString(resumeCheckpoint.last_reliable_step, 500) || "not recorded"}.`,
        `Next action: ${safeString(resumeCheckpoint.next_action, 500) || "not recorded"}.`,
        ...(safeString(resumeCheckpoint.blocker, 500) ? [`Prior blocker: ${safeString(resumeCheckpoint.blocker, 500)}.`] : []),
        ...(Array.isArray(resumeCheckpoint.changed_files) && resumeCheckpoint.changed_files.length
          ? [`Changed files: ${resumeCheckpoint.changed_files.slice(0, 8).map((item: unknown) => safeString(item, 180)).filter(Boolean).join(", ")}.`] : []),
        ...(Array.isArray(resumeCheckpoint.evidence_refs) && resumeCheckpoint.evidence_refs.length
          ? [`Prior evidence references: ${resumeCheckpoint.evidence_refs.slice(0, 8).map((item: unknown) => safeString(item, 180)).filter(Boolean).join(", ")}.`] : []),
      ] : []),
      "",
      "### Route and skill loading",
      "Use each skill's phase label; defer post-implementation instructions until their route phase.",
      `Route status: ${safeString(prepared.route?.status, 40) || "unknown"}.`,
      ...(route.length ? route.map((item) => `- ${safeString(item.skill_id, 128)}: ${skillLoads.find((load) => load.skill_id === item.skill_id)?.status ?? "not_loaded"}; required=${Boolean(item.required)}; phase=${safeString(item.phase, 80) || "current"}; ${safeString(item.reason, 400)}`) : ["- No specialist skill was selected for this prompt."]),
      ...(requiredSkillGaps.length ? [`Required skill gaps: ${requiredSkillGaps.join(", ")}. Do not change code until these required skills are available.`] : []),
      ...(prepared.task_lifecycle_transition === "resumed" ? ["Tyrant recorded the blocked-to-planned transition after all required providers and routed skills became ready."] : []),
      ...(prepared.task_lifecycle_transition === "failed" ? ["Tyrant could not record the required blocked-to-planned transition; resolve the task blocker and retry the transition before code changes."] : []),
      ...(prepared.task_lifecycle_blocked === true ? ["Task lifecycle remains blocked. Do not change code until the recorded blocker is resolved and an explicit Tyrant transition is recorded."] : []),
      ...(providerGaps.length || blockers.length ? ["", "### Blockers", "Do not change code while a required provider is unavailable.", ...[...blockers, ...providerGaps].map((item) => isRecord(item)
        ? `- ${safeString(item.provider, 80) || "provider"}: ${safeString(item.message, 400) || safeString(item.status, 40) || "blocked"}`
        : `- provider: ${safeString(item, 400) || "blocked"}`)] : []),
      "",
      `Next action from Tyrant: ${safeString(prepared.next_action, 1_000) || "Follow the selected route and preserve a bounded checkpoint."}`,
    ];
    for (const skill of skillLoads) {
      const phase = safeString(route.find((item) => item.skill_id === skill.skill_id)?.phase, 80);
      const block = skillBlock(skill, phase);
      if (block) lines.push("", block);
    }
    return lines.join("\n");
  };

  const maxChars = input.host_id === "claude-code" ? MAX_CLAUDE_CONTEXT_CHARS : MAX_CONTEXT_CHARS;
  let providerLimit = MAX_PROVIDER_CHARS;
  let memory = memorySource;
  let graph = graphSource;
  let providerTextReduced = false;
  let result = render(memory, graph, providerTextReduced);
  while (result.length > maxChars && providerLimit > 0) {
    providerLimit = Math.max(0, providerLimit - 250);
    memory = memorySource.slice(0, providerLimit);
    graph = graphSource.slice(0, providerLimit);
    providerTextReduced = memory.length < memorySource.length || graph.length < graphSource.length;
    result = render(memory, graph, providerTextReduced);
  }
  if (result.length > maxChars) {
    const message = input.host_id === "claude-code"
      ? "Complete required instructions and route context exceed Claude Code's inline hook limit. Tyrant blocked this prompt before model work; reduce the required skill bundle size and retry."
      : `Complete required project and skill context exceeds ${maxChars} characters for ${input.host_id}. Tyrant blocked this prompt before model work.`;
    return {
      text: `## Tyrant blocked\n${message}`,
      error: "context_limit_exceeded" as const,
    };
  }
  return { text: result };
}

export async function prepareAutomaticHostContext(
  rawInput: HostHookInput,
  callTool: TyrantToolCaller,
  loadSkill: HostSkillLoader = loadHostSkillFile,
) {
  const input: HostHookInput = {
    host_id: safeString(rawInput.host_id, 128),
    cwd: resolve(rawInput.cwd),
    session_id: safeString(rawInput.session_id, 256),
    prompt: safeString(rawInput.prompt, MAX_TASK_CHARS),
    ...(rawInput.turn_id?.trim() ? { turn_id: safeString(rawInput.turn_id, 256) } : {}),
    ...(rawInput.invocation_id?.trim() ? { invocation_id: safeString(rawInput.invocation_id, 256) } : {}),
  };
  if (!input.host_id || !input.session_id || !input.prompt) throw new Error("Host auto-preflight requires host_id, session_id and prompt.");
  const requestId = deriveHostRequestId(input);
  let prepared = unwrapToolResponse(await callTool("tyrant_prepare_task", {
    schema_version: 1,
    task: input.prompt,
    request_id: requestId,
    host_id: input.host_id,
    session_id: input.session_id,
    resume_session: true,
  }));
  const catalogCore = getCatalogSkill("matt-pocock-main-flow");
  const currentPhaseSpecialists = specialistRoutes(prepared).filter((item) => {
    const phase = safeString(item.phase, 80);
    return phase !== "post_implementation"
      && (item.required === true || phase === "requested_review" || phase === "explicit_manual_request");
  });
  const selected = [
    { skill_id: "matt-pocock-main-flow", required: true },
    ...currentPhaseSpecialists.map((item) => ({ skill_id: String(item.skill_id ?? ""), required: item.required === true })),
  ].filter((item): item is { skill_id: string; required: boolean } => Boolean(item?.skill_id));
  const unique = [...new Map(selected.map((item) => [item.skill_id, item])).values()];
  const skillLoads: HostSkillLoadResult[] = await Promise.all(unique.map(async (item) => {
    const entry = getCatalogSkill(item.skill_id);
    if (!entry) return {
      status: "missing" as const, skill_id: item.skill_id, source_skill_id: item.skill_id,
      method: "host_skill_file" as const, reason: "skill_not_registered",
    };
    if (item.skill_id === "matt-pocock-main-flow") {
      return {
        status: "loaded" as const,
        skill_id: item.skill_id,
        source_skill_id: "tyrant-matt-orchestrator",
        method: "tyrant_builtin_policy" as const,
        source_ref: "tyrant://skills/matt-pocock-main-flow",
        content: MATT_ORCHESTRATOR_POLICY,
      };
    }
    const request = {
      host_id: input.host_id, cwd: input.cwd, skill_id: item.skill_id,
      source_skill_id: entry.upstream_skill_id ?? entry.id,
    };
    let loaded: HostSkillLoadResult;
    try {
      loaded = await loadSkill(request);
    } catch {
      return { status: "missing" as const, skill_id: request.skill_id, source_skill_id: request.source_skill_id, method: "host_skill_file" as const, reason: "skill_loader_failed" };
    }
    if (loaded.skill_id !== item.skill_id || loaded.source_skill_id !== request.source_skill_id) {
      return { status: "missing" as const, skill_id: item.skill_id, source_skill_id: request.source_skill_id, method: loaded.method, reason: "skill_identity_mismatch" };
    }
    if (loaded.status === "loaded") {
      const content = typeof loaded.content === "string" ? redactSensitiveText(loaded.content).trim() : "";
      if (!content) return { ...loaded, status: "missing", content: undefined, reason: "skill_body_empty" };
      if (content.length > MAX_SKILL_CHARS) return { ...loaded, status: "too_large", content: undefined, reason: "skill_body_exceeds_context_limit" };
      return { ...loaded, content };
    }
    return loaded;
  }));
  const requiredSkillGaps = unique.filter((item) => {
    if (!item.required) return false;
    return skillLoads.find((load) => load.skill_id === item.skill_id)?.status !== "loaded";
  }).map((item) => item.skill_id);
  const providerGaps = Array.isArray(prepared.route?.provider_gaps) ? prepared.route.provider_gaps : [];
  const blockers = Array.isArray(prepared.blockers) ? prepared.blockers : [];
  let taskLifecycleBlocked = prepared.task?.lifecycle_state === "blocked";
  let taskLifecycleTransition = taskLifecycleBlocked ? "blocked" : "not_needed";
  const lifecycleResumeDraft = {
    ...prepared,
    task: { ...prepared.task, lifecycle_state: "planned" },
    next_action: "Continue with the selected route.",
    task_lifecycle_blocked: false,
    task_lifecycle_transition: "resumed",
  };
  const resumeContext = contextFor(input, lifecycleResumeDraft, skillLoads, requiredSkillGaps);
  const wasBlockedOnlyByProviders = taskLifecycleBlocked
    && safeString(prepared.checkpoint?.blocker, 500) === "Required project context is not ready."
    && !hasLaterTaskBlock(prepared);
  const prerequisitesReady = prepared.route?.code_change_gate?.status !== "blocked"
    && providerGaps.length === 0
    && blockers.length === 0
    && requiredSkillGaps.length === 0
    && !resumeContext.error;
  if (wasBlockedOnlyByProviders && prerequisitesReady) {
    try {
      const transitionRequestId = `resume-${createHash("sha256").update(requestId).digest("hex").slice(0, 56)}`;
      const transition = unwrapToolResponse(await callTool("tyrant_transition_task", {
        schema_version: 1,
        task_id: safeString(prepared.task?.id, 128),
        request_id: transitionRequestId,
        next_state: "planned",
        reason: "All required project context providers and routed skills became ready after a provider-only block; resume the task in planned state before model work.",
        actor: "tyrant-host-adapter",
        host_id: input.host_id,
        session_id: input.session_id,
      }));
      if (isRecord(transition.task)
        && safeString(transition.task.id, 128) === safeString(prepared.task?.id, 128)
        && transition.task.lifecycle_state === "planned") {
        prepared = { ...lifecycleResumeDraft, task: transition.task };
        taskLifecycleBlocked = false;
        taskLifecycleTransition = "resumed";
      } else {
        taskLifecycleTransition = "failed";
      }
    } catch {
      taskLifecycleTransition = "failed";
    }
  }
  const formattedContext = contextFor(input, {
    ...prepared,
    task_lifecycle_blocked: taskLifecycleBlocked,
    task_lifecycle_transition: taskLifecycleTransition,
  }, skillLoads, requiredSkillGaps);
  const codeChangeAllowed = !taskLifecycleBlocked
    && prepared.route?.code_change_gate?.status !== "blocked"
    && providerGaps.length === 0
    && requiredSkillGaps.length === 0
    && !formattedContext.error;
  const result = {
    task_id: safeString(prepared.task?.id, 128),
    request_id: requestId,
    host_id: input.host_id,
    session_id: input.session_id,
    route_status: safeString(prepared.route?.status, 40) || "unknown",
    code_change_allowed: codeChangeAllowed,
    task_lifecycle_blocked: taskLifecycleBlocked,
    task_lifecycle_transition: taskLifecycleTransition,
    ...(formattedContext.error ? { host_context_error: formattedContext.error } : {}),
    required_skill_gaps: requiredSkillGaps,
    provider_gaps: providerGaps,
    skill_loads: skillLoads.map(({ content: _content, ...publicLoad }) => publicLoad),
    loaded_skills: skillLoads.filter((skill) => skill.status === "loaded"),
    context: formattedContext.text,
    core_skill_source_id: catalogCore?.upstream_skill_id ?? "tyrant-matt-orchestrator",
  };
  return result;
}

export async function recordAutomaticSkillInjection(
  preflight: Pick<Awaited<ReturnType<typeof prepareAutomaticHostContext>>, "task_id" | "request_id" | "host_id" | "session_id" | "loaded_skills"> & { context_injected: true },
  callTool: TyrantToolCaller,
) {
  let recorded = 0;
  const errors: string[] = [];
  for (const skill of preflight.loaded_skills) {
    try {
      const evidenceRef = `host-hook://${preflight.host_id}/${preflight.request_id}/${skill.skill_id}`;
      await callTool("tyrant_record_event", {
        schema_version: 1,
        task_id: preflight.task_id,
        request_id: `skill-${createHash("sha256").update(evidenceRef).digest("hex").slice(0, 56)}`,
        event_type: "skill_loaded",
        summary: `The host adapter injected ${skill.source_skill_id} instructions using ${skill.method}; this does not prove a native skill-tool invocation.`,
        skill_id: skill.skill_id,
        outcome: "success",
        evidence_refs: [evidenceRef],
        actor: "tyrant-host-adapter",
        host_id: preflight.host_id,
        session_id: preflight.session_id,
      });
      recorded += 1;
    } catch {
      errors.push(`${skill.skill_id}:event_record_failed`);
    }
  }
  return { recorded, errors };
}
