import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { redactSensitiveText } from "../state/redaction";
import { AI_MEMORY_UPSTREAM_TOOLS } from "./ai-memory-tool-contract";

const DEFAULT_URL = "http://127.0.0.1:49374/mcp";
const MAX_CONTEXT_CHARS = 6_000;
const MAX_HIT_CHARS = 1_200;
const MAX_OUTCOME_CHARS = 4_000;
const MAX_PROXY_RESULT_CHARS = 100_000;
const TIMEOUT_MS = 8_000;
const PROJECT_MARKER_PATH = "tyrant/project.md";
const DEFAULT_DATA_DIR = "D:\\AI-MEMORY";
const MAX_AUTH_TOKEN_FILE_BYTES = 16_384;

type Scope = { workspace: string; project: string };
export type AiMemoryConfig = {
  url: string;
  authToken?: string;
  scope: Scope | null;
  timeoutMs: number;
  projectRoot: string;
};

type MemoryContextInput = { taskId?: string; summary: string; resume: boolean; sessionId?: string };
export type MemoryContextResult = {
  status: "ready" | "incomplete" | "unavailable";
  context: string;
  references: string[];
  handoffStatus: "claimed" | "none" | "ambiguous" | "uncertain" | "not_checked";
  errorCode?: string;
};

export type MemoryOutcomeInput = {
  taskId: string;
  lifecycleState: string;
  summary: string;
  nextAction?: string;
  sessionId?: string;
  priorHandoffStatus?: "none" | "created" | "existing" | "uncertain" | "not_required";
  priorHandoffId?: string;
};
export type MemoryOutcomeResult = {
  status: "synced" | "incomplete" | "unavailable";
  pageRef?: string;
  handoffStatus: "created" | "existing" | "uncertain" | "not_required";
  handoffId?: string;
  errorCode?: string;
  failedOperation?: string;
};

type ToolPayload = Record<string, unknown>;

