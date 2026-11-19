import { randomUUID } from "node:crypto";
import { automaticPreflightBlockReason, prepareAutomaticHostContext, recordAutomaticSkillInjection, type HostHookInput, type HostSkillLoadResult } from "./auto-preflight";
import { withInProcessTyrantTools } from "./local-tools";
import { runAutomaticSessionEnd, type AutomaticSessionEndInput } from "./session-end";
import { recordAdapterExecution } from "./activation";

export type CommandHookHost = "codex" | "claude-code";

type CommandHookInput = {
  session_id?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  turn_id?: unknown;
  hook_event_name?: unknown;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCommandHookInput(host: CommandHookHost, input: unknown): HostHookInput {
  if (!record(input)) throw new Error("Tyrant hook input must be an object.");
  if (input.hook_event_name !== undefined && input.hook_event_name !== "UserPromptSubmit") {
    throw new Error("Tyrant prompt adapter received an unsupported hook event.");
  }
  const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (!sessionId || !cwd || !prompt.trim()) throw new Error("Tyrant hook input is missing session_id, cwd, or prompt.");
  const turnId = typeof input.turn_id === "string" && input.turn_id.trim() ? input.turn_id.trim() : undefined;
  return { host_id: host, cwd, session_id: sessionId, prompt, ...(turnId ? { turn_id: turnId } : {}) };
}

export function parseCommandSessionEndInput(host: CommandHookHost, input: unknown): AutomaticSessionEndInput {
  if (!record(input)) throw new Error("Tyrant session-end input must be an object.");
  if (input.hook_event_name !== "SessionEnd") throw new Error("Tyrant session-end adapter received an unsupported hook event.");
  const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (!sessionId || !cwd) throw new Error("Tyrant session-end input is missing session_id or cwd.");
  return { host_id: host, cwd, session_id: sessionId, event: "SessionEnd" };
}

export function createCommandHookOutput(host: CommandHookHost, context: string, codeChangeAllowed = true, blockReason?: string) {
  const contextOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit" as const,
      additionalContext: context,
    },
  };
  if (codeChangeAllowed) return contextOutput;
  return {
    decision: "block" as const,
    reason: blockReason ?? "Tyrant blocked code work because required project context is unavailable.",
    ...contextOutput,
  };
}

export function createCommandHookFailure(host: CommandHookHost) {
  const reason = "Tyrant could not prepare required project context. Retry after checking Tyrant, ai-memory, and Graphify setup.";
  return host === "codex"
    ? { decision: "block" as const, reason }
    : { decision: "block" as const, reason };
}

export type CommandHookPreflight = {
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
  [key: string]: unknown;
};

export type CommandHookDependencies = {
  prepare(input: HostHookInput): Promise<CommandHookPreflight>;
  record?(preflight: CommandHookPreflight & { host_id: string; session_id: string; context_injected: boolean }): Promise<unknown>;
};

export async function runCommandHook(
  host: CommandHookHost,
  rawInput: string,
  dependencies: CommandHookDependencies,
  write: (line: string) => void,
): Promise<void> {
  let input: HostHookInput;
  let preflight: CommandHookPreflight;
  try {
    input = { ...parseCommandHookInput(host, JSON.parse(rawInput) as CommandHookInput), invocation_id: randomUUID() };
    preflight = await dependencies.prepare(input);
  } catch {
    write(`${JSON.stringify(createCommandHookFailure(host))}\n`);
    return;
  }

  // Provider/required-skill gaps are hard admission failures, not prompt guidance.
  // Once the response reaches stdout the host owns admission; logging cannot change it.
  const contextInjected = preflight.code_change_allowed === true;
  write(`${JSON.stringify(createCommandHookOutput(host, preflight.context, contextInjected, automaticPreflightBlockReason(preflight)))}\n`);
  try {
    await dependencies.record?.({ ...preflight, host_id: input.host_id, session_id: input.session_id, context_injected: contextInjected });
  } catch {
    // Context is already returned; evidence logging is best-effort and must not corrupt stdout.
  }
}

async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

async function runCli(): Promise<void> {
  const host = process.argv[2] as CommandHookHost;
  if (host !== "codex" && host !== "claude-code") {
    process.stderr.write("Usage: bun run command-hook.ts <codex|claude-code>\n");
    process.exitCode = 2;
    return;
  }

  const rawInput = await readStdin().catch(() => "");
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawInput);
  } catch {
    decoded = undefined;
  }
  if (record(decoded) && decoded.hook_event_name === "SessionEnd") {
    try {
      const input = parseCommandSessionEndInput(host, decoded);
      let result: Awaited<ReturnType<typeof runAutomaticSessionEnd>> | undefined;
      await withInProcessTyrantTools(input.cwd, async (callTool) => {
        result = await runAutomaticSessionEnd(input, callTool);
      });
      if (result && ["pending_sync", "lookup_failed"].includes(result.status)) {
        process.stderr.write(`[tyrant] Session-end handoff remains pending (${result.error_code ?? result.status}).\n`);
      }
    } catch {
      process.stderr.write("[tyrant] Session-end handoff could not run; sync remains pending.\n");
    }
    return;
  }
  let projectCwd: string | undefined;
  await runCommandHook(host, rawInput, {
    async prepare(input) {
      projectCwd = input.cwd;
      let preflight: Awaited<ReturnType<typeof prepareAutomaticHostContext>> | undefined;
      await withInProcessTyrantTools(input.cwd, async (callTool) => {
        preflight = await prepareAutomaticHostContext(input, callTool);
      });
      if (!preflight) throw new Error("preflight_missing");
      return preflight;
    },
    async record(preflight) {
      if (!projectCwd) return;
      const recordings: Promise<unknown>[] = [recordAdapterExecution(projectCwd, host, preflight.context_injected ? "context_injected" : "blocked")];
      if (preflight.context_injected === true) recordings.push(withInProcessTyrantTools(projectCwd, async (callTool) => {
        await recordAutomaticSkillInjection({ ...preflight, context_injected: true }, callTool);
      }));
      await Promise.allSettled(recordings);
    },
  }, (line) => process.stdout.write(line));
}

if (import.meta.main) await runCli();
