import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { AiMemoryProvider, getAiMemoryConfig } from "../src/providers/ai-memory";

const tempRoot = await mkdtemp(join(tmpdir(), "tyrant-ai-memory-"));
const fixtures: Array<{ stop: () => Promise<void> }> = [];

type Fixture = {
  url: string;
  pages: Map<string, { page_id: string; path: string; body: string }>;
  handoffs: Array<{ handoff_id: string; summary: string; next_steps: string[]; status: string; open_questions?: string[] }>;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  setFailNextHandoff: () => void;
  replacePage: (key: string, body: string) => void;
  raceNextWrite: (key: string, body: string) => void;
  setQueryPayload: (payload: unknown) => void;
  consumeHandoffWithoutBody: () => void;
  failNextHandoffList: () => void;
  delayNextQuery: (milliseconds: number) => void;
  close: () => Promise<void>;
};

async function createMemoryFixture(): Promise<Fixture> {
  const pages = new Map<string, { page_id: string; path: string; body: string }>();
  const handoffs: Fixture["handoffs"] = [];
  const calls: Fixture["calls"] = [];
  let failNextHandoff = false;
  let handoffListFailure = false;
  let consumeWithoutBody = false;
  let queryDelayMs = 0;
  let queryPayload: unknown = {
    hits: [{ page_id: "historical-page-1", path: "decisions/auth.md", excerpt: "Earlier decision: keep provider state outside the agent transcript." }],
  };
  let pendingRace: { key: string; body: string } | undefined;
  const keyFor = (args: Record<string, unknown>) => `${args.workspace}/${args.project}/${args.path ?? ""}`;
  const buildServer = () => {
    const server = new McpServer({ name: "ai-memory-fixture", version: "1.0.0" });
    const addTool = (name: string, inputSchema: z.ZodType, run: (args: Record<string, unknown>) => unknown | Promise<unknown>) => {
      server.registerTool(name, { inputSchema }, async (raw) => {
        const args = raw as Record<string, unknown>;
        calls.push({ name, args });
        const result = await run(args);
        const output = result as Record<string, unknown>;
        if (output.__toolError === true) return { isError: true, content: [{ type: "text", text: JSON.stringify(output.payload ?? output) }] };
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      });
    };
    addTool("memory_read_page", z.object({ workspace: z.string(), project: z.string(), path: z.string() }), (args) => {
      const page = pages.get(keyFor(args));
      return page ? page : { __toolError: true, payload: { error: "page_not_found" } };
    });
    addTool("memory_write_page", z.object({
      workspace: z.string(), project: z.string(), path: z.string(), body: z.string(),
      create_only: z.boolean().optional(), expected_page_id: z.string().optional(),
    }), (args) => {
      const key = keyFor(args);
      if (pendingRace?.key === key) { pages.set(key, { page_id: "page-concurrent", path: String(args.path), body: pendingRace.body }); pendingRace = undefined; }
      const existing = pages.get(key);
      if (args.create_only && existing) return { __toolError: true, payload: { error: "precondition_failed", reason: "precondition_failed", current_page_id: existing.page_id } };
      if (args.expected_page_id && existing?.page_id !== args.expected_page_id) return { __toolError: true, payload: { error: "precondition_failed", reason: "precondition_failed", current_page_id: existing?.page_id ?? null } };
      const page = { page_id: `page-${pages.size + 1}`, path: String(args.path), body: String(args.body) };
      pages.set(key, page);
      return page;
    });
    addTool("memory_query", z.object({ workspace: z.string(), project: z.string(), query: z.string(), limit: z.number().optional() }), async () => {
      const delay = queryDelayMs;
      queryDelayMs = 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return queryPayload;
    });
    addTool("memory_handoff_list", z.object({ workspace: z.string(), project: z.string() }), () => {
      if (handoffListFailure) { handoffListFailure = false; return { __toolError: true, payload: { error: "temporary list failure" } }; }
      return { handoffs: handoffs.filter((handoff) => handoff.status === "open") };
    });
    addTool("memory_handoff_accept", z.object({ workspace: z.string(), project: z.string(), handoff_id: z.string() }), (args) => {
      const handoff = handoffs.find((entry) => entry.handoff_id === args.handoff_id && entry.status === "open");
      if (!handoff) return { status: "none_pending" };
      handoff.status = "claimed";
      if (consumeWithoutBody) { consumeWithoutBody = false; return { status: "consumed_by_hook" }; }
      return { status: "claimed", handoff };
    });
    addTool("memory_handoff_begin", z.object({
      workspace: z.string(), project: z.string(), summary: z.string(), next_steps: z.array(z.string()).optional(),
    }), (args) => {
      const handoff = {
        handoff_id: `handoff-${handoffs.length + 1}`, summary: String(args.summary),
        next_steps: (args.next_steps as string[] | undefined) ?? [], status: "open",
      };
      handoffs.push(handoff);
      if (failNextHandoff) {
        failNextHandoff = false;
        return { __toolError: true, payload: { error: "temporary tool failure after create" } };
      }
      return handoff;
    });
    return server;
  };

  const http = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("authorization") !== "Bearer local-fixture-token") return new Response("unauthorized", { status: 401 });
      const server = buildServer();
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    },
  });
  const fixture = {
    url: `http://127.0.0.1:${http.port}/mcp`, pages, handoffs, calls,
    setFailNextHandoff: () => { failNextHandoff = true; },
    replacePage: (key: string, body: string) => pages.set(key, { page_id: "page-before", path: key.split("/").slice(2).join("/"), body }),
    raceNextWrite: (key: string, body: string) => { pendingRace = { key, body }; },
    setQueryPayload: (payload: unknown) => { queryPayload = payload; },
    consumeHandoffWithoutBody: () => { consumeWithoutBody = true; },
    failNextHandoffList: () => { handoffListFailure = true; },
    delayNextQuery: (milliseconds: number) => { queryDelayMs = milliseconds; },
    close: async () => { http.stop(true); },
  };
  fixtures.push({ stop: fixture.close });
  return fixture;
}
function configFor(url: string) {
  return {
    url, authToken: "local-fixture-token", scope: { workspace: "tyrant-test", project: "sample" },
    timeoutMs: 2_000, projectRoot: tempRoot,
  };
}

afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => fixture.stop()));
  await rm(tempRoot, { recursive: true, force: true });
});

test("ai-memory config uses explicit paired scope and TOML, never a guessed directory name", async () => {
  const configRoot = join(tempRoot, "configured");
  await mkdir(configRoot, { recursive: true });
  await Bun.write(join(configRoot, ".ai-memory.toml"), 'workspace = "memory-team"\nproject = "my-project"\n');
  const fromFile = getAiMemoryConfig(configRoot, {});
  expect(fromFile).toMatchObject({ url: "http://127.0.0.1:49374/mcp", scope: { workspace: "memory-team", project: "my-project" } });
  const fromEnv = getAiMemoryConfig(configRoot, {
    TYRANT_AI_MEMORY_URL: "http://127.0.0.1:8877/", TYRANT_AI_MEMORY_WORKSPACE: "override-team",
    TYRANT_AI_MEMORY_PROJECT: "override-project", TYRANT_AI_MEMORY_AUTH_TOKEN: "secret-test-value",
  });
  expect(fromEnv).toMatchObject({ url: "http://127.0.0.1:8877/mcp", scope: { workspace: "override-team", project: "override-project" }, authToken: "secret-test-value" });
  expect(() => getAiMemoryConfig(tempRoot, { TYRANT_AI_MEMORY_WORKSPACE: "partial" })).toThrow();
  expect(getAiMemoryConfig(tempRoot, {}).scope).toBeNull();
});

test("context load initializes one marker, uses auth, bounds results, and only accepts the exact resumed task handoff", async () => {
  const fixture = await createMemoryFixture();
  fixture.handoffs.push({ handoff_id: "handoff-exact", summary: "[tyrant-task:task-123] Continue the parser work", open_questions: ["Should the parser preserve source order?"], next_steps: ["Run the focused test"], status: "open" });
  fixture.handoffs.push({ handoff_id: "handoff-other", summary: "[tyrant-task:task-456] Another task", next_steps: [], status: "open" });
  const provider = new AiMemoryProvider(configFor(fixture.url));
  const loaded = await provider.loadContext({ taskId: "task-123", summary: "Continue parser task", resume: true, sessionId: "session-1" });
  expect(loaded.status).toBe("ready");
  expect(loaded.context).toContain("historical_untrusted");
  expect(loaded.context).toContain("Earlier decision");
  expect(loaded.context).toContain("Question: Should the parser preserve source order?");
  expect(loaded.context).toContain("Run the focused test");
  expect(fixture.handoffs.find((handoff) => handoff.handoff_id === "handoff-exact")?.status).toBe("claimed");
  expect(fixture.handoffs.find((handoff) => handoff.handoff_id === "handoff-other")?.status).toBe("open");
  expect(fixture.pages.has("tyrant-test/sample/tyrant/project.md")).toBe(true);
  expect(fixture.calls.every((call) => call.args.workspace === "tyrant-test" && call.args.project === "sample")).toBe(true);
  expect(fixture.calls.some((call) => call.name === "memory_handoff_accept" && call.args.handoff_id === "handoff-exact")).toBe(true);

  const secondProvider = new AiMemoryProvider(configFor(fixture.url));
  await secondProvider.loadContext({ taskId: "task-789", summary: "Start a new task", resume: false });
  expect(fixture.handoffs.filter((handoff) => handoff.status === "open").map((handoff) => handoff.handoff_id)).toEqual(["handoff-other"]);
  const markerWrites = fixture.calls.filter((call) => call.name === "memory_write_page" && call.args.path === "tyrant/project.md");
  expect(markerWrites.filter((call) => call.args.create_only === true)).toHaveLength(2);
});