class MemoryCallError extends Error {
  constructor(readonly code: string, readonly payload?: unknown, readonly failedOperation?: string) {
    super(code);
    this.name = "MemoryCallError";
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeUrl(value: string): string {
  const parsed = new URL(value);
  if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("invalid_url");
  }
  if (parsed.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new Error("insecure_remote_url");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path.endsWith("/mcp") ? path : `${path}/mcp`;
  return parsed.toString().replace(/\/$/, "");
}

function readProjectScope(projectRoot: string): Scope | null {
  try {
    const raw = readFileSync(resolve(projectRoot, ".ai-memory.toml"), "utf8");
    const parsed = Bun.TOML.parse(raw) as Record<string, unknown>;
    const workspace = stringValue(parsed.workspace);
    const project = stringValue(parsed.project);
    return workspace && project ? { workspace, project } : null;
  } catch {
    return null;
  }
}

function readAuthTokenFile(path: string): string {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("token_file_missing");
    throw new Error("token_file_unreadable");
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("token_file_not_regular");
  if (info.size > MAX_AUTH_TOKEN_FILE_BYTES) throw new Error("token_file_too_large");
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error("token_file_unreadable");
  }
  if (bytes.length > MAX_AUTH_TOKEN_FILE_BYTES) throw new Error("token_file_too_large");
  const token = bytes.toString("utf8").trim();
  if (!token) throw new Error("token_file_empty");
  if (/[\u0000-\u001f\u007f]/.test(token)) throw new Error("token_file_invalid");
  return token;
}

export function getAiMemoryConfig(projectRoot = process.env.TYRANT_PROJECT_ROOT || process.cwd(), env: Record<string, string | undefined> = process.env): AiMemoryConfig {
  const resolvedRoot = resolve(projectRoot);
  const url = normalizeUrl(env.TYRANT_AI_MEMORY_URL?.trim() || env.AI_MEMORY_SERVER_URL?.trim() || DEFAULT_URL);
  const explicitToken = env.TYRANT_AI_MEMORY_AUTH_TOKEN?.trim() || env.AI_MEMORY_AUTH_TOKEN?.trim();
  const explicitTokenFile = env.TYRANT_AI_MEMORY_TOKEN_FILE?.trim() || env.AI_MEMORY_TOKEN_FILE?.trim();
  const configuredDataDir = env.AI_MEMORY_DATA_DIR?.trim();
  let authToken = explicitToken || undefined;
  if (!authToken) {
    const tokenPath = explicitTokenFile ? resolve(explicitTokenFile) : join(resolve(configuredDataDir || DEFAULT_DATA_DIR), "auth-token");
    try {
      authToken = readAuthTokenFile(tokenPath);
    } catch (error) {
      const isOptionalDefaultMissing = !explicitTokenFile && !configuredDataDir
        && error instanceof Error && error.message === "token_file_missing";
      if (!isOptionalDefaultMissing) throw error;
    }
  }
  const envWorkspace = env.TYRANT_AI_MEMORY_WORKSPACE?.trim();
  const envProject = env.TYRANT_AI_MEMORY_PROJECT?.trim();
  let scope: Scope | null;
  if (envWorkspace || envProject) {
    if (!envWorkspace || !envProject) throw new Error("scope_incomplete");
    scope = { workspace: envWorkspace, project: envProject };
  } else {
    scope = readProjectScope(resolvedRoot);
  }
  const timeoutValue = Number(env.TYRANT_AI_MEMORY_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue >= 500 && timeoutValue <= 30_000 ? timeoutValue : TIMEOUT_MS;
  return { url, authToken, scope, timeoutMs, projectRoot: resolvedRoot };
}

function toRecord(value: unknown): ToolPayload | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as ToolPayload : undefined;
}

function decodeResult(result: { structuredContent?: unknown; content: Array<{ type: string; text?: string }>; isError?: boolean }): ToolPayload {
  if (result.structuredContent !== undefined) {
    const structured = toRecord(result.structuredContent);
    if (structured) return structured;
  }
  for (const item of result.content) {
    if (item.type !== "text" || typeof item.text !== "string") continue;
    try {
      const parsed = JSON.parse(item.text) as unknown;
      const record = toRecord(parsed);
      if (record) return record;
      return { value: parsed };
    } catch {
      return { text: item.text };
    }
  }
  return result.isError ? { error: "tool_failed" } : {};
}

const KNOWN_ERROR_CODES = new Set([
  "page_not_found", "not_found", "missing_page", "precondition_failed", "scope_missing", "scope_incomplete",
  "unauthorized", "forbidden", "tool_failed", "provider_error", "invalid_config", "invalid_url", "insecure_remote_url",
  "token_file_missing", "token_file_not_regular", "token_file_too_large", "token_file_empty", "token_file_invalid", "token_file_unreadable",
]);

function normalizeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toLowerCase();
  if (KNOWN_ERROR_CODES.has(code)) return code;
  if (/^rpc_[a-z0-9]{1,16}$/.test(code)) return code;
  if (/^-?\d{1,8}$/.test(code)) return `rpc_${code.replace("-", "n")}`;
  if (/page.{0,20}not found|not found.{0,20}page/.test(code)) return "page_not_found";
  if (/scope.{0,20}(missing|not found)|workspace.{0,20}project/.test(code)) return "scope_missing";
  return "tool_failed";
}

function payloadError(payload: ToolPayload): string | undefined {
  const error = payload.error;
  if (typeof error === "string") return normalizeErrorCode(error);
  const nested = toRecord(error);
  if (nested) {
    const nestedCode = typeof nested.code === "number" && Number.isFinite(nested.code)
      ? String(nested.code)
      : stringValue(nested.code);
    return normalizeErrorCode(nestedCode ?? stringValue(nested.message));
  }
  return undefined;
}

function errorData(value: unknown): ToolPayload | undefined {
  if (value instanceof MemoryCallError) return toRecord(value.payload);
  const record = toRecord(value);
  return toRecord(record?.data) ?? toRecord(record?.payload) ?? record;
}

function isPreconditionFailure(value: unknown): boolean {
  if (value instanceof MemoryCallError && value.code === "precondition_failed") return true;
  const data = errorData(value);
  if (!data) return false;
  if (stringValue(data.reason) === "precondition_failed") return true;
  const nested = toRecord(data.data);
  if (nested && stringValue(nested.reason) === "precondition_failed") return true;
  return payloadError(data) === "precondition_failed";
}

