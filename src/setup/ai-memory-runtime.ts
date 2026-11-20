import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn as spawnProcess } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getTyrantUserDirectory, type VaultProfile } from "./profiles";

export const AI_MEMORY_PINNED_VERSION = "3.4.7";
const AI_MEMORY_ARCHIVE_URL = `https://github.com/akitaonrails/ai-memory/releases/download/v${AI_MEMORY_PINNED_VERSION}/ai-memory-windows-x86_64.zip`;
const AI_MEMORY_ARCHIVE_SHA256 = "69f41ea75c8422d8ff21543fcc2423f99ff1c3ac83b388a5097c49bc8e31e715";
const AI_MEMORY_MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_TOKEN_FILE_BYTES = 16_384;
const DEFAULT_STARTUP_RETRIES = 20;
const DEFAULT_STARTUP_DELAY_MS = 250;
const IDENTITY_PAGE_PREFIX = "tyrant/profile-identities/";
const REQUIRED_AI_MEMORY_TOOLS = ["memory_query", "memory_read_page", "memory_write_page", "memory_handoff_begin"];
const execFile = promisify(execFileCallback);

export type AiMemoryProfileConfig = {
  endpoint: string;
  url: string;
  configPath: string;
  tokenFile: string;
  authToken: string;
  bindHost: string;
  port: number;
  dataDirectory: string;
};

export type AiMemoryIdentity = {
  serverName: string;
  version: string;
  profileId: string;
  vaultHash: string;
};

export type AiMemoryRuntimeResult = {
  endpoint: string;
  authStatus: "ready";
  version: string;
};

export type AiMemoryRuntimeDependencies = {
  executable?: string;
  env?: Record<string, string | undefined>;
  stateDirectory?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  resolveSystemExecutable?: () => string | undefined;
  installRuntime?: (stateDirectory: string, platform: NodeJS.Platform, arch: string) => Promise<string>;
  runCommand?: (executable: string, args: string[], env?: Record<string, string>, timeoutMs?: number) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;
  probe?: (config: AiMemoryProfileConfig, profile: VaultProfile, allowIdentityCreate: boolean) => Promise<AiMemoryIdentity>;
  startServer?: (executable: string, args: string[]) => Promise<number>;
  inspectEndpointOwner?: (config: AiMemoryProfileConfig, expectedProcessId?: number) => Promise<"owned" | "absent" | "foreign">;
  allocatePort?: (host: string) => Promise<number>;
  wait?: (milliseconds: number) => Promise<void>;
  retries?: number;
  startupDelayMs?: number;
  initialize?: boolean;
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readTokenFileSafe(path: string): string {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("token_file_missing");
    throw new Error("token_file_unreadable");
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("token_file_not_regular");
  if (info.size > MAX_TOKEN_FILE_BYTES) throw new Error("token_file_too_large");
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error("token_file_unreadable");
  }
  if (bytes.length > MAX_TOKEN_FILE_BYTES) throw new Error("token_file_too_large");
  const token = bytes.toString("utf8").trim();
  if (!token) throw new Error("token_file_empty");
  if (/[\u0000-\u001f\u007f]/.test(token)) throw new Error("token_file_invalid");
  return token;
}

export function configuredTokenPath(configPath: string, dataDirectory: string): string {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("ai_memory_config_missing");
    throw new Error("ai_memory_config_invalid");
  }
  const auth = objectValue(objectValue(parsed)?.auth);
  const configured = safeText(auth?.bearer_token_file);
  if (!configured) throw new Error("auth_token_path_missing");
  return resolve(dataDirectory, configured);
}

function normalizedEndpoint(value: string): { endpoint: string; bindHost: string; port: number } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("profile_endpoint_invalid");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) throw new Error("profile_endpoint_must_be_loopback");
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("profile_endpoint_port_invalid");
  url.pathname = url.pathname.replace(/\/+$/, "").endsWith("/mcp") ? url.pathname.replace(/\/+$/, "") : `${url.pathname.replace(/\/+$/, "")}/mcp`;
  return { endpoint: url.toString().replace(/\/$/, ""), bindHost: url.hostname.replace(/^\[|\]$/g, ""), port };
}