test("context parser accepts current snippet and nested page shapes while redacting secrets", async () => {
  const fixture = await createMemoryFixture();
  fixture.setQueryPayload({
    hits: [
      { page_id: "snippet-page", title: "Provider decision", snippet: "Keep retrieval bounded. Authorization: Bearer supersecretfixturetoken123." },
      { page: { id: "nested-page", path: "notes/nested.md", title: "Nested title", excerpt: "A nested excerpt." } },
    ],
  });
  const provider = new AiMemoryProvider(configFor(fixture.url));
  const loaded = await provider.loadContext({ summary: "Review provider decisions", resume: false });
  expect(loaded.status).toBe("ready");
  expect(loaded.context).toContain("Provider decision: Keep retrieval bounded.");
  expect(loaded.context).toContain("Nested title: A nested excerpt.");
  expect(loaded.context).not.toContain("supersecretfixturetoken123");
  expect(loaded.references).toContain("ai-memory:page:snippet-page");
  expect(loaded.references).toContain("ai-memory:page:nested-page");
});

test("failed or consumed handoffs remain explicit without discarding query context", async () => {
  const fixture = await createMemoryFixture();
  fixture.handoffs.push({ handoff_id: "handoff-consumed", summary: "[tyrant-task:task-consumed] Continue the parser", next_steps: ["Run parser tests"], status: "open" });
  fixture.consumeHandoffWithoutBody();
  const provider = new AiMemoryProvider(configFor(fixture.url));
  const consumed = await provider.loadContext({ taskId: "task-consumed", summary: "Continue parser", resume: true });
  expect(consumed.handoffStatus).toBe("claimed");
  expect(consumed.context).toContain("Continue the parser");
  expect(consumed.context).toContain("Run parser tests");

  fixture.failNextHandoffList();
  const incomplete = await provider.loadContext({ taskId: "task-list-failure", summary: "Resume safely", resume: true });
  expect(incomplete.status).toBe("incomplete");
  expect(incomplete.errorCode).toBe("handoff_list_failed");
  expect(incomplete.context).toContain("Earlier decision");
});

