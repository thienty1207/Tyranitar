import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { VaultProfile } from "../src/setup/profiles";

const profilesApi = await import("../src/setup/profiles").catch(() => undefined);
const runtimeApi = await import("../src/setup/ai-memory-runtime").catch(() => undefined);
const providerApi = await import("../src/providers/ai-memory").catch(() => undefined);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tyrant-ai-memory-profile-"));
  const stateDirectory = join(root, "user-state");
  const vaultA = join(root, "vault-a");
  const vaultB = join(root, "vault-b");
  const projectRoot = join(root, "project");
  await Promise.all([mkdir(vaultA), mkdir(vaultB), mkdir(projectRoot)]);
  return { root, stateDirectory, vaultA, vaultB, projectRoot };
}

async function writeAiMemoryConfig(vault: string, tokenPath = "auth-tokens/default", token = "profile-token") {
  const configPath = join(vault, "config.toml");
  const absoluteTokenPath = join(vault, tokenPath);
  await mkdir(join(absoluteTokenPath, ".."), { recursive: true });
  await writeFile(configPath, `[auth]\nbearer_token_file = "${tokenPath.replaceAll("\\", "/")}"\n`);
  await writeFile(absoluteTokenPath, token);
  return { configPath, tokenFile: absoluteTokenPath };
}

async function activateProfile(f: Awaited<ReturnType<typeof fixture>>, vault: string, name: string, port: number) {
  const config = await writeAiMemoryConfig(vault, "auth-tokens/default", `${name}-secret`);
  return profilesApi!.activateVaultProfile({
    vaultPath: vault,
    name,
    endpoint: `http://127.0.0.1:${port}/mcp`,
    configPath: config.configPath,
    tokenFile: config.tokenFile,
  }, { stateDirectory: f.stateDirectory });
}