export function readAiMemoryProfileConfig(profile: VaultProfile): AiMemoryProfileConfig {
  const configPath = resolve(profile.configPath);
  const dataDirectory = realpathSync(resolve(profile.vaultPath));
  const config = normalizedEndpoint(profile.endpoint);
  const tokenFile = configuredTokenPath(configPath, dataDirectory);
  const authToken = readTokenFileSafe(tokenFile);
  return {
    endpoint: config.endpoint,
    url: config.endpoint,
    configPath,
    tokenFile,
    authToken,
    bindHost: config.bindHost,
    port: config.port,
    dataDirectory,
  };
}

function managedAiMemoryDirectory(stateDirectory: string): string {
  return join(stateDirectory, "runtimes", "ai-memory", AI_MEMORY_PINNED_VERSION);
}

function managedAiMemoryExecutable(stateDirectory: string): string {
  return join(managedAiMemoryDirectory(stateDirectory), "ai-memory.exe");
}

function resolveExecutable(dependencies: AiMemoryRuntimeDependencies): { explicit?: string; system?: string } {
  const explicit = dependencies.executable?.trim() || dependencies.env?.TYRANT_AI_MEMORY_BIN?.trim() || process.env.TYRANT_AI_MEMORY_BIN?.trim();
  if (explicit) return { explicit };
  const system = dependencies.resolveSystemExecutable
    ? dependencies.resolveSystemExecutable()
    : Bun.which("ai-memory") ?? Bun.which("ai-memory.exe")
      ?? (process.platform === "win32" && process.env.LOCALAPPDATA
        ? [resolve(process.env.LOCALAPPDATA, "Programs", "ai-memory", "ai-memory.exe")].find(existsSync)
        : undefined);
  return { ...(system ? { system } : {}) };
}

async function defaultRunCommand(executable: string, args: string[], env?: Record<string, string>, timeoutMs = 120_000): Promise<{ exitCode: number; stdout: string; stderr?: string }> {
  try {
    const result = await execFile(executable, args, { windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8", timeout: Math.max(250, Math.min(120_000, timeoutMs)), ...(env ? { env } : {}) });
    return { exitCode: 0, stdout: result.stdout };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };
    if (typeof value.code === "number") return { exitCode: value.code, stdout: value.stdout ?? "", stderr: value.stderr };
    throw new Error("ai_memory_command_failed");
  }
}

function parseVersion(output: string): string | undefined {
  return output.match(/\bai-memory\s+(\d+\.\d+\.\d+)\b/i)?.[1];
}

function sanitizedRuntimeEnvironment(base: Record<string, string | undefined>): Record<string, string> {
  const secret = /(?:API[_-]?KEY|(?:^|[_-])(?:ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|AUTH[_-]?TOKEN|SESSION[_-]?TOKEN|TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS?|DATABASE_URL)(?:$|[_-]))/i;
  return Object.fromEntries(Object.entries(base).filter(([key, value]) => value !== undefined && !secret.test(key))) as Record<string, string>;
}

export function buildAiMemoryExtractionCommand(): string {
  return "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:TYRANT_AI_MEMORY_ARCHIVE, $env:TYRANT_AI_MEMORY_EXTRACT_TO); $files = @(Get-ChildItem -LiteralPath $env:TYRANT_AI_MEMORY_EXTRACT_TO -Recurse -File -Filter 'ai-memory.exe'); if ($files.Count -ne 1) { exit 21 }; Copy-Item -LiteralPath $files[0].FullName -Destination $env:TYRANT_AI_MEMORY_OUTPUT -Force";
}

async function verifyManagedAiMemoryRuntime(directory: string): Promise<string | undefined> {
  const executable = join(directory, "ai-memory.exe");
  const metadataPath = join(directory, "runtime.json");
  try {
    const [executableInfo, metadataInfo, executableBytes, metadataBytes] = await Promise.all([
      lstat(executable), lstat(metadataPath), readFile(executable), readFile(metadataPath, "utf8"),
    ]);
    if (!executableInfo.isFile() || executableInfo.isSymbolicLink() || !metadataInfo.isFile() || metadataInfo.isSymbolicLink()) {
      throw new Error("ai_memory_managed_state_conflict");
    }
    const metadata = JSON.parse(metadataBytes) as Record<string, unknown>;
    if (metadata.version !== AI_MEMORY_PINNED_VERSION
      || metadata.archive_sha256 !== AI_MEMORY_ARCHIVE_SHA256
      || metadata.executable_sha256 !== createHash("sha256").update(executableBytes).digest("hex")) {
      throw new Error("ai_memory_managed_state_conflict");
    }
    return executable;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof Error && error.message === "ai_memory_managed_state_conflict") throw error;
    throw new Error("ai_memory_managed_state_conflict");
  }
}

