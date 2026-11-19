import { createHash, randomUUID } from "node:crypto";
import {
  automaticPreflightBlockReason,
  deriveHostRequestId,
  loadHostSkillFile,
  loadPinnedProjectSkillFile,
  type HostHookInput,
  type HostSkillLoadRequest,
  type HostSkillLoadResult,
  type HostSkillLoader,
} from "./auto-preflight";
import { isTrustedSkillBody } from "../routing/skill-integrity";

export type DshPreflight = {
  task_id: string;
  request_id: string;
  context: string;
  code_change_allowed: boolean;
  provider_gaps?: unknown[];
  required_skill_gaps?: unknown[];
  task_lifecycle_blocked?: boolean;
  task_lifecycle_transition?: string;
  loaded_skills: HostSkillLoadResult[];
  skill_loads: Array<Record<string, unknown>>;
  host_id?: string;
  session_id?: string;
  cwd?: string;
};

type DshUserMessage = {
  id: string;
  source?: { kind?: string; [key: string]: unknown };
  content?: unknown;
};

type DshDecision = { kind: "reject" } | { kind: "enter"; messages: DshUserMessage[]; [key: string]: unknown };

type DshAgent = {
  id?: string;
  session?: { id?: string; header?: { cwd?: string } };
};

export type DshSkillLookup = (
  candidate: string,
  options: { cwd: string; signal: AbortSignal; scope: DshAgent },
) => Promise<unknown>;

function resourceBaseString(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "directory" && typeof value.path === "string") return value.path;
  if (value.kind === "url" && typeof value.url === "string") return value.url;
  if (value.kind === "opaque" && typeof value.description === "string") return value.description;
  return undefined;
}

export function createDshSkillLoader(agent: DshAgent, signal: AbortSignal, getSkill?: DshSkillLookup): HostSkillLoader {
  return async (input: HostSkillLoadRequest): Promise<HostSkillLoadResult> => {
    const pinnedProjectSkill = await loadPinnedProjectSkillFile(input);
    if (pinnedProjectSkill.reason?.startsWith("pinned_skill_")) return pinnedProjectSkill;
    if (getSkill) {
      try {
        const result: unknown = await getSkill(input.source_skill_id, { cwd: input.cwd, signal, scope: agent });
        if (isRecord(result) && typeof result.content === "string" && result.content.trim()) {
          const nativeContent = stripSkillFrontmatter(result.content);
          if (pinnedProjectSkill.status === "loaded" && nativeContent !== pinnedProjectSkill.content) return pinnedProjectSkill;
          if (pinnedProjectSkill.status !== "loaded" && !isTrustedSkillBody(input.source_skill_id, nativeContent)) {
            return { ...pinnedProjectSkill, status: "missing", reason: "pinned_skill_integrity_mismatch", source_ref: `dsh-skill://${encodeURIComponent(input.source_skill_id)}` };
          }
          return {
            status: "loaded",
            skill_id: input.skill_id,
            source_skill_id: input.source_skill_id,
            method: "host_skill_registry",
            source_ref: `dsh-skill://${encodeURIComponent(input.source_skill_id)}`,
            ...(resourceBaseString(result.resourceBase) ? { resource_base: resourceBaseString(result.resourceBase) } : {}),
            content: nativeContent,
          };
        }
      } catch {
        if (signal.aborted) throw new Error("DSH skill loading was aborted.");
      }
    }
    if (signal.aborted) throw new Error("DSH skill loading was aborted.");
    if (pinnedProjectSkill.status !== "missing") return pinnedProjectSkill;
    return loadHostSkillFile(input);
  };
}

function stripSkillFrontmatter(content: string): string {
  const normalized = content.replaceAll("\r\n", "\n").trim();
  if (!normalized.startsWith("---\n")) return normalized;
  const closing = normalized.indexOf("\n---", 4);
  if (closing < 0) return normalized;
  const bodyStart = normalized.indexOf("\n", closing + 4);
  return bodyStart < 0 ? "" : normalized.slice(bodyStart + 1).trim();
}

type DshPreStepPayload = {
  agent: DshAgent;
  messages: DshUserMessage[];
  turn: number;
  step: number;
  signal: AbortSignal;
};