function isNotFoundPayload(payload: ToolPayload): boolean {
  return payloadError(payload) === "page_not_found" || payloadError(payload) === "not_found" || payloadError(payload) === "missing_page";
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof MemoryCallError && ["page_not_found", "not_found", "missing_page"].includes(error.code)) return true;
  const data = errorData(error);
  if (data && isNotFoundPayload(data)) return true;
  const record = toRecord(error);
  const nestedError = toRecord(data?.error);
  const nestedData = toRecord(nestedError?.data);
  const messages = [
    error instanceof Error ? error.message : undefined,
    stringValue(record?.message),
    stringValue(data?.message),
    stringValue(nestedError?.message),
    stringValue(nestedData?.message),
  ].filter((message): message is string => !!message);
  return messages.some((message) =>
    /page.{0,512}not found|not found.{0,512}page|page_not_found/i.test(message),
  );
}
function bounded(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const safe = redactSensitiveText(value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " "));
  if (max <= 0) return safe ? "[TRUNCATED]" : "";
  return safe.length <= max ? safe : `${safe.slice(0, max - 1)}…`;
}

function sanitizeProxyValue(value: unknown, budget: { remaining: number }): unknown {
  if (typeof value === "string") {
    const max = Math.max(0, budget.remaining);
    const safe = bounded(value, max);
    budget.remaining = Math.max(0, budget.remaining - safe.length);
    return safe;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      if (budget.remaining <= 0) break;
      budget.remaining -= 1;
      items.push(sanitizeProxyValue(item, budget));
    }
    return items.length < value.length ? [...items, { tyrant_truncated: true }] : items;
  }
  if (typeof value === "object" && value !== null) {
    const safe: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (budget.remaining <= 0) {
        safe.tyrant_truncated = true;
        break;
      }
      budget.remaining = Math.max(0, budget.remaining - key.length - 1);
      safe[key] = sanitizeProxyValue(item, budget);
    }
    return safe;
  }
  return value;
}

function schemaPropertyNames(schema: Record<string, unknown>): Set<string> {
  const properties = toRecord(schema.properties);
  return new Set(properties ? Object.keys(properties) : []);
}

function applyDefaultProjectScope(schema: Record<string, unknown>, rawArgs: Record<string, unknown>, scope: Scope | null): Record<string, unknown> {
  const args = { ...rawArgs };
  const properties = schemaPropertyNames(schema);
  const explicitNonProjectScope = args.scope === "profile" || args.scope === "global"
    || args.global === true
    || (Array.isArray(args.scopes) && args.scopes.some((item) => item === "profile" || item === "global"));

  if (properties.has("from_workspace") || properties.has("from_project")) {
    const hasSenderScope = args.from_workspace !== undefined || args.from_project !== undefined;
    if (!hasSenderScope && scope) {
      if (properties.has("from_workspace")) args.from_workspace = scope.workspace;
      if (properties.has("from_project")) args.from_project = scope.project;
    }
  }

  if (explicitNonProjectScope) return args;

  const hasWorkspace = args.workspace !== undefined && args.workspace !== null && args.workspace !== "";
  const hasProject = args.project !== undefined && args.project !== null && args.project !== "";
  const hasProjectId = args.project_id !== undefined && args.project_id !== null && args.project_id !== "";
  const hasAnyProjectScope = hasWorkspace || hasProject || hasProjectId;
  if (!hasAnyProjectScope && scope) {
    if (properties.has("workspace")) args.workspace = scope.workspace;
    if (properties.has("project")) args.project = scope.project;
    return args;
  }

  // Never combine a caller-supplied sibling scope with the Tyrant default.
  // Let AI-Memory validate explicit partial scopes instead of guessing a destination.
  if (hasAnyProjectScope) return args;
  if (!scope && (properties.has("workspace") || properties.has("project") || properties.has("project_id"))) {
    throw new MemoryCallError("scope_missing");
  }
  return args;
}

function safeProxyError(payload: ToolPayload, operation: string): Record<string, unknown> {
  const code = payloadError(payload) ?? "tool_failed";
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, operation } }) }],
  };
}

