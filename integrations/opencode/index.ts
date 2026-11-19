import { Plugin } from "@opencode/plugin";
import { prepareAutomaticHostContext, recordAutomaticSkillInjection } from "../../src/adapters/auto-preflight";
import { createOpenCodeHooks } from "../../src/adapters/opencode";
import { withInProcessTyrantTools } from "../../src/adapters/local-tools";
import { runAutomaticSessionEnd } from "../../src/adapters/session-end";
import { recordAdapterExecution } from "../../src/adapters/activation";

export default Plugin.define({
  id: "tyrant-engine",
  async setup(ctx) {
    const hooks = createOpenCodeHooks({
      async prepare(input) {
        let prepared: Awaited<ReturnType<typeof prepareAutomaticHostContext>> | undefined;
        await withInProcessTyrantTools(input.cwd, async (callTool) => {
          prepared = await prepareAutomaticHostContext(input, callTool);
        });
        if (!prepared) throw new Error("Tyrant OpenCode preflight returned no result.");
        return { ...prepared, cwd: input.cwd };
      },
      async record(preflight) {
        if (!preflight.cwd || !preflight.host_id || !preflight.session_id) return;
        const recordings: Promise<unknown>[] = [recordAdapterExecution(preflight.cwd, "opencode", preflight.context_injected ? "context_injected" : "blocked")];
        if (preflight.context_injected) recordings.push(withInProcessTyrantTools(preflight.cwd, async (callTool) => {
            await recordAutomaticSkillInjection({ ...preflight, context_injected: true }, callTool);
        }));
        await Promise.allSettled(recordings);
      },
      onError() {
        console.error("[tyrant] OpenCode preflight failed; the prompt was not admitted.");
      },
    });
    const projectCwd = ctx.location.project.canonical;
    const prompt = await ctx.session.hook("prompt", async (event) => {
      await hooks.onPrompt({
        sessionID: event.sessionID,
        messageID: event.messageID,
        cwd: projectCwd,
        prompt: { text: event.prompt.text },
      });
    });
    const context = await ctx.session.hook("context", async (event) => {
      await hooks.onContext(event);
    });
    const endEvents = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ["session.deleted"], signal: endEvents.signal })) {
        if (event.type !== "session.deleted") continue;
        const sessionId = event.data.sessionID;
        hooks.forgetSession(sessionId);
        try {
          const result = await withInProcessTyrantTools(projectCwd, (callTool) => runAutomaticSessionEnd({
            host_id: "opencode", cwd: projectCwd, session_id: sessionId, event: "session.deleted",
          }, callTool));
          if (["pending_sync", "lookup_failed"].includes(result.status)) {
            console.error(`[tyrant] OpenCode deletion handoff remains pending (${result.error_code ?? result.status}).`);
          }
        } catch {
          console.error("[tyrant] OpenCode deletion handoff could not reach Tyrant; sync remains pending.");
        }
      }
    })().catch(() => {
      if (!endEvents.signal.aborted) console.error("[tyrant] OpenCode session deletion watcher stopped; automatic close sync is unavailable.");
    });
    return async () => {
      endEvents.abort();
      await Promise.all([prompt.dispose(), context.dispose()]);
    };
  },
});
