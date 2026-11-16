import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { redactSensitiveText } from "../state/redaction";

const MAX_QUERY_CHARS = 600;
const MAX_QUERY_CONTEXT_CHARS = 3_000;
const MAX_PROCESS_OUTPUT_CHARS = 16_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const NO_MATCH_EXIT_CODES = new Set([3, 4]);
const SECRET_ENVIRONMENT_KEY = /(?:API[_-]?KEY|(?:^|[_-])(?:ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|AUTH[_-]?TOKEN|SESSION[_-]?TOKEN|TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS?)(?:$|[_-])|BASE[_-]?URL)/i;

export type GraphifyInvocation = {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
};

export type GraphifyRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type GraphifyRunner = (invocation: GraphifyInvocation) => Promise<GraphifyRunResult>;

export type GraphifyContextResult = {
  status: "ready" | "incomplete" | "unavailable";
  mapStatus: "current" | "stale" | "missing" | "unsafe";
  context: string;
  references: string[];
  errorCode?: string;
};

type GraphifyProviderOptions = {
  projectRoot?: string;
  /** Set null in tests or setup checks to represent a missing Graphify executable. */
  executable?: string | null;
  timeoutMs?: number;
  runner?: GraphifyRunner;
};

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(parent: string, candidate: string) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent));
}

function boundedText(value: string, max: number) {
  const clean = redactSensitiveText(value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim());
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function childEnvironment(projectRoot: string) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SECRET_ENVIRONMENT_KEY.test(key)) env[key] = value;
  }
  env.GRAPHIFY_BACKEND = "none";
  env.GRAPHIFY_OUT = resolve(projectRoot, "graphify-out");
  env.GRAPHIFY_QUERY_LOG_DISABLE = "1";
  return env;
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxChars: number) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let output = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (output.length < maxChars) {
        output += decoder.decode(value, { stream: true });
        if (output.length > maxChars) output = output.slice(0, maxChars);
      }
    }
    output += decoder.decode();
    return output.slice(0, maxChars);
  } finally {
    reader.releaseLock();
  }
}