export type DshPreStepDependencies = {
  prepare(input: HostHookInput, agent: DshAgent, signal: AbortSignal): Promise<DshPreflight>;
  makeMessage(text: string, requestId: string): DshUserMessage;
  record?(preflight: DshPreflight & { context_injected: boolean }): Promise<unknown>;
  onError?(error: unknown): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOfMessage(message: DshUserMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n")
    .trim();
}

function isDirectUserMessage(message: DshUserMessage): boolean {
  return isRecord(message.source) && message.source.kind === "user";
}

export function createDshPreStepHandler(dependencies: DshPreStepDependencies) {
  const adapterInstanceId = randomUUID();
  const cache = new Map<string, Promise<DshPreflight>>();
  const injected = new Set<string>();
  const retryAttempts = new Map<string, number>();

  return async (payload: DshPreStepPayload, next: () => Promise<DshDecision>): Promise<DshDecision> => {
    const decision = await next();
    if (decision.kind === "reject" || payload.signal.aborted) return decision;
    const prompt = decision.messages.filter(isDirectUserMessage).map(textOfMessage).filter(Boolean).join("\n\n").trim();
    if (!prompt) return decision;

    const agent = payload.agent;
    const sessionId = agent.session?.id ?? agent.id ?? "";
    const cwd = agent.session?.header?.cwd ?? "";
    if (!sessionId || !cwd) return { kind: "reject" };
    const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
    const turnKey = `${sessionId}\n${payload.turn}\n${promptHash}`;
    const attempt = retryAttempts.get(turnKey) ?? 0;
    const advanceRetry = () => {
      retryAttempts.set(turnKey, attempt + 1);
      while (retryAttempts.size > 256) retryAttempts.delete(retryAttempts.keys().next().value as string);
    };
    const input: HostHookInput = {
      host_id: "dsh", cwd, session_id: sessionId,
      turn_id: `turn-${adapterInstanceId}-${payload.turn}-${promptHash}-attempt-${attempt}`, prompt,
    };
    const requestId = deriveHostRequestId(input);
    const cacheKey = `${sessionId}\n${requestId}`;
    let pending = cache.get(cacheKey);
    if (!pending) {
      pending = dependencies.prepare(input, agent, payload.signal);
      cache.set(cacheKey, pending);
      while (cache.size > 256) cache.delete(cache.keys().next().value as string);
    }

    let preflight: DshPreflight;
    try {
      preflight = await pending;
    } catch (error) {
      cache.delete(cacheKey);
      advanceRetry();
      dependencies.onError?.(error);
      return payload.signal.aborted ? decision : { kind: "reject" };
    }
    if (payload.signal.aborted) {
      cache.delete(cacheKey);
      advanceRetry();
      return decision;
    }
    if (preflight.code_change_allowed !== true) {
      cache.delete(cacheKey);
      advanceRetry();
      dependencies.onError?.(new Error(automaticPreflightBlockReason(preflight)));
      try {
        await dependencies.record?.({ ...preflight, host_id: "dsh", session_id: sessionId, cwd, context_injected: false });
      } catch (error) {
        dependencies.onError?.(error);
      }
      return { kind: "reject" };
    }

    if (injected.has(cacheKey)) return decision;
    const message = dependencies.makeMessage(preflight.context, requestId);
    // DSH's claimed user batch must remain before injected context. This keeps the
    // human request authoritative and follows the host's own context-admission order.
    const claimedIds = new Set(payload.messages.map((message) => message.id));
    const lastClaimedIndex = decision.messages.findLastIndex((message) => claimedIds.has(message.id));
    const insertionIndex = lastClaimedIndex < 0 ? decision.messages.length : lastClaimedIndex + 1;
    const messages = [...decision.messages];
    messages.splice(insertionIndex, 0, message);
    injected.add(cacheKey);
    while (injected.size > 256) injected.delete(injected.values().next().value as string);
    const result: DshDecision = { ...decision, kind: "enter", messages };
    try {
      await dependencies.record?.({ ...preflight, host_id: "dsh", session_id: sessionId, cwd, context_injected: true });
    } catch (error) {
      dependencies.onError?.(error);
    }
    return result;
  };
}
