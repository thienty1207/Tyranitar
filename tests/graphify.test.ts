import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphifyProvider, isGraphifyPathWithinProject, type GraphifyInvocation } from "../src/providers/graphify";

const sandbox = await mkdtemp(join(tmpdir(), "tyrant-graphify-"));

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function createProject(name: string) {
  const projectRoot = join(sandbox, name);
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "main.ts"), "export const entry = 1;\n");
  return projectRoot;
}

async function writeGraph(projectRoot: string) {
  const output = join(projectRoot, "graphify-out");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "graph.json"), JSON.stringify({ nodes: [{ id: "main.ts::entry" }], edges: [] }));
}

test("refreshes a local code-only map, runs a bounded query, and returns stable references", async () => {
  const projectRoot = await createProject("ready");
  const invocations: GraphifyInvocation[] = [];
  const provider = new GraphifyProvider({
    projectRoot,
    executable: "graphify-fixture",
    timeoutMs: 1_000,
    runner: async (invocation) => {
      invocations.push(invocation);
      if (invocation.args[0] === "extract") await writeGraph(projectRoot);
      return {
        exitCode: 0,
        stdout: invocation.args[0] === "query" ? "main.ts::entry connects to main.ts" : "updated graph",
        stderr: "",
        timedOut: false,
      };
    },
  });

  const result = await provider.loadContext({ summary: "Trace the request entry" });

  expect(result).toMatchObject({ status: "ready", mapStatus: "current" });
  expect(result.context).toContain("main.ts::entry");
  expect(result.references).toHaveLength(2);
  expect(result.references[0]).toMatch(/^graphify:graph:graphify-out\/graph\.json#sha256=[a-f0-9]{64}$/);
  expect(result.references[1]).toMatch(/^graphify:query:[a-f0-9]{64}$/);
  expect(invocations.map((invocation) => invocation.args[0])).toEqual(["extract", "query"]);
  expect(invocations[0].args).toContain("--code-only");
  expect(invocations[0].args).toContain("--no-label");
  expect(invocations[0].args).toContain("--out");
  expect(invocations[0].env.GRAPHIFY_BACKEND).toBe("none");
  expect(invocations[0].env.GRAPHIFY_OUT).toBe(join(projectRoot, "graphify-out"));
  expect(invocations[0].env.GRAPHIFY_QUERY_LOG_DISABLE).toBe("1");
  expect(invocations[0].env.GEMINI_API_KEY).toBeUndefined();
  expect(invocations[0].env.OPENAI_API_KEY).toBeUndefined();
  expect(Object.keys(invocations[0].env).some((key) => /(?:API[_-]?KEY|(?:^|[_-])(?:ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|AUTH[_-]?TOKEN|SESSION[_-]?TOKEN|TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS?)(?:$|[_-])|BASE[_-]?URL)/i.test(key))).toBe(false);
  expect(invocations[1].args).toContain("--budget");
  expect(invocations[1].args).toContain("--depth");
  expect(invocations[1].args).toContain("--graph");
  expect(invocations[1].args[1].length).toBeLessThanOrEqual(600);
  expect(invocations[0].cwd).toBe(projectRoot);
});

test("reports Graphify unavailable without invoking a shell or fabricating a graph result", async () => {
  const projectRoot = await createProject("missing-cli");
  let called = false;
  const provider = new GraphifyProvider({
    projectRoot,
    executable: null,
    runner: async () => {
      called = true;
      throw new Error("runner should not be called");
    },
  });

  const result = await provider.loadContext({ summary: "Inspect the service" });

  expect(result).toMatchObject({ status: "unavailable", mapStatus: "missing", errorCode: "command_missing" });
  expect(result.context).toBe("");
  expect(result.references).toEqual([]);
  expect(called).toBe(false);
});

test("blocks a stale existing map when code-only refresh fails", async () => {
  const projectRoot = await createProject("stale");
  await writeGraph(projectRoot);
  const invocations: GraphifyInvocation[] = [];
  const provider = new GraphifyProvider({
    projectRoot,
    executable: "graphify-fixture",
    runner: async (invocation) => {
      invocations.push(invocation);
      return { exitCode: 2, stdout: "", stderr: "refresh failed", timedOut: false };
    },
  });

  const result = await provider.loadContext({ summary: "Inspect the service" });

  expect(result).toMatchObject({ status: "incomplete", mapStatus: "stale", errorCode: "refresh_failed" });
  expect(invocations.map((invocation) => invocation.args[0])).toEqual(["extract"]);
  expect(result.references).toEqual([]);
});

test("accepts documented no-match query outcomes while keeping output bounded and redacted", async () => {
  const projectRoot = await createProject("no-match");
  const invocations: GraphifyInvocation[] = [];
  const provider = new GraphifyProvider({
    projectRoot,
    executable: "graphify-fixture",
    runner: async (invocation) => {
      invocations.push(invocation);
      if (invocation.args[0] === "extract") await writeGraph(projectRoot);
      return invocation.args[0] === "query"
        ? { exitCode: 4, stdout: `No matching node. ${"x".repeat(4_000)} api_key=super-secret`, stderr: "", timedOut: false }
        : { exitCode: 0, stdout: "updated", stderr: "", timedOut: false };
    },
  });

  const result = await provider.loadContext({ summary: "Find a newly added symbol" });

  expect(result).toMatchObject({ status: "ready", mapStatus: "current" });
  expect(result.context.length).toBeLessThanOrEqual(3_000);
  expect(result.context).not.toContain("super-secret");
  expect(result.references).toHaveLength(2);
  expect(invocations[1].args[0]).toBe("query");
});

test("accepts Graphify's ambiguous-name result without guessing a node", async () => {
  const projectRoot = await createProject("ambiguous");
  const provider = new GraphifyProvider({
    projectRoot,
    executable: "graphify-fixture",
    runner: async (invocation) => {
      if (invocation.args[0] === "extract") await writeGraph(projectRoot);
      return invocation.args[0] === "query"
        ? { exitCode: 3, stdout: "Ambiguous matching nodes: api.ts::start, worker.ts::start", stderr: "", timedOut: false }
        : { exitCode: 0, stdout: "updated graph", stderr: "", timedOut: false };
    },
  });

  const result = await provider.loadContext({ summary: "Explain start" });

  expect(result.status).toBe("ready");
  expect(result.context).toContain("Ambiguous matching nodes");
  expect(result.context).toContain("api.ts::start");
});

test("does not query when a refresh times out and distinguishes an absent graph", async () => {
  const projectRoot = await createProject("timeout");
  const invocations: GraphifyInvocation[] = [];
  const provider = new GraphifyProvider({
    projectRoot,
    executable: "graphify-fixture",
    runner: async (invocation) => {
      invocations.push(invocation);
      return { exitCode: -1, stdout: "", stderr: "", timedOut: true };
    },
  });

  const result = await provider.loadContext({ summary: "Inspect the service" });

  expect(result).toMatchObject({ status: "unavailable", mapStatus: "missing", errorCode: "timeout" });
  expect(invocations.map((invocation) => invocation.args[0])).toEqual(["extract"]);
});

test("keeps Graphify output paths inside the selected project boundary", async () => {
  const projectRoot = await createProject("path-guard");

  expect(isGraphifyPathWithinProject(projectRoot, join(projectRoot, "graphify-out", "graph.json"))).toBe(true);
  expect(isGraphifyPathWithinProject(projectRoot, join(projectRoot, "..", "outside", "graph.json"))).toBe(false);
});

test("rejects an empty Graphify graph even when the CLI exits successfully", async () => {
  const projectRoot = await createProject("empty-graph");
  const provider = new GraphifyProvider({
    projectRoot,
    executable: "graphify-fixture",
    runner: async (invocation) => {
      if (invocation.args[0] === "extract") {
        const output = join(projectRoot, "graphify-out");
        await mkdir(output, { recursive: true });
        await writeFile(join(output, "graph.json"), JSON.stringify({ nodes: [], edges: [] }));
      }
      return { exitCode: 0, stdout: "updated", stderr: "", timedOut: false };
    },
  });

  const result = await provider.loadContext({ summary: "Inspect the project" });

  expect(result).toMatchObject({ status: "incomplete", mapStatus: "stale", errorCode: "graph_empty" });
  expect(result.references).toEqual([]);
});

test("serializes refresh and query passes for concurrent tasks in one project", async () => {
  const projectRoot = await createProject("serial");
  const invocations: string[] = [];
  let activeCalls = 0;
  let maximumActiveCalls = 0;
  const provider = new GraphifyProvider({
    projectRoot,
    executable: "graphify-fixture",
    runner: async (invocation) => {
      invocations.push(invocation.args[0]);
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      if (invocation.args[0] === "extract") await writeGraph(projectRoot);
      activeCalls -= 1;
      return { exitCode: 0, stdout: invocation.args[0] === "query" ? "query result" : "updated", stderr: "", timedOut: false };
    },
  });

  const results = await Promise.all([
    provider.loadContext({ summary: "Trace request handling" }),
    provider.loadContext({ summary: "Trace response handling" }),
  ]);

  expect(maximumActiveCalls).toBe(1);
  expect(invocations).toEqual(["extract", "query", "extract", "query"]);
  expect(results.every((result) => result.status === "ready")).toBe(true);
});

test("keeps a fresh map visible but blocks when the scoped query fails", async () => {
  const projectRoot = await createProject("query-failure");
  const invocations: GraphifyInvocation[] = [];
  const provider = new GraphifyProvider({
    projectRoot,
    executable: "graphify-fixture",
    runner: async (invocation) => {
      invocations.push(invocation);
      if (invocation.args[0] === "extract") await writeGraph(projectRoot);
      return invocation.args[0] === "query"
        ? { exitCode: 1, stdout: "", stderr: "query failed", timedOut: false }
        : { exitCode: 0, stdout: "updated graph", stderr: "", timedOut: false };
    },
  });

  const result = await provider.loadContext({ summary: "Find the request entry" });

  expect(result).toMatchObject({ status: "incomplete", mapStatus: "current", errorCode: "query_failed" });
  expect(result.references).toEqual([]);
  expect(invocations.map((invocation) => invocation.args[0])).toEqual(["extract", "query"]);
});