async function spawnGraphify(invocation: GraphifyInvocation): Promise<GraphifyRunResult> {
  const child = Bun.spawn([invocation.executable, ...invocation.args], {
    cwd: invocation.cwd,
    env: invocation.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {
      // The process may have exited at the same time as the timeout.
    }
  }, invocation.timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout, MAX_PROCESS_OUTPUT_CHARS),
      readBounded(child.stderr, MAX_PROCESS_OUTPUT_CHARS),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isSafeOutputPath(projectRoot: string, outputRoot: string, graphPath: string) {
  for (const path of [outputRoot, graphPath]) {
    try {
      const actual = await realpath(path);
      if (!isWithin(projectRoot, actual)) return false;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  return true;
}

function result(
  status: GraphifyContextResult["status"],
  mapStatus: GraphifyContextResult["mapStatus"],
  errorCode?: string,
): GraphifyContextResult {
  return { status, mapStatus, context: "", references: [], ...(errorCode ? { errorCode } : {}) };
}

export class GraphifyProvider {
  private readonly projectRoot: string;
  private readonly executable: string | null;
  private readonly timeoutMs: number;
  private readonly runner: GraphifyRunner;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: GraphifyProviderOptions = {}) {
    this.projectRoot = resolve(options.projectRoot ?? process.env.TYRANT_PROJECT_ROOT ?? process.cwd());
    if (options.executable !== undefined) {
      this.executable = options.executable?.trim() || null;
    } else {
      const configuredExecutable = process.env.TYRANT_GRAPHIFY_BIN?.trim();
      this.executable = configuredExecutable || Bun.which("graphify") || null;
    }
    const timeoutValue = options.timeoutMs ?? Number(process.env.TYRANT_GRAPHIFY_TIMEOUT_MS);
    this.timeoutMs = Number.isFinite(timeoutValue) && timeoutValue >= 1_000 && timeoutValue <= 300_000
      ? timeoutValue
      : DEFAULT_TIMEOUT_MS;
    this.runner = options.runner ?? spawnGraphify;
  }

  async loadContext(input: { summary: string }): Promise<GraphifyContextResult> {
    const operation = this.operationQueue.then(() => this.loadContextNow(input));
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async loadContextNow(input: { summary: string }): Promise<GraphifyContextResult> {
    const graphPath = resolve(this.projectRoot, "graphify-out", "graph.json");
    const outputRoot = resolve(this.projectRoot, "graphify-out");
    if (!this.executable) return result("unavailable", await pathExists(graphPath) ? "stale" : "missing", "command_missing");

    let projectRoot: string;
    try {
      projectRoot = await realpath(this.projectRoot);
    } catch {
      return result("unavailable", "missing", "project_unavailable");
    }
    if (!await isSafeOutputPath(projectRoot, outputRoot, graphPath)) {
      return result("unavailable", "unsafe", "unsafe_output_path");
    }

    const env = childEnvironment(projectRoot);
    const invoke = (args: string[]) => this.runner({
      executable: this.executable!, args, cwd: projectRoot, env, timeoutMs: this.timeoutMs,
    });

    let refresh: GraphifyRunResult;
    try {
      refresh = await invoke([
        "extract", projectRoot, "--code-only", "--no-viz", "--no-label", "--out", projectRoot,
      ]);
    } catch {
      const existing = await pathExists(graphPath);
      return result(existing ? "incomplete" : "unavailable", existing ? "stale" : "missing", "command_failed");
    }
    if (refresh.timedOut) {
      const existing = await pathExists(graphPath);
      return result(existing ? "incomplete" : "unavailable", existing ? "stale" : "missing", "timeout");
    }
    if (refresh.exitCode !== 0) {
      const existing = await pathExists(graphPath);
      return result(existing ? "incomplete" : "unavailable", existing ? "stale" : "missing", "refresh_failed");
    }
    if (!await isSafeOutputPath(projectRoot, outputRoot, graphPath)) {
      return result("unavailable", "unsafe", "unsafe_output_path");
    }

    let graphBytes: Uint8Array;
    try {
      const graphInfo = await Bun.file(graphPath).stat();
      if (!graphInfo.isFile() || graphInfo.size === 0) return result("incomplete", "stale", "graph_empty");
      graphBytes = new Uint8Array(await Bun.file(graphPath).arrayBuffer());
      const graph = JSON.parse(new TextDecoder().decode(graphBytes)) as unknown;
      if (typeof graph !== "object" || graph === null || Array.isArray(graph) || Object.keys(graph).length === 0) {
        return result("incomplete", "stale", "graph_invalid");
      }
      const nodes = (graph as Record<string, unknown>).nodes;
      const hasNodes = Array.isArray(nodes) ? nodes.length > 0
        : typeof nodes === "object" && nodes !== null && Object.keys(nodes).length > 0;
      if (!hasNodes) return result("incomplete", "stale", "graph_empty");
    } catch {
      return result("incomplete", "stale", "graph_invalid");
    }

    let query: GraphifyRunResult;
    try {
      query = await invoke([
        "query", boundedText(input.summary, MAX_QUERY_CHARS),
        "--budget", "500", "--depth", "2", "--graph", graphPath,
      ]);
    } catch {
      return result("incomplete", "current", "query_failed");
    }
    if (query.timedOut) return result("incomplete", "current", "query_timeout");
    if (query.exitCode !== 0 && !NO_MATCH_EXIT_CODES.has(query.exitCode)) {
      return result("incomplete", "current", "query_failed");
    }

    const queryContext = boundedText(query.stdout, MAX_QUERY_CONTEXT_CHARS)
      || (query.exitCode === 3 ? "Graphify found ambiguous matching nodes; no node was selected." : query.exitCode === 4 ? "Graphify found no matching node in the current map." : "");
    if (!queryContext) return result("incomplete", "current", "query_empty");
    const graphHash = sha256(graphBytes);
    const queryHash = sha256(queryContext);
    return {
      status: "ready",
      mapStatus: "current",
      context: `Derived Graphify context; verify against source:\n${queryContext}`.slice(0, MAX_QUERY_CONTEXT_CHARS),
      references: [
        `graphify:graph:graphify-out/graph.json#sha256=${graphHash}`,
        `graphify:query:${queryHash}`,
      ],
    };
  }
}

/** Small pure path guard kept public so Windows and Unix traversal cases are testable. */
export function isGraphifyPathWithinProject(projectRoot: string, candidate: string) {
  return isWithin(resolve(projectRoot), resolve(candidate));
}
