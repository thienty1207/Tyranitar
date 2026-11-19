import { prepareAutomaticHostContext, recordAutomaticSkillInjection } from "../../src/adapters/auto-preflight";
import { createDshPreStepHandler, createDshSkillLoader, type DshSkillLookup } from "../../src/adapters/dsh";
import { openDshTyrantMcpClient } from "../../src/adapters/dsh-mcp-client";
import { createTyrantUserMessage } from "../../src/adapters/dsh-message";
import { createDshTyrantToolDefinition, dshAgentIdentity, registerTyrantToolsForDshAgent } from "../../src/adapters/dsh-agent-tools";
import { runAutomaticSessionEnd } from "../../src/adapters/session-end";
import { recordAdapterExecution } from "../../src/adapters/activation";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type DshPluginContext = {
  skills?: { get?: DshSkillLookup };
  on(event: "agent/created", listener: (payload: { agent: any }) => Promise<void>): unknown;
  on(event: "agent/pre-step", listener: (...args: any[]) => Promise<unknown>): unknown;
  on(event: "agent/disposed", listener: (payload: { agent: any }) => Promise<void>): unknown;
};

type DshAgentTools = Awaited<ReturnType<typeof registerTyrantToolsForDshAgent>>;

export const name = "tyrant-engine";
export const inject = ["skills"];
const tyrantEngineRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function apply(ctx: DshPluginContext): void {
  const agentTools = new Map<string, Promise<DshAgentTools>>();
  const ensureAgentTools = async (agent: any): Promise<DshAgentTools> => {
    const { sessionId, projectRoot } = dshAgentIdentity(agent);
    const existing = agentTools.get(sessionId);
    if (existing) return existing;
    const pending = registerTyrantToolsForDshAgent(agent, {
      openClient: (root) => openDshTyrantMcpClient(root, { engineRoot: tyrantEngineRoot }),
      createToolDefinition: (_scope, options) => createDshTyrantToolDefinition(options),
    });
    agentTools.set(sessionId, pending);
    try {
      return await pending;
    } catch (error) {
      if (agentTools.get(sessionId) === pending) agentTools.delete(sessionId);
      throw error;
    }
  };
  ctx.on("agent/created", async ({ agent }) => {
    try {
      await ensureAgentTools(agent);
    } catch {
      console.error("[tyrant] DSH could not register Tyrant tools in this agent scope; the first model step will be blocked.");
    }
  });
  const handler = createDshPreStepHandler({
    async prepare(input, agent, signal) {
      const tools = await ensureAgentTools(agent);
      let prepared: Awaited<ReturnType<typeof prepareAutomaticHostContext>> | undefined;
      const getSkill = ctx.skills?.get?.bind(ctx.skills);
      const loadSkill = createDshSkillLoader(agent, signal, getSkill);
      prepared = await prepareAutomaticHostContext(input, (name, args) => tools.callTool(name, args, signal), loadSkill);
      if (!prepared) throw new Error("Tyrant DSH preflight returned no result.");
      return { ...prepared, cwd: input.cwd };
    },
    makeMessage(text, requestId) {
      return createTyrantUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "tyrant", form: "automatic-context", request_id: requestId },
      });
    },
    async record(preflight) {
      if (!preflight.cwd || !preflight.host_id || !preflight.session_id) return;
      const cwd = preflight.cwd;
      const sessionId = preflight.session_id;
      const recordings: Promise<unknown>[] = [recordAdapterExecution(preflight.cwd, "dsh", preflight.context_injected ? "context_injected" : "blocked")];
      const pendingTools = agentTools.get(sessionId);
      if (preflight.context_injected && pendingTools) recordings.push(pendingTools.then((tools) =>
        recordAutomaticSkillInjection({ ...preflight, host_id: "dsh", session_id: sessionId, context_injected: true }, (name, args) => tools.callTool(name, args))));
      await Promise.allSettled(recordings);
    },
    onError(error) {
      const message = error instanceof Error && error.message.startsWith("Tyrant blocked model work because required project context is unavailable")
        ? error.message
        : "Tyrant preflight failed; the model step was not admitted. Check the task checkpoint for the blocker.";
      console.error(`[tyrant] DSH preflight stopped: ${message}`);
    },
  });
  ctx.on("agent/pre-step", handler);
  ctx.on("agent/disposed", async ({ agent }) => {
    let sessionId = "";
    let cwd = "";
    try {
      const identity = dshAgentIdentity(agent);
      sessionId = identity.sessionId;
      cwd = identity.projectRoot;
    } catch {
      console.error("[tyrant] DSH agent disposal did not include project/session identity; handoff sync remains pending.");
      return;
    }
    const pendingTools = agentTools.get(sessionId);
    agentTools.delete(sessionId);
    try {
      if (!pendingTools) throw new Error("dsh_agent_tools_unavailable");
      const tools = await pendingTools;
      const result = await runAutomaticSessionEnd({
        host_id: "dsh", cwd, session_id: sessionId, event: "agent/disposed",
      }, (name, args) => tools.callTool(name, args));
      if (["pending_sync", "lookup_failed"].includes(result.status)) {
        console.error(`[tyrant] DSH disposal handoff remains pending (${result.error_code ?? result.status}).`);
      }
    } catch {
      console.error("[tyrant] DSH disposal handoff could not reach Tyrant; sync remains pending.");
    } finally {
      if (pendingTools) {
        try { await (await pendingTools).dispose(); } catch { /* Registration failure already blocks this agent's model step. */ }
      }
    }
  });
}