test("ambiguous task handoffs are left open and reported without claiming either", async () => {
  const fixture = await createMemoryFixture();
  fixture.handoffs.push(
    { handoff_id: "handoff-a", summary: "[tyrant-task:task-ambiguous] First candidate", next_steps: [], status: "open" },
    { handoff_id: "handoff-b", summary: "[tyrant-task:task-ambiguous] Second candidate", next_steps: [], status: "open" },
  );
  const provider = new AiMemoryProvider(configFor(fixture.url));
  const loaded = await provider.loadContext({ taskId: "task-ambiguous", summary: "Resume task", resume: true });
  expect(loaded.status).toBe("incomplete");
  expect(loaded.handoffStatus).toBe("ambiguous");
  expect(loaded.errorCode).toBe("handoff_ambiguous");
  expect(fixture.handoffs.every((handoff) => handoff.status === "open")).toBe(true);
  expect(fixture.calls.some((call) => call.name === "memory_handoff_accept")).toBe(false);
});
test("provider connection failures return safe status without exposing endpoint credentials", async () => {
  const secret = "local-provider-secret-that-must-not-leak";
  const provider = new AiMemoryProvider({
    ...configFor("http://127.0.0.1:1/mcp"),
    authToken: secret,
  });
  const loaded = await provider.loadContext({ summary: "Continue safely", resume: false });
  expect(loaded.status).toBe("incomplete");
  expect(loaded.errorCode).toBe("provider_error");
  const synced = await provider.syncOutcome({
    taskId: "task-offline", lifecycleState: "completed", summary: "Offline outcome",
  });
  expect(synced.status).toBe("incomplete");

  const fixture = await createMemoryFixture();
  fixture.delayNextQuery(1_200);
  const slowProvider = new AiMemoryProvider({ ...configFor(fixture.url), timeoutMs: 500 });
  const timedOut = await slowProvider.loadContext({ summary: "Query with bounded timeout", resume: false });
  expect(timedOut.status).toBe("incomplete");
  expect(timedOut.errorCode).toBe("provider_error");
  expect(JSON.stringify({ loaded, synced, timedOut })).not.toContain(secret);
});
test("outcome sync uses conditional page writes and creates one marked handoff", async () => {
  const fixture = await createMemoryFixture();
  const provider = new AiMemoryProvider(configFor(fixture.url));
  const result = await provider.syncOutcome({
    taskId: "task-321", lifecycleState: "handoff", summary: "Parser work is partly done", nextAction: "Run the parser regression test",
    priorHandoffStatus: "none",
  });
  expect(result.status).toBe("synced");
  expect(result.pageRef).toBeDefined();
  expect(result.handoffStatus).toBe("created");
  const saved = fixture.pages.get("tyrant-test/sample/tyrant/tasks/task-321.md");
  expect(saved?.body).toContain("Parser work is partly done");
  expect(saved?.body).not.toContain("transcript");
  expect(fixture.handoffs[0].summary).toContain("[tyrant-task:task-321]");
  expect(fixture.handoffs[0].next_steps).toContain("Run the parser regression test");

  const retry = await provider.syncOutcome({
    taskId: "task-321", lifecycleState: "handoff", summary: "Parser work is partly done", nextAction: "Run the parser regression test",
    priorHandoffStatus: "created", priorHandoffId: "handoff-1",
  });
  expect(retry.handoffId).toBe("handoff-1");
  expect(fixture.handoffs).toHaveLength(1);
});

test("a concurrent page edit is not overwritten and an uncertain handoff is not duplicated", async () => {
  const fixture = await createMemoryFixture();
  const pageKey = "tyrant-test/sample/tyrant/tasks/task-race.md";
  fixture.pages.set(pageKey, { page_id: "page-before", path: "tyrant/tasks/task-race.md", body: "Other writer's update" });
  fixture.raceNextWrite(pageKey, "Concurrent edit that must survive");
  const provider = new AiMemoryProvider(configFor(fixture.url));
  const conflict = await provider.syncOutcome({
    taskId: "task-race", lifecycleState: "completed", summary: "Local task complete", priorHandoffStatus: "none",
  });
  expect(conflict.status).toBe("incomplete");
  expect(fixture.pages.get(pageKey)?.body).toBe("Concurrent edit that must survive");

  const handoffPageKey = "tyrant-test/sample/tyrant/tasks/task-handoff-page-race.md";
  fixture.pages.set(handoffPageKey, { page_id: "handoff-page-before", path: "tyrant/tasks/task-handoff-page-race.md", body: "Other writer's handoff summary" });
  fixture.raceNextWrite(handoffPageKey, "Concurrent handoff page update");
  const pageFailure = await provider.syncOutcome({
    taskId: "task-handoff-page-race", lifecycleState: "handoff", summary: "Preserve handoff outcome",
    priorHandoffStatus: "not_required",
  });
  expect(pageFailure.status).toBe("incomplete");
  expect(pageFailure.handoffStatus).toBe("not_required");
  const pageRetry = await provider.syncOutcome({
    taskId: "task-handoff-page-race", lifecycleState: "handoff", summary: "Preserve handoff outcome",
    priorHandoffStatus: pageFailure.handoffStatus,
  });
  expect(pageRetry.handoffStatus).toBe("created");
  expect(fixture.handoffs.filter((handoff) => handoff.summary.includes("[tyrant-task:task-handoff-page-race]"))).toHaveLength(1);

  fixture.setFailNextHandoff();
  const uncertain = await provider.syncOutcome({
    taskId: "task-uncertain", lifecycleState: "handoff", summary: "handoff content", nextAction: "Continue work",
    priorHandoffStatus: "none",
  });
  expect(uncertain.handoffStatus).toBe("uncertain");
  const retried = await provider.syncOutcome({
    taskId: "task-uncertain", lifecycleState: "handoff", summary: "handoff content", nextAction: "Continue work",
    priorHandoffStatus: "uncertain",
  });
  expect(retried.handoffStatus).toBe("existing");
  expect(fixture.handoffs.filter((handoff) => handoff.summary.includes("[tyrant-task:task-uncertain]")).length).toBe(1);
});