function callErrorCode(error: unknown): string {
  if (error instanceof MemoryCallError) return normalizeErrorCode(error.code) ?? "provider_error";
  const record = toRecord(error);
  if (typeof record?.code === "number") return normalizeErrorCode(String(record.code)) ?? "provider_error";
  const rawCode = stringValue(record?.code);
  if (rawCode && KNOWN_ERROR_CODES.has(rawCode.toLowerCase())) return rawCode.toLowerCase();
  return "provider_error";
}

function handoffList(payload: ToolPayload): ToolPayload[] {
  const value = payload.handoffs ?? payload.items ?? payload.value;
  return Array.isArray(value) ? value.map(toRecord).filter((item): item is ToolPayload => !!item) : [];
}

function handoffId(handoff: ToolPayload): string | undefined {
  return stringValue(handoff.handoff_id) ?? stringValue(handoff.id);
}

function extractContext(payload: ToolPayload): Array<{ ref?: string; text: string }> {
  const hits = payload.hits ?? payload.results ?? payload.items ?? payload.value;
  if (!Array.isArray(hits)) return [];
  return hits.slice(0, 6).map((raw) => {
    const hit = toRecord(raw) ?? {};
    const page = toRecord(hit.page) ?? {};
    const excerpt = bounded(hit.snippet ?? hit.excerpt ?? hit.body_excerpt ?? hit.summary ?? hit.content ?? hit.body ?? hit.text ?? page.snippet ?? page.excerpt, MAX_HIT_CHARS);
    const title = bounded(hit.title ?? page.title, 180);
    const text = excerpt && title ? title + ": " + excerpt : excerpt || title;
    const id = stringValue(hit.page_id) ?? stringValue(hit.id) ?? stringValue(page.page_id) ?? stringValue(page.id);
    const path = stringValue(hit.path) ?? stringValue(page.path);
    return { ref: id ? "ai-memory:page:" + id : path ? "ai-memory:path:" + path : undefined, text };
  }).filter((hit) => hit.text.length > 0);
}

function extractHandoffText(payload: ToolPayload): string {
  const handoff = toRecord(payload.handoff) ?? payload;
  const summary = bounded(handoff.summary ?? handoff.content ?? handoff.text, 1_400);
  const openQuestions = Array.isArray(handoff.open_questions)
    ? handoff.open_questions.slice(0, 5).map((question) => bounded(question, 300)).filter(Boolean)
    : [];
  const nextSteps = Array.isArray(handoff.next_steps)
    ? handoff.next_steps.slice(0, 5).map((step) => bounded(step, 300)).filter(Boolean)
    : [];
  return [summary, ...openQuestions.map((question) => "Question: " + question), ...nextSteps.map((step) => "Next: " + step)].filter(Boolean).join("\n");
}

export class AiMemoryProvider {
  private readonly config: AiMemoryConfig | null;
  private readonly configError?: string;

  constructor(config?: AiMemoryConfig, projectRoot?: string) {
    try {
      this.config = config ?? getAiMemoryConfig(projectRoot);
    } catch (error) {
      this.config = null;
      const safeCode = error instanceof Error && /^token_file_(missing|not_regular|too_large|empty|invalid|unreadable)$/.test(error.message)
        ? error.message
        : "invalid_config";
      this.configError = safeCode;
    }
  }

