import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureGraphifyRuntime, graphifyRuntimeStatus, GRAPHIFY_PINNED_VERSION, type GraphifyRuntimeOptions } from "../src/setup/graphify-runtime";

const root = await mkdtemp(join(tmpdir(), "tyrant-graphify-runtime-"));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function options(name: string): GraphifyRuntimeOptions {
  return { stateDirectory: join(root, name), env: { PATH: "" }, graphifyExecutable: null, uvExecutable: null };
}

test("uses an already installed exact Graphify version without reinstalling it", async () => {
  const calls: Array<{ args: string[]; env?: Record<string, string>; timeout?: number }> = [];
  const result = await graphifyRuntimeStatus({
    ...options("system"), graphifyExecutable: "graphify-system.exe",
    env: { PATH: "safe-path", OPENAI_API_KEY: "must-not-reach-graphify", DATABASE_URL: "must-not-reach-graphify" },
    runCommand: async (_executable, args, env, timeout) => {
      calls.push({ args, env, timeout });
      return { exitCode: 0, stdout: args[0] === "--version" ? `graphify ${GRAPHIFY_PINNED_VERSION}` : "Graphify help" };
    },
  });
  expect(result).toMatchObject({ status: "ready", source: "system", version: GRAPHIFY_PINNED_VERSION, executable: "graphify-system.exe" });
  expect(calls.map((call) => call.args)).toEqual([["--version"]]);
  expect(calls[0]?.env).toMatchObject({ PATH: "safe-path" });
  expect(calls[0]?.env).not.toHaveProperty("OPENAI_API_KEY");
  expect(calls[0]?.env).not.toHaveProperty("DATABASE_URL");
  expect(calls[0]?.timeout).toBeGreaterThan(0);
});

test("installs the pinned package into Tyrant-managed tool and Python directories", async () => {
  const selected = options("managed");
  let installed = false;
  let installEnv: Record<string, string> | undefined;
  const result = await ensureGraphifyRuntime({
    ...selected,
    uvExecutable: "uv.exe",
    runCommand: async (executable, args, env) => {
      if (executable === "uv.exe" && args[0] === "tool") {
        installed = true;
        installEnv = env;
        const binDirectory = env?.UV_TOOL_BIN_DIR;
        if (!binDirectory) throw new Error("missing managed bin directory");
        expect(args).not.toContain("--bin-dir");
        expect(args).not.toContain("--tool-dir");
        await mkdir(binDirectory, { recursive: true });
        await writeFile(join(binDirectory, "graphify.exe"), "fixture");
        return { exitCode: 0, stdout: "installed" };
      }
      if (args[0] === "--version") return { exitCode: 0, stdout: installed ? `graphify ${GRAPHIFY_PINNED_VERSION}` : "uv 0.13.0" };
      throw new Error(`unexpected command ${args.join(" ")}`);
    },
  });
  expect(result).toMatchObject({ status: "ready", source: "managed", version: GRAPHIFY_PINNED_VERSION });
  expect(result.executable).toBe(join(selected.stateDirectory!, "runtimes", "graphify", GRAPHIFY_PINNED_VERSION, "bin", "graphify.exe"));
  expect(installed).toBe(true);
  expect(installEnv?.UV_TOOL_DIR).toBe(join(selected.stateDirectory!, "runtimes", "graphify", GRAPHIFY_PINNED_VERSION, "tools"));
  expect(installEnv?.UV_PYTHON_INSTALL_DIR).toBe(join(selected.stateDirectory!, "runtimes", "python"));
  expect(installEnv?.UV_PYTHON_PREFERENCE).toBe("only-managed");
});

test("bootstraps missing uv privately and still requests a Tyrant-managed Python", async () => {
  const selected = options("bootstrap");
  const bootstrapped = join(selected.stateDirectory!, "runtimes", "uv", "0.13.7", "uv.exe");
  let bootstrapCalls = 0;
  let installArgs: string[] = [];
  let installed = false;
  const result = await ensureGraphifyRuntime({
    ...selected,
    bootstrapUv: async () => { bootstrapCalls += 1; return bootstrapped; },
    runCommand: async (executable, args) => {
      if (executable === bootstrapped && args[0] === "--version") return { exitCode: 0, stdout: "uv 0.13.7" };
      if (executable === bootstrapped && args[0] === "tool") { installed = true; installArgs = args; return { exitCode: 0, stdout: "installed" }; }
      if (args[0] === "--version" && installed) return { exitCode: 0, stdout: `graphify ${GRAPHIFY_PINNED_VERSION}` };
      throw new Error("unexpected command");
    },
  });
  expect(result.status).toBe("ready");
  expect(bootstrapCalls).toBe(1);
  expect(installArgs).toContain("graphifyy==0.9.109");
  expect(installArgs).toContain("only-managed");
  expect(installArgs).toContain("3.13");
  expect(installArgs).not.toContain("--bin-dir");
  expect(installArgs).not.toContain("--tool-dir");
});

test("builds the Windows uv extraction command from the downloaded archive", async () => {
  const command = await import("../src/setup/graphify-runtime").then((module) => module.buildUvExtractionCommand?.());
  expect(command).toContain("ZipFile");
  expect(command).toContain("TYRANT_UV_ARCHIVE");
  expect(command).toContain("TYRANT_UV_EXTRACT_TO");
  expect(command).toContain("uv.exe");
});

test("refuses an explicitly selected Graphify binary with an unverified version", async () => {
  await expect(ensureGraphifyRuntime({
    ...options("wrong-version"), graphifyExecutable: "user-graphify.exe",
    runCommand: async () => ({ exitCode: 0, stdout: "graphify 0.8.4" }),
  })).rejects.toThrow("graphify_version_mismatch");
  expect(existsSync(join(root, "wrong-version", "runtimes"))).toBe(false);
});