export async function installPinnedAiMemoryRuntime(
  stateDirectory: string,
  options: { platform?: NodeJS.Platform; arch?: string; fetcher?: AiMemoryRuntimeDependencies["fetcher"]; runCommand?: AiMemoryRuntimeDependencies["runCommand"] } = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "win32" || arch !== "x64") throw new Error("ai_memory_provision_platform_unsupported");
  const normalizedState = resolve(stateDirectory);
  const runtimeRoot = join(normalizedState, "runtimes", "ai-memory");
  const destination = managedAiMemoryDirectory(normalizedState);
  const managedExecutable = await verifyManagedAiMemoryRuntime(destination);
  if (managedExecutable) return managedExecutable;
  if (existsSync(destination)) throw new Error("ai_memory_managed_state_conflict");
  await mkdir(runtimeRoot, { recursive: true });
  const staging = await mkdtemp(join(runtimeRoot, `.install-${randomUUID()}-`));
  try {
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(AI_MEMORY_ARCHIVE_URL, { signal: AbortSignal.timeout(60_000), redirect: "follow" });
    } catch {
      throw new Error("ai_memory_download_failed");
    }
    if (!response.ok) throw new Error("ai_memory_download_failed");
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > AI_MEMORY_MAX_ARCHIVE_BYTES) throw new Error("ai_memory_archive_too_large");
    const archive = new Uint8Array(await response.arrayBuffer());
    if (archive.length > AI_MEMORY_MAX_ARCHIVE_BYTES) throw new Error("ai_memory_archive_too_large");
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    if (archiveSha256 !== AI_MEMORY_ARCHIVE_SHA256) throw new Error("ai_memory_checksum_mismatch");

    const archivePath = join(staging, "ai-memory.zip");
    const extractionPath = join(staging, "unpacked");
    const readyPath = join(staging, "ready");
    const stagedExecutable = join(readyPath, "ai-memory.exe");
    await writeFile(archivePath, archive, { flag: "wx" });
    await mkdir(extractionPath);
    await mkdir(readyPath);
    const extractEnv = {
      ...sanitizedRuntimeEnvironment(process.env),
      TYRANT_AI_MEMORY_ARCHIVE: archivePath,
      TYRANT_AI_MEMORY_EXTRACT_TO: extractionPath,
      TYRANT_AI_MEMORY_OUTPUT: stagedExecutable,
    };
    const extracted = await (options.runCommand ?? defaultRunCommand)("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", buildAiMemoryExtractionCommand(),
    ], extractEnv, 60_000);
    if (extracted.exitCode !== 0 || !existsSync(stagedExecutable)) throw new Error("ai_memory_extract_failed");
    const stagedInfo = await lstat(stagedExecutable);
    if (!stagedInfo.isFile() || stagedInfo.isSymbolicLink() || stagedInfo.size < 1024 || stagedInfo.size > 128 * 1024 * 1024) {
      throw new Error("ai_memory_binary_invalid");
    }
    const executableBytes = await readFile(stagedExecutable);
    const metadata = {
      version: AI_MEMORY_PINNED_VERSION,
      archive_sha256: AI_MEMORY_ARCHIVE_SHA256,
      executable_sha256: createHash("sha256").update(executableBytes).digest("hex"),
    };
    await writeFile(join(readyPath, "runtime.json"), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    try {
      await rename(readyPath, destination);
    } catch (error) {
      const concurrent = await verifyManagedAiMemoryRuntime(destination);
      if (concurrent) return concurrent;
      if ((error as NodeJS.ErrnoException).code === "EEXIST" || existsSync(destination)) throw new Error("ai_memory_managed_state_conflict");
      throw new Error("ai_memory_install_failed");
    }
    return join(destination, "ai-memory.exe");
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function defaultStartServer(executable: string, args: string[]): Promise<number> {
  return await new Promise<number>((resolveStart, rejectStart) => {
    const child = spawnProcess(executable, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => rejectStart(new Error("ai_memory_server_start_failed")));
    child.once("spawn", () => {
      if (!child.pid) {
        rejectStart(new Error("ai_memory_server_start_failed"));
        return;
      }
      child.unref();
      resolveStart(child.pid);
    });
  });
}

async function allocatePort(host: string): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", () => rejectPort(new Error("ai_memory_port_unavailable")));
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("ai_memory_port_unavailable"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? rejectPort(new Error("ai_memory_port_unavailable")) : resolvePort(port));
    });
  });
}