  private async withClient<T>(sessionId: string | undefined, action: (client: Client, config: AiMemoryConfig) => Promise<T>, requireScope = true): Promise<T> {
    const config = this.config;
    if (!config) throw new MemoryCallError(this.configError ?? "invalid_config");
    if (requireScope && !config.scope) throw new MemoryCallError("scope_missing");
    const headers: Record<string, string> = {};
    if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;
    if (sessionId) headers["X-Memory-Actor-Session-Id"] = bounded(sessionId, 256);
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers, redirect: "error" },
    });
    const client = new Client({ name: "tyrant", version: "0.1.0" });
    try {
      await client.connect(transport, { timeout: config.timeoutMs });
      return await action(client, config);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async call(client: Client, config: AiMemoryConfig, name: string, args: Record<string, unknown>): Promise<ToolPayload> {
    try {
      const result = await client.callTool({ name, arguments: { ...config.scope, ...args } }, { timeout: config.timeoutMs });
      const payload = decodeResult(result);
      if (result.isError) throw new MemoryCallError(payloadError(payload) ?? "tool_failed", payload, name);
      return payload;
    } catch (error) {
      if (error instanceof MemoryCallError) {
        throw new MemoryCallError(error.code, error.payload, error.failedOperation ?? name);
      }
      throw new MemoryCallError(callErrorCode(error), errorData(error), name);
    }
  }

  async invokeTool(name: string, rawArgs: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    const tool = AI_MEMORY_UPSTREAM_TOOLS.find((item) => item.name === name);
    if (!tool) return safeProxyError({ error: "tool_failed" }, "unknown_tool");
    if (!this.config) return safeProxyError({ error: this.configError ?? "invalid_config" }, name);
    try {
      const args = applyDefaultProjectScope(tool.inputSchema, rawArgs, this.config.scope);
      const actorSessionId = sessionId ?? stringValue(args.session_id);
      return await this.withClient(actorSessionId, async (client, config) => {
        const result = await client.callTool({ name, arguments: args }, { timeout: config.timeoutMs });
        const payload = decodeResult(result);
        if (result.isError) return safeProxyError(payload, name);
        const safeResult = sanitizeProxyValue(result, { remaining: MAX_PROXY_RESULT_CHARS });
        return toRecord(safeResult) ?? { content: [{ type: "text", text: "{}" }] };
      }, false);
    } catch (error) {
      const payload = errorData(error) ?? { error: callErrorCode(error) };
      return safeProxyError(payload, error instanceof MemoryCallError ? error.failedOperation ?? name : name);
    }
  }

  private async ensureProjectMarker(client: Client, config: AiMemoryConfig): Promise<string | undefined> {
    const body = "# Tyrant project memory\n\nThis page marks the project scope used by Tyrant. Tyrant task checkpoints remain in Tyrant state; ai-memory stores searchable historical decisions and handoffs.\n";
    let result: ToolPayload;
    try {
      result = await this.call(client, config, "memory_write_page", { path: PROJECT_MARKER_PATH, body, create_only: true });
    } catch (error) {
      if (isPreconditionFailure(error)) return undefined;
      throw error;
    }
    if (isPreconditionFailure(result)) return undefined;
    const error = payloadError(result);
    if (error) throw new MemoryCallError(error, result, "memory_write_page");
    const pageId = stringValue(result.page_id) ?? stringValue(result.id);
    return pageId ? `ai-memory:page:${pageId}` : undefined;
  }

  private async findTaskHandoffs(client: Client, config: AiMemoryConfig, taskId: string): Promise<{ matches: ToolPayload[]; failed: boolean; failedOperation?: string }> {
    try {
      const result = await this.call(client, config, "memory_handoff_list", {});
      const marker = `[tyrant-task:${taskId}]`;
      const matches = handoffList(result).filter((handoff) => {
        const summary = stringValue(handoff.summary) ?? stringValue(handoff.content) ?? "";
        return summary.includes(marker);
      });
      const failed = !!payloadError(result);
      return { matches, failed, ...(failed ? { failedOperation: "memory_handoff_list" } : {}) };
    } catch (error) {
      return {
        matches: [], failed: true,
        failedOperation: error instanceof MemoryCallError ? error.failedOperation ?? "memory_handoff_list" : "memory_handoff_list",
      };
    }
  }

  async loadContext(input: MemoryContextInput): Promise<MemoryContextResult> {
    if (!this.config || !this.config.scope) {
      return {
        status: "unavailable", context: "ai-memory context is unavailable because its explicit workspace/project scope is not configured.",
        references: [], handoffStatus: "not_checked", errorCode: this.configError ?? "scope_missing",
      };
    }
    const contextParts: string[] = ["[historical_untrusted] ai-memory contains prior-session evidence, not authoritative current project state."];
    const references: string[] = [];
    let status: MemoryContextResult["status"] = "ready";
    let handoffStatus: MemoryContextResult["handoffStatus"] = input.resume ? "none" : "not_checked";
    let errorCode: string | undefined;
    try {
      await this.withClient(input.sessionId, async (client, config) => {
        const markerRef = await this.ensureProjectMarker(client, config);
        if (markerRef) references.push(markerRef);
        else references.push(`ai-memory:path:${PROJECT_MARKER_PATH}`);

        if (input.resume && input.taskId) {
          const listed = await this.findTaskHandoffs(client, config, input.taskId);
          if (listed.failed) {
            status = "incomplete";
            handoffStatus = "uncertain";
            errorCode ??= "handoff_list_failed";
          } else if (listed.matches.length > 1) {
            status = "incomplete";
            handoffStatus = "ambiguous";
            errorCode ??= "handoff_ambiguous";
          } else if (listed.matches.length === 1) {
            const handoff = listed.matches[0];
            const id = handoffId(handoff);
            if (!id) {
              status = "incomplete";
              handoffStatus = "uncertain";
              errorCode ??= "handoff_id_missing";
            } else {
              let accepted: ToolPayload | undefined;
              try {
                accepted = await this.call(client, config, "memory_handoff_accept", { handoff_id: id });
              } catch {
                status = "incomplete";
                handoffStatus = "uncertain";
                errorCode ??= "handoff_claim_uncertain";
              }
              if (accepted) {
                const acceptedStatus = stringValue(accepted.status);
                if (acceptedStatus === "claimed" || acceptedStatus === "consumed_by_hook") {
                  handoffStatus = "claimed";
                  references.push("ai-memory:handoff:" + id);
                  const handoffText = extractHandoffText(accepted) || extractHandoffText(handoff);
                  if (handoffText) contextParts.push("Matched task handoff " + id + ":\n" + handoffText);
                } else {
                  status = "incomplete";
                  handoffStatus = "uncertain";
                  errorCode ??= "handoff_claim_unavailable";
                }
              }
            }
          }
        }

        const queryText = bounded(input.summary, 600);
        const query = await this.call(client, config, "memory_query", { query: queryText, limit: 5 });
        const hits = extractContext(query);
        for (const hit of hits) {
          if (hit.ref) references.push(hit.ref);
          contextParts.push(hit.text);
        }
        if (payloadError(query)) {
          status = "incomplete";
          errorCode = "query_failed";
        }
      });
    } catch (error) {
      status = "incomplete";
      errorCode = callErrorCode(error);
    }
    const context = bounded(contextParts.join("\n\n"), MAX_CONTEXT_CHARS);
    return { status, context, references: [...new Set(references)].slice(0, 10), handoffStatus, ...(errorCode ? { errorCode } : {}) };
  }

  async syncOutcome(input: MemoryOutcomeInput): Promise<MemoryOutcomeResult> {
    if (!this.config || !this.config.scope) {
      return { status: "unavailable", handoffStatus: "not_required", errorCode: this.configError ?? "scope_missing" };
    }
    const pagePath = `tyrant/tasks/${input.taskId}.md`;
    const safeSummary = bounded(input.summary, 800);
    const safeNext = bounded(input.nextAction ?? "", 500);
    const body = bounded([
      `# Tyrant task ${input.taskId}`,
      "",
      `- State: ${input.lifecycleState}`,
      `- Outcome: ${safeSummary}`,
      safeNext ? `- Next action: ${safeNext}` : "",
      "",
      "This page records a concise Tyrant outcome. Treat it as historical context and verify current repository state before acting.",
      "",
    ].filter(Boolean).join("\n"), MAX_OUTCOME_CHARS);
    let pageRef: string | undefined;
    let handoffStatus: MemoryOutcomeResult["handoffStatus"] = "not_required";
    let handoffIdValue: string | undefined;
    let errorCode: string | undefined;
    let failedOperation: string | undefined;
    try {
      await this.withClient(input.sessionId, async (client, config) => {
        const markerRef = await this.ensureProjectMarker(client, config);
        if (markerRef) pageRef = markerRef;
        let read: ToolPayload;
        try {
          read = await this.call(client, config, "memory_read_page", { path: pagePath });
        } catch (error) {
          if (isNotFoundError(error)) read = { error: "page_not_found" };
          else throw error;
        }
        const readError = payloadError(read);
        const isMissing = isNotFoundPayload(read);
        if (readError && !isMissing) throw new MemoryCallError(readError, read, "memory_read_page");
        const pageId = stringValue(read.page_id) ?? stringValue(read.id);
        const nestedPage = toRecord(read.page);
        const currentBody = bounded(read.body ?? read.markdown ?? read.content ?? nestedPage?.body, MAX_OUTCOME_CHARS);
        if (pageId && currentBody === body) {
          pageRef = `ai-memory:page:${pageId}`;
        } else {
          const writeArgs: Record<string, unknown> = { path: pagePath, body };
          if (pageId) writeArgs.expected_page_id = pageId;
          else writeArgs.create_only = true;
          let written: ToolPayload;
          try {
            written = await this.call(client, config, "memory_write_page", writeArgs);
          } catch (error) {
            if (isPreconditionFailure(error)) {
              throw new MemoryCallError(
                "concurrent_update", errorData(error),
                error instanceof MemoryCallError ? error.failedOperation ?? "memory_write_page" : "memory_write_page",
              );
            }
            throw error;
          }
          if (isPreconditionFailure(written)) throw new MemoryCallError("concurrent_update", written, "memory_write_page");
          const writeError = payloadError(written);
          if (writeError) throw new MemoryCallError(writeError, written, "memory_write_page");
          const newPageId = stringValue(written.page_id) ?? stringValue(written.id);
          pageRef = newPageId ? `ai-memory:page:${newPageId}` : `ai-memory:path:${pagePath}`;
        }

        if (input.lifecycleState !== "handoff") return;
        if (input.priorHandoffStatus === "created" || input.priorHandoffStatus === "existing") {
          handoffStatus = input.priorHandoffStatus;
          handoffIdValue = input.priorHandoffId;
          return;
        }
        const listed = await this.findTaskHandoffs(client, config, input.taskId);
        if (listed.failed) {
          handoffStatus = "uncertain";
          errorCode = "handoff_list_failed";
          failedOperation = listed.failedOperation;
          return;
        }
        if (listed.matches.length > 1) {
          handoffStatus = "uncertain";
          errorCode = "handoff_ambiguous";
          return;
        }
        if (listed.matches.length === 1) {
          handoffStatus = "existing";
          handoffIdValue = handoffId(listed.matches[0]);
          return;
        }
        if (input.priorHandoffStatus === "uncertain") {
          handoffStatus = "uncertain";
          errorCode = "handoff_delivery_uncertain";
          return;
        }
        try {
          const begun = await this.call(client, config, "memory_handoff_begin", {
            summary: bounded(`[tyrant-task:${input.taskId}] ${safeSummary}`, 800),
            next_steps: safeNext ? [safeNext] : [],
          });
          const beginError = payloadError(begun);
          if (beginError) throw new MemoryCallError(beginError, begun, "memory_handoff_begin");
          handoffIdValue = handoffId(begun);
          handoffStatus = handoffIdValue ? "created" : "uncertain";
          if (handoffStatus === "uncertain") errorCode = "handoff_id_missing";
        } catch (error) {
          handoffStatus = "uncertain";
          errorCode = "handoff_delivery_uncertain";
          failedOperation = error instanceof MemoryCallError ? error.failedOperation ?? "memory_handoff_begin" : "memory_handoff_begin";
        }
      });
      const incomplete = (handoffStatus as string) === "uncertain";
      return {
        status: incomplete ? "incomplete" : "synced", pageRef, handoffStatus,
        ...(handoffIdValue ? { handoffId: handoffIdValue } : {}), ...(errorCode ? { errorCode } : {}),
        ...(failedOperation ? { failedOperation } : {}),
      };
    } catch (error) {
      return {
        status: "incomplete", pageRef, handoffStatus,
        ...(handoffIdValue ? { handoffId: handoffIdValue } : {}),
        errorCode: isPreconditionFailure(error) ? "concurrent_update" : callErrorCode(error),
        ...(error instanceof MemoryCallError && error.failedOperation ? { failedOperation: error.failedOperation } : {}),
      };
    }
  }
}