test("a bound project keeps its saved AI-Memory profile when the user default changes", async () => {
  expect(profilesApi?.activateVaultProfile).toBeDefined();
  expect(providerApi?.getAiMemoryConfig).toBeDefined();
  if (!profilesApi || !providerApi) return;
  const f = await fixture();
  try {
    const profileA = await activateProfile(f, f.vaultA, "Profile A", 49375);
    const binding = await profilesApi.bindProjectProfile({ projectRoot: f.projectRoot, profile: profileA });
    await activateProfile(f, f.vaultB, "Profile B", 49376);

    const config = providerApi.getAiMemoryConfig(f.projectRoot, { TYRANT_STATE_DIR: f.stateDirectory });
    expect(config.url).toBe(profileA.endpoint);
    expect(config.authToken).toBe("Profile A-secret");
    expect(config.scope).toEqual(binding.scope);
    expect(config.profile?.id).toBe(profileA.id);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("configured custom bearer_token_file and fresh auth-tokens/default paths are read from config.toml", async () => {
  expect(runtimeApi?.readAiMemoryProfileConfig).toBeDefined();
  if (!runtimeApi) return;
  const f = await fixture();
  try {
    const custom = await writeAiMemoryConfig(f.vaultA, "secrets/custom-token", "custom-token-value");
    const customProfile: VaultProfile = {
      id: "custom-profile", name: "Custom", vaultPath: f.vaultA,
      endpoint: "http://127.0.0.1:49375/mcp", configPath: custom.configPath,
      createdAt: "2026-11-19T00:00:00.000Z", updatedAt: "2026-11-19T00:00:00.000Z",
    };
    const customConfig = runtimeApi.readAiMemoryProfileConfig(customProfile);
    expect(customConfig.tokenFile).toBe(custom.tokenFile);
    expect(customConfig.authToken).toBe("custom-token-value");

    const fresh = await writeAiMemoryConfig(f.vaultB, "auth-tokens/default", "generated-root-token");
    const freshProfile: VaultProfile = {
      id: "fresh-profile", name: "Fresh", vaultPath: f.vaultB,
      endpoint: "http://127.0.0.1:49376/mcp", configPath: fresh.configPath,
      createdAt: "2026-11-19T00:00:00.000Z", updatedAt: "2026-11-19T00:00:00.000Z",
    };
    expect(runtimeApi.readAiMemoryProfileConfig(freshProfile).authToken).toBe("generated-root-token");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("missing configured credentials fail with a safe code and no guessed token path", async () => {
  expect(runtimeApi?.readAiMemoryProfileConfig).toBeDefined();
  if (!runtimeApi) return;
  const f = await fixture();
  try {
    const configPath = join(f.vaultA, "config.toml");
    await writeFile(configPath, '[auth]\nbearer_token_file = "custom/missing"\n');
    const profile: VaultProfile = {
      id: "missing-profile", name: "Missing", vaultPath: f.vaultA,
      endpoint: "http://127.0.0.1:49375/mcp", configPath,
      createdAt: "2026-11-19T00:00:00.000Z", updatedAt: "2026-11-19T00:00:00.000Z",
    };
    expect(() => runtimeApi.readAiMemoryProfileConfig(profile)).toThrow("token_file_missing");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("AI-Memory runtime starts only the selected profile and rejects endpoint identity mismatch", async () => {
  expect(runtimeApi?.ensureAiMemoryProfile).toBeDefined();
  if (!runtimeApi) return;
  const f = await fixture();
  try {
    const config = await writeAiMemoryConfig(f.vaultA, "auth-tokens/default", "runtime-secret");
    const profile: VaultProfile = {
      id: "profile-runtime", name: "Runtime", vaultPath: f.vaultA,
      endpoint: "http://127.0.0.1:49375/mcp", configPath: config.configPath,
      createdAt: "2026-11-19T00:00:00.000Z", updatedAt: "2026-11-19T00:00:00.000Z",
    };
    const expectedVaultHash = createHash("sha256").update(f.vaultA.toLocaleLowerCase("en-US")).digest("hex");
    const calls: Array<{ executable: string; args: string[] }> = [];
    let probes = 0;
    const dependencies = {
      executable: "ai-memory.exe",
      runCommand: async (executable: string, args: string[]) => {
        calls.push({ executable, args });
        return { exitCode: 0, stdout: "ai-memory 3.4.7" };
      },
      probe: async () => {
        probes += 1;
        if (probes === 1) throw new Error("ai_memory_endpoint_unreachable");
        return { serverName: "ai-memory", version: "3.4.7", profileId: profile.id, vaultHash: expectedVaultHash };
      },
      startServer: async (executable: string, args: string[]) => {
        calls.push({ executable, args });
        return 41;
      },
      inspectEndpointOwner: async (_config: unknown, expectedProcessId?: number) => expectedProcessId ? "owned" : "absent",
      wait: async () => undefined,
      retries: 2,
    };
    const ensured = await runtimeApi.ensureAiMemoryProfile(profile, dependencies);
    expect(ensured.endpoint).toBe(profile.endpoint);
    expect(ensured.authStatus).toBe("ready");
    expect(ensured.version).toBe("3.4.7");
    expect(calls.some((call) => call.args.includes("--data-dir") && call.args.includes(f.vaultA))).toBe(true);
    expect(calls.some((call) => call.args.includes("runtime-secret"))).toBe(false);

    await expect(runtimeApi.ensureAiMemoryProfile(profile, {
      ...dependencies,
      inspectEndpointOwner: async () => "owned",
      probe: async () => ({ serverName: "ai-memory", version: "3.4.7", profileId: "other-profile", vaultHash: expectedVaultHash }),
      startServer: async () => { throw new Error("must_not_start_after_identity_mismatch"); },
    })).rejects.toThrow("ai_memory_identity_mismatch");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("AI-Memory setup refuses an endpoint owned by another vault before sending the bearer", async () => {
  expect(runtimeApi?.ensureAiMemoryProfile).toBeDefined();
  if (!runtimeApi) return;
  const f = await fixture();
  try {
    const config = await writeAiMemoryConfig(f.vaultA, "auth-tokens/default", "shared-root-token");
    const profile: VaultProfile = {
      id: "profile-a", name: "Profile A", vaultPath: f.vaultA,
      endpoint: "http://127.0.0.1:49375/mcp", configPath: config.configPath,
      createdAt: "2026-11-19T00:00:00.000Z", updatedAt: "2026-11-19T00:00:00.000Z",
    };
    let probeCalls = 0;
    await expect(runtimeApi.ensureAiMemoryProfile(profile, {
      executable: "ai-memory.exe",
      runCommand: async () => ({ exitCode: 0, stdout: "ai-memory 3.4.7" }),
      inspectEndpointOwner: async () => "foreign",
      probe: async () => { probeCalls += 1; return { serverName: "ai-memory", version: "3.4.7", profileId: profile.id, vaultHash: "not-relevant" }; },
      startServer: async () => { throw new Error("must_not_start_when_port_is_owned"); },
    } as any)).rejects.toThrow("ai_memory_endpoint_owner_mismatch");
    expect(probeCalls).toBe(0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("setup privately provisions the pinned AI-Memory binary when no system executable exists", async () => {
  expect(runtimeApi?.ensureAiMemoryProfile).toBeDefined();
  if (!runtimeApi) return;
  const f = await fixture();
  try {
    const config = await writeAiMemoryConfig(f.vaultA, "auth-tokens/default", "runtime-secret");
    const profile: VaultProfile = {
      id: "profile-private-install", name: "Private install", vaultPath: f.vaultA,
      endpoint: "http://127.0.0.1:49375/mcp", configPath: config.configPath,
      createdAt: "2026-11-19T00:00:00.000Z", updatedAt: "2026-11-19T00:00:00.000Z",
    };
    const expectedVaultHash = createHash("sha256").update(f.vaultA.toLocaleLowerCase("en-US")).digest("hex");
    const installedPaths: string[] = [];
    const result = await runtimeApi.ensureAiMemoryProfile(profile, {
      stateDirectory: f.stateDirectory,
      platform: "win32",
      arch: "x64",
      resolveSystemExecutable: () => undefined,
      installRuntime: async (stateDirectory: string) => {
        installedPaths.push(stateDirectory);
        return join(stateDirectory, "runtimes", "ai-memory", "3.4.7", "ai-memory.exe");
      },
      runCommand: async (_executable: string, args: string[]) => ({
        exitCode: 0,
        stdout: args[0] === "--version" ? "ai-memory 3.4.7" : "initialized",
      }),
      inspectEndpointOwner: async () => "owned",
      probe: async () => ({ serverName: "ai-memory", version: "3.4.7", profileId: profile.id, vaultHash: expectedVaultHash }),
    });

    expect(installedPaths).toEqual([f.stateDirectory]);
    expect(result).toMatchObject({ authStatus: "ready", version: "3.4.7" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("pinned AI-Memory downloader rejects an archive that does not match the release checksum", async () => {
  expect(runtimeApi?.installPinnedAiMemoryRuntime).toBeDefined();
  if (!runtimeApi) return;
  const f = await fixture();
  try {
    await expect(runtimeApi.installPinnedAiMemoryRuntime(f.stateDirectory, {
      platform: "win32", arch: "x64", fetcher: async () => new Response("not-a-release-archive"),
    })).rejects.toThrow("ai_memory_checksum_mismatch");
    expect(await Bun.file(join(f.stateDirectory, "runtimes", "ai-memory", "3.4.7", "ai-memory.exe")).exists()).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("AI-Memory extraction command expands and copies only the expected executable", () => {
  expect(runtimeApi?.buildAiMemoryExtractionCommand).toBeDefined();
  if (!runtimeApi) return;
  const command = runtimeApi.buildAiMemoryExtractionCommand();
  expect(command).toContain("ZipFile");
  expect(command).toContain("TYRANT_AI_MEMORY_ARCHIVE");
  expect(command).toContain("Get-ChildItem");
  expect(command).toContain("ai-memory.exe");
  expect(command).toContain("Copy-Item");
});
