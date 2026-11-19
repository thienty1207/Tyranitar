import { randomUUID } from "node:crypto";
import { automaticPreflightBlockReason, deriveHostRequestId, type HostHookInput, type HostSkillLoadResult } from "./auto-preflight";

export type OpenCodePreflight = {
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

type OpenCodePromptEvent = {
  sessionID: string;
  cwd: string;
  messageID?: string;
  prompt: { text: string };
};

type OpenCodeContextEvent = {
  sessionID: string;
  messages?: Array<{ id?: string; role?: string }>;
  system: Array<{ type: string; text: string; metadata?: Record<string, unknown> }>;
};

export type OpenCodeHookDependencies = {
  prepare(input: HostHookInput): Promise<OpenCodePreflight>;
  record?(preflight: OpenCodePreflight & { context_injected: boolean }): Promise<unknown>;
  onError?(error: unknown): void;
};

export function createOpenCodeHooks(dependencies: OpenCodeHookDependencies) {
  const adapterInstanceId = randomUUID();
  type ContextState = { cwd: string; input: HostHookInput; preflight: OpenCodePreflight; recorded: boolean };
  const contexts = new Map<string, Map<string, ContextState>>();
  const retryAttempts = new Map<string, number>();

  return {
    async onPrompt(event: OpenCodePromptEvent): Promise<void> {
      const text = event.prompt?.text?.trim();
      if (!event.sessionID || !event.cwd || !text) return;
      const retryKey = event.messageID ? `${event.sessionID}\n${event.messageID}` : "";
      const attempt = retryKey ? retryAttempts.get(retryKey) ?? 0 : 0;
      const input: HostHookInput = {
        host_id: "opencode",
        cwd: event.cwd,
        session_id: event.sessionID,
        prompt: text,
        ...(event.messageID ? { turn_id: `${adapterInstanceId}-${event.messageID}-attempt-${attempt}` } : {}),
      };
      const requestId = deriveHostRequestId(input);
      const promptKey = event.messageID || requestId;
      try {
        const preflight = await dependencies.prepare(input);
        if (preflight.code_change_allowed !== true) {
          try {
            await dependencies.record?.({ ...preflight, host_id: "opencode", session_id: event.sessionID, cwd: event.cwd, context_injected: false });
          } catch (recordError) {
            dependencies.onError?.(recordError);
          }
          throw new Error(automaticPreflightBlockReason(preflight));
        }
        let sessionContexts = contexts.get(event.sessionID);
        if (!sessionContexts) {
          sessionContexts = new Map();
          contexts.set(event.sessionID, sessionContexts);
        }
        sessionContexts.set(promptKey, {
          cwd: event.cwd,
          input,
          preflight: { ...preflight, request_id: preflight.request_id || requestId },
          recorded: false,
        });
        while ([...contexts.values()].reduce((sum, values) => sum + values.size, 0) > 256) {
          const firstSession = contexts.keys().next().value as string | undefined;
          if (!firstSession) break;
          const firstPrompt = contexts.get(firstSession)?.keys().next().value as string | undefined;
          if (!firstPrompt) contexts.delete(firstSession);
          else {
            contexts.get(firstSession)?.delete(firstPrompt);
            if (contexts.get(firstSession)?.size === 0) contexts.delete(firstSession);
          }
        }
      } catch (error) {
        if (retryKey) {
          retryAttempts.set(retryKey, attempt + 1);
          while (retryAttempts.size > 256) retryAttempts.delete(retryAttempts.keys().next().value as string);
        }
        const sessionContexts = contexts.get(event.sessionID);
        sessionContexts?.delete(promptKey);
        if (sessionContexts?.size === 0) contexts.delete(event.sessionID);
        dependencies.onError?.(error);
        throw error;
      }
    },

    async onContext(event: OpenCodeContextEvent): Promise<void> {
      const sessionContexts = contexts.get(event.sessionID);
      if (!sessionContexts?.size) throw new Error("Tyrant preflight is missing for this OpenCode model request.");
      const currentUserMessage = event.messages?.filter((message) => message.role === "user").at(-1);
      const promptId = currentUserMessage?.id;
      const state = promptId ? sessionContexts.get(promptId) : sessionContexts.size === 1 ? sessionContexts.values().next().value : undefined;
      if (!state) throw new Error("Tyrant could not match this OpenCode model request to its admitted prompt.");
      const alreadyPresent = event.system.some((part) => part.type === "text" && part.text === state.preflight.context);
      if (!alreadyPresent) event.system.push({ type: "text", text: state.preflight.context });
      if (state.recorded || !dependencies.record) return;
      try {
        await dependencies.record({ ...state.preflight, host_id: "opencode", session_id: event.sessionID, cwd: state.cwd, context_injected: true });
        state.recorded = true;
      } catch (error) {
        dependencies.onError?.(error);
      }
    },

    forgetSession(sessionID: string): void {
      contexts.delete(sessionID);
      for (const key of retryAttempts.keys()) if (key.startsWith(`${sessionID}\n`)) retryAttempts.delete(key);
    },
  };
}