async function endpointReachable(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolveResult, rejectResult) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectResult(new Error("ai_memory_endpoint_owner_unverified"));
    }, 750);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveResult(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED" || error.code === "EHOSTUNREACH") resolveResult(false);
      else rejectResult(new Error("ai_memory_endpoint_owner_unverified"));
    });
  });
}

async function defaultInspectEndpointOwner(
  config: AiMemoryProfileConfig,
  expectedProcessId?: number,
): Promise<"owned" | "absent" | "foreign"> {
  if (!await endpointReachable(config.bindHost, config.port)) return "absent";
  const env = {
    TYRANT_AI_MEMORY_PORT: String(config.port),
    TYRANT_AI_MEMORY_DATA_DIR: config.dataDirectory,
    TYRANT_AI_MEMORY_CONFIG: config.configPath,
    TYRANT_AI_MEMORY_EXPECTED_PID: expectedProcessId === undefined ? "" : String(expectedProcessId),
  };
  const runCommand = defaultRunCommand;
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$connections=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:TYRANT_AI_MEMORY_PORT) -ErrorAction Stop)",
      "$owners=@($connections | Select-Object -ExpandProperty OwningProcess -Unique)",
      "if($owners.Count -ne 1){'foreign';exit 0}",
      "if($env:TYRANT_AI_MEMORY_EXPECTED_PID -and [string]$owners[0] -ne $env:TYRANT_AI_MEMORY_EXPECTED_PID){'foreign';exit 0}",
      "$process=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[string]$owners[0])",
      "if(!$process -or $process.Name -ne 'ai-memory.exe'){'foreign';exit 0}",
      "$command=[string]$process.CommandLine",
      "if($command.Contains('--data-dir') -and $command.Contains($env:TYRANT_AI_MEMORY_DATA_DIR) -and $command.Contains('--config') -and $command.Contains($env:TYRANT_AI_MEMORY_CONFIG) -and $command.Contains($env:TYRANT_AI_MEMORY_PORT)){'owned'}else{'foreign'}",
    ].join("; ");
    const result = await runCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], env);
    if (result.exitCode !== 0) throw new Error("ai_memory_endpoint_owner_unverified");
    const outcome = result.stdout.trim().toLocaleLowerCase("en-US");
    if (outcome === "owned" || outcome === "foreign") return outcome;
    throw new Error("ai_memory_endpoint_owner_unverified");
  }

  const listener = await runCommand("lsof", ["-t", "-nP", `-iTCP:${config.port}`, "-sTCP:LISTEN"]);
  if (listener.exitCode !== 0) throw new Error("ai_memory_endpoint_owner_unverified");
  const pids = [...new Set(listener.stdout.split(/\s+/).map((part) => Number(part)).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (pids.length !== 1 || (expectedProcessId !== undefined && pids[0] !== expectedProcessId)) return "foreign";
  const processInfo = await runCommand("ps", ["-p", String(pids[0]), "-o", "command="]);
  if (processInfo.exitCode !== 0) return "foreign";
  const command = processInfo.stdout;
  return command.includes("ai-memory") && command.includes("--data-dir") && command.includes(config.dataDirectory)
    && command.includes("--config") && command.includes(config.configPath) && command.includes(String(config.port))
    ? "owned"
    : "foreign";
}

export async function inspectAiMemoryEndpointOwner(
  config: AiMemoryProfileConfig,
  expectedProcessId?: number,
): Promise<"owned" | "absent" | "foreign"> {
  return await defaultInspectEndpointOwner(config, expectedProcessId);
}

async function defaultProbe(config: AiMemoryProfileConfig, profile: VaultProfile, allowIdentityCreate: boolean): Promise<AiMemoryIdentity> {
  const transport = new StreamableHTTPClientTransport(new URL(config.endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${config.authToken}` }, redirect: "error" },
  });
  const client = new Client({ name: "tyrant-setup", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: 3_000 });
    const server = client.getServerVersion();
    const serverName = safeText(server?.name) ?? "";
    const version = safeText(server?.version) ?? "";
    if (!serverName.toLocaleLowerCase("en-US").includes("ai-memory")) throw new Error("ai_memory_server_identity_mismatch");
    const { tools } = await client.listTools();
    const available = new Set(tools.map((tool) => tool.name));
    if (REQUIRED_AI_MEMORY_TOOLS.some((name) => !available.has(name))) throw new Error("ai_memory_server_identity_mismatch");
    if (version !== AI_MEMORY_PINNED_VERSION) throw new Error("ai_memory_server_version_mismatch");
    const vaultHash = hashVaultPath(config.dataDirectory);
    const marker = aiMemoryProfileIdentityMarker(profile);
    const expectedBody = marker.body;
    let markerBody: string | undefined;
    try {
      const result = await client.callTool({ name: "memory_read_page", arguments: { path: marker.path, scope: "global", max_chars: 2_000 } }, { timeout: 3_000 });
      if (result.isError) {
        const payload = toolPayload(result);
        const errorCode = safeText(payload.errorCode) ?? safeText(objectValue(payload.error)?.code) ?? "";
        if (!/not.?found|missing.page|rpc_n32602/i.test(errorCode)) throw new Error("ai_memory_identity_read_failed");
      } else {
        markerBody = safeText(toolPayload(result).body);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("ai_memory_")) throw error;
      const message = error instanceof Error ? error.message : "";
      // A clean ai-memory vault has no `_global` scope until its first global write.
      // The same not-found response also covers a missing identity page in an existing scope.
      if (/not found/i.test(message)) {
        if (allowIdentityCreate) markerBody = undefined;
        else throw new Error("ai_memory_identity_mismatch");
      } else throw new Error("ai_memory_identity_read_failed");
    }
    if (!markerBody && allowIdentityCreate) {
      try {
        try {
          const created = await client.callTool({ name: "memory_write_page", arguments: {
          path: marker.path, body: expectedBody, scope: "global", create_only: true,
          } }, { timeout: 3_000 });
          if (created.isError && !/precondition|already.exists|conflict/i.test(JSON.stringify(toolPayload(created)))) {
            throw new Error("ai_memory_identity_write_failed");
          }
        } catch (error) {
          if (error instanceof Error && /precondition failed.*expected no page/i.test(error.message)) {
            // Another setup created the page after the read; read-back below still verifies ownership.
          } else {
            throw error;
          }
        }
        const readBack = await client.callTool({ name: "memory_read_page", arguments: { path: marker.path, scope: "global", max_chars: 2_000 } }, { timeout: 3_000 });
        if (readBack.isError) throw new Error("ai_memory_identity_read_failed");
        markerBody = safeText(toolPayload(readBack).body);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("ai_memory_")) throw error;
        throw new Error("ai_memory_identity_write_failed");
      }
    }
    if (markerBody !== expectedBody) throw new Error("ai_memory_identity_mismatch");
    return { serverName, version, profileId: profile.id, vaultHash };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ai_memory_")) throw error;
    if (/401|403|unauthorized|forbidden/i.test(error instanceof Error ? error.message : "")) throw new Error("ai_memory_auth_failed");
    throw new Error("ai_memory_endpoint_unreachable");
  } finally {
    await client.close().catch(() => undefined);
  }
}

function toolPayload(result: { structuredContent?: unknown; content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const structured = objectValue(result.structuredContent);
  if (structured && Object.keys(structured).length > 0) return structured;
  for (const item of result.content) {
    if (item.type !== "text" || typeof item.text !== "string") continue;
    try {
      const parsed = JSON.parse(item.text) as unknown;
      const record = objectValue(parsed);
      if (record) return record;
    } catch {
      return { body: item.text };
    }
  }
  return {};
}

function hashVaultPath(path: string): string {
  const canonical = realpathSync(path);
  const normalized = process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
  return createHash("sha256").update(normalized).digest("hex");
}

export function aiMemoryProfileIdentityMarker(profile: VaultProfile): { path: string; body: string } {
  const vaultHash = hashVaultPath(profile.vaultPath);
  return {
    path: `${IDENTITY_PAGE_PREFIX}${profile.id}.md`,
    body: `# Tyrant vault identity\n\nprofile_id: ${profile.id}\nvault_sha256: ${vaultHash}`,
  };
}

function validateIdentity(identity: AiMemoryIdentity, profile: VaultProfile, config: AiMemoryProfileConfig): void {
  if (!identity.serverName.toLocaleLowerCase("en-US").includes("ai-memory")
    || identity.version !== AI_MEMORY_PINNED_VERSION) throw new Error("ai_memory_server_version_mismatch");
  if (identity.profileId !== profile.id || identity.vaultHash !== hashVaultPath(config.dataDirectory)) {
    throw new Error("ai_memory_identity_mismatch");
  }
}

function endpointAtPort(endpoint: string, port: number): string {
  const url = new URL(endpoint);
  url.port = String(port);
  return url.toString().replace(/\/$/, "");
}

function isUnreachable(error: unknown): boolean {
  return error instanceof Error && error.message === "ai_memory_endpoint_unreachable";
}

export async function ensureAiMemoryProfile(
  profile: VaultProfile,
  dependencies: AiMemoryRuntimeDependencies = {},
): Promise<AiMemoryRuntimeResult> {
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const stateDirectory = dependencies.stateDirectory?.trim()
    ? resolve(dependencies.stateDirectory)
    : getTyrantUserDirectory(dependencies.env ?? process.env, platform);
  const selected = resolveExecutable(dependencies);
  const executableIsExplicit = Boolean(selected.explicit);
  let executable = selected.explicit ?? selected.system;
  const installRuntime = dependencies.installRuntime
    ?? ((directory, selectedPlatform, selectedArch) => installPinnedAiMemoryRuntime(directory, {
      platform: selectedPlatform, arch: selectedArch, fetcher: dependencies.fetcher, runCommand,
    }));
  if (!executable) executable = await installRuntime(stateDirectory, platform, arch);

  let runVersion = await runCommand(executable, ["--version"], undefined, 5_000);
  let version = runVersion.exitCode === 0 ? parseVersion(runVersion.stdout) : undefined;
  if (version !== AI_MEMORY_PINNED_VERSION && !executableIsExplicit && selected.system) {
    executable = await installRuntime(stateDirectory, platform, arch);
    runVersion = await runCommand(executable, ["--version"], undefined, 5_000);
    version = runVersion.exitCode === 0 ? parseVersion(runVersion.stdout) : undefined;
  }
  if (runVersion.exitCode !== 0) throw new Error("ai_memory_version_check_failed");
  if (!version) throw new Error("ai_memory_version_unavailable");
  if (version !== AI_MEMORY_PINNED_VERSION) throw new Error("ai_memory_version_mismatch");

  let config: AiMemoryProfileConfig;
  try {
    config = readAiMemoryProfileConfig(profile);
  } catch (error) {
    if (!(dependencies.initialize && error instanceof Error && error.message === "ai_memory_config_missing")) throw error;
    const initialized = await runCommand(executable, ["init", "--data-dir", profile.vaultPath, "--config", profile.configPath], undefined, 60_000);
    if (initialized.exitCode !== 0) throw new Error("ai_memory_init_failed");
    config = readAiMemoryProfileConfig(profile);
  }

  let actualProfile = profile;
  if (config.port === 0) {
    const port = await (dependencies.allocatePort ?? allocatePort)(config.bindHost);
    actualProfile = { ...profile, endpoint: endpointAtPort(config.endpoint, port) };
    config = readAiMemoryProfileConfig(actualProfile);
  }
  const probe = dependencies.probe ?? defaultProbe;
  const startServer = dependencies.startServer ?? defaultStartServer;
  const inspectOwner = dependencies.inspectEndpointOwner ?? defaultInspectEndpointOwner;
  const wait = dependencies.wait ?? ((milliseconds: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const existingOwner = await inspectOwner(config);
  if (existingOwner === "foreign") throw new Error("ai_memory_endpoint_owner_mismatch");
  if (existingOwner === "owned") {
    const existing = await probe(config, actualProfile, false);
    validateIdentity(existing, actualProfile, config);
    return { endpoint: config.endpoint, authStatus: "ready", version };
  }

  const args = [
    "serve", "--transport", "http", "--bind", `${config.bindHost}:${config.port}`,
    "--data-dir", config.dataDirectory, "--config", config.configPath,
  ];
  const processId = await startServer(executable, args);
  const retries = Math.max(1, Math.min(60, dependencies.retries ?? DEFAULT_STARTUP_RETRIES));
  const delay = Math.max(25, Math.min(2_000, dependencies.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS));
  for (let attempt = 0; attempt < retries; attempt += 1) {
    await wait(delay);
    const owner = await inspectOwner(config, processId);
    if (owner === "foreign") throw new Error("ai_memory_endpoint_owner_mismatch");
    if (owner === "absent") continue;
    try {
      const identity = await probe(config, actualProfile, true);
      validateIdentity(identity, actualProfile, config);
      return { endpoint: config.endpoint, authStatus: "ready", version };
    } catch (error) {
      if (!isUnreachable(error)) throw error;
    }
  }
  throw new Error("ai_memory_server_unavailable");
}
