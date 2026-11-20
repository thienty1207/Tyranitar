#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDefaultVaultProfile,
  loadProfileRegistry,
  prepareVaultProfileIdentity,
  resolveProjectProfile,
  resolveVaultProfile,
  activateVaultProfile,
  bindProjectProfile,
  resolveVaultPath,
  deriveProjectProfileScope,
  readConfiguredProjectScope,
  type VaultProfile,
  type ProfileStoreOptions,
} from "./setup/profiles";
import { ensureAiMemoryProfile, readAiMemoryProfileConfig } from "./setup/ai-memory-runtime";
import { ensureGraphifyRuntime, graphifyRuntimeStatus, type GraphifyRuntimeStatus } from "./setup/graphify-runtime";
import { ensureDshPlugin, type DshPluginResult } from "./setup/dsh-runtime";
import {
  getProjectAdapterStatus,
  installProjectAdapters,
  previewProjectAdapters,
  type ProjectAdapterHost,
  type ProjectAdapterSetupOptions,
} from "./adapters/project-setup";

const DEFAULT_HOSTS: ProjectAdapterHost[] = ["codex", "claude-code", "opencode", "dsh", "claude-desktop"];
const HOSTS = new Set<ProjectAdapterHost>(DEFAULT_HOSTS);
const PROJECT_AGENT_START = "<!-- BEGIN TYRANT ENGINE PROJECT GUIDANCE -->";
const PROJECT_AGENT_END = "<!-- END TYRANT ENGINE PROJECT GUIDANCE -->";

export type TyrantCliDependencies = {
  cwd?: string;
  tyrantRoot?: string;
  stateDirectory?: string;
  env?: Record<string, string | undefined>;
  ensureAiMemory?: typeof ensureAiMemoryProfile;
  ensureGraphify?: typeof ensureGraphifyRuntime;
  ensureDshPlugin?: typeof ensureDshPlugin;
  graphifyStatus?: typeof graphifyRuntimeStatus;
  previewAdapters?: typeof previewProjectAdapters;
  installAdapters?: typeof installProjectAdapters;
  adapterStatus?: typeof getProjectAdapterStatus;
  write?: (stream: "stdout" | "stderr", value: string) => void;
};

type ParsedArgs = { positionals: string[]; flags: Map<string, string> };

function stateOptions(dependencies: TyrantCliDependencies): ProfileStoreOptions {
  return { stateDirectory: dependencies.stateDirectory, env: dependencies.env };
}

function output(dependencies: TyrantCliDependencies, stream: "stdout" | "stderr", value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (dependencies.write) dependencies.write(stream, text);
  else (stream === "stdout" ? process.stdout : process.stderr).write(text);
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "operation_failed";
  const message = error.message.trim();
  return /^[a-z0-9_]{1,100}$/i.test(message) ? message : "operation_failed";
}

function parseArgs(args: string[], allowedFlags: Set<string>): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!allowedFlags.has(value) || flags.has(value) || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error("invalid_arguments");
    }
    flags.set(value, args[index + 1]);
    index += 1;
  }
  return { positionals, flags };
}

function profileSummary(profile: VaultProfile | undefined | null) {
  if (!profile) return null;
  return { id: profile.id, name: profile.name, vault_path: profile.vaultPath, endpoint: profile.endpoint };
}

function projectGuidance(profile: VaultProfile, scope: { workspace: string; project: string }) {
  return {
    profileId: profile.id,
    profileName: profile.name,
    workspace: scope.workspace,
    project: scope.project,
  };
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function setupVault(parsed: ParsedArgs, dependencies: TyrantCliDependencies): Promise<number> {
  if (parsed.positionals.length > 1) throw new Error("setup_accepts_one_vault_path");
  const env = dependencies.env ?? process.env;
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const selectedPath = resolveVaultPath(parsed.positionals[0], cwd, process.platform);
  await mkdir(selectedPath, { recursive: true });
  const candidate = await prepareVaultProfileIdentity({ vaultPath: selectedPath, name: parsed.flags.get("--name") }, stateOptions(dependencies));
  const existing = candidate.existingProfile;
  const now = new Date().toISOString();
  const draft: VaultProfile = {
    id: candidate.id,
    name: candidate.name,
    vaultPath: candidate.vaultPath,
    endpoint: existing?.endpoint ?? "http://127.0.0.1:0/mcp",
    configPath: existing?.configPath ?? join(candidate.vaultPath, "config.toml"),
    ...(existing?.tokenFile ? { tokenFile: existing.tokenFile } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const graphify = await (dependencies.ensureGraphify ?? ensureGraphifyRuntime)({ stateDirectory: dependencies.stateDirectory, env });
  if (graphify.status !== "ready" || graphify.version !== "0.9.109") throw new Error("graphify_setup_unverified");
  const memory = await (dependencies.ensureAiMemory ?? ensureAiMemoryProfile)(draft, {
    initialize: true, stateDirectory: dependencies.stateDirectory, env,
  });
  if (memory.authStatus !== "ready" || memory.version !== "3.4.7") throw new Error("ai_memory_setup_unverified");
  const dshPlugin = await (dependencies.ensureDshPlugin ?? ensureDshPlugin)({
    tyrantRoot: resolve(dependencies.tyrantRoot ?? packageRoot()),
    profile: parsed.flags.get("--dsh-profile"),
    env,
  });
  const profile = await activateVaultProfile({
    id: candidate.id,
    name: candidate.name,
    vaultPath: candidate.vaultPath,
    endpoint: memory.endpoint,
    configPath: draft.configPath,
    ...(existing?.tokenFile ? { tokenFile: existing.tokenFile } : {}),
  }, stateOptions(dependencies));
  output(dependencies, "stdout", {
    status: "ready",
    active_default: profileSummary(profile),
    ai_memory: { status: "ready", version: memory.version, authentication: "configured_from_ai_memory_config" },
    graphify: { status: "ready", version: graphify.version, source: graphify.source },
    dsh_plugin: dshPlugin,
    note: "The active default applies to future project initialization; existing project bindings are unchanged.",
  });
  return 0;
}

async function selectProjectProfile(
  projectRoot: string,
  selector: string | undefined,
  dependencies: TyrantCliDependencies,
): Promise<{ profile: VaultProfile; explicit: boolean; existingBinding?: Awaited<ReturnType<typeof resolveProjectProfile>> }> {
  const storeOptions = stateOptions(dependencies);
  let existingBinding: Awaited<ReturnType<typeof resolveProjectProfile>>;
  try {
    existingBinding = await resolveProjectProfile(projectRoot, storeOptions);
  } catch (error) {
    if (!selector || !(error instanceof Error) || error.message !== "project_binding_root_mismatch") throw error;
    existingBinding = undefined;
  }
  if (selector) {
    const registry = await loadProfileRegistry(storeOptions);
    return { profile: resolveVaultProfile(registry, selector), explicit: true, existingBinding };
  }
  if (existingBinding) return { profile: existingBinding.profile, explicit: false, existingBinding };
  const registry = await loadProfileRegistry(storeOptions);
  return { profile: getDefaultVaultProfile(registry), explicit: false };
}

function parseHosts(value: string | undefined): ProjectAdapterHost[] {
  if (!value) return [...DEFAULT_HOSTS];
  const parsed = value.split(",").map((host) => host.trim()).filter(Boolean) as ProjectAdapterHost[];
  if (!parsed.length || parsed.some((host) => !HOSTS.has(host))) throw new Error("hosts_must_be_supported_host_ids");
  return [...new Set(parsed)];
}

async function initProject(parsed: ParsedArgs, dependencies: TyrantCliDependencies): Promise<number> {
  if (parsed.positionals.length) throw new Error("init_accepts_flags_only");
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const { profile, explicit, existingBinding } = await selectProjectProfile(cwd, parsed.flags.get("--vault"), dependencies);
  const hosts = parseHosts(parsed.flags.get("--hosts"));
  const scopeIdentity = await deriveProjectProfileScope(cwd, profile, stateOptions(dependencies));
  const configuredScope = readConfiguredProjectScope(cwd);
  const scope = existingBinding && !explicit
    ? existingBinding.binding.scope
    : configuredScope ?? scopeIdentity.scope;
  const scopeSource = existingBinding && !explicit
    ? existingBinding.binding.scopeSource ?? "tyrant"
    : configuredScope ? "ai-memory-config" : "tyrant";
  const adapters: ProjectAdapterSetupOptions = {
    projectRoot: cwd,
    tyrantRoot: resolve(dependencies.tyrantRoot ?? packageRoot()),
    hosts,
    profileGuidance: projectGuidance(profile, scope),
  };
  const preview = await (dependencies.previewAdapters ?? previewProjectAdapters)(adapters);
  if (preview.status !== "ready") throw new Error("project_adapter_preview_conflict");

  const graphify = await (dependencies.ensureGraphify ?? ensureGraphifyRuntime)({ stateDirectory: dependencies.stateDirectory, env: dependencies.env ?? process.env });
  if (graphify.status !== "ready" || graphify.version !== "0.9.109") throw new Error("graphify_not_ready");
  const memory = await (dependencies.ensureAiMemory ?? ensureAiMemoryProfile)(profile, {
    stateDirectory: dependencies.stateDirectory, env: dependencies.env,
  });
  if (memory.authStatus !== "ready" || memory.version !== "3.4.7") throw new Error("ai_memory_not_ready");

  const dshPlugin: DshPluginResult | undefined = hosts.includes("dsh")
    ? await (dependencies.ensureDshPlugin ?? ensureDshPlugin)({
      tyrantRoot: adapters.tyrantRoot,
      profile: parsed.flags.get("--dsh-profile"),
      env: dependencies.env ?? process.env,
    })
    : undefined;
  const installation = await (dependencies.installAdapters ?? installProjectAdapters)({
    ...adapters,
    ...(dshPlugin ? { dshPluginStatus: dshPlugin.status } : {}),
  });
  if (installation.status === "conflict") throw new Error("project_adapter_install_conflict");
  const binding = await bindProjectProfile({ projectRoot: cwd, profile, explicitRebind: explicit, scope, scopeSource }, stateOptions(dependencies));
  const boundProfile = profile;
  output(dependencies, "stdout", {
    status: installation.status === "manual_action_required" ? "manual_action_required" : "ready",
    binding: { profile_id: binding.profileId, profile_name: boundProfile.name, project_id: binding.projectId, scope: binding.scope },
    ai_memory: { status: "ready", version: memory.version, authentication: "verified" },
    graphify: { status: "ready", version: graphify.version, source: graphify.source },
    adapters: {
      ...installation,
      ...(dshPlugin ? { hosts: { ...installation.hosts, dsh: dshPlugin.status === "not_detected" ? "not_detected" : "profile_plugin_managed" } } : {}),
    },
    ...(dshPlugin ? { dsh_plugin: dshPlugin } : {}),
    ...(preview.manual_actions.length ? { manual_actions: preview.manual_actions } : {}),
  });
  return 0;
}

async function currentProfiles(projectRoot: string, dependencies: TyrantCliDependencies) {
  const storeOptions = stateOptions(dependencies);
  const registry = await loadProfileRegistry(storeOptions);
  const activeDefault = registry.defaultProfileId
    ? registry.profiles.find((profile) => profile.id === registry.defaultProfileId) ?? null
    : null;
  let currentBinding: Awaited<ReturnType<typeof resolveProjectProfile>>;
  let bindingError: string | undefined;
  try {
    currentBinding = await resolveProjectProfile(projectRoot, storeOptions);
  } catch (error) {
    currentBinding = undefined;
    bindingError = safeError(error);
  }
  return { registry, activeDefault, currentBinding, bindingError, selected: bindingError ? null : currentBinding?.profile ?? activeDefault };
}

async function statusCommand(dependencies: TyrantCliDependencies, doctor: boolean): Promise<number> {
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const selection = await currentProfiles(cwd, dependencies);
  const profile = selection.selected;
  let memoryStatus: Record<string, unknown> = profile
    ? { status: "unverified", authentication: "unknown" }
    : { status: "unavailable", error: selection.bindingError ?? (selection.registry.defaultProfileId ? "profile_not_found" : "profile_default_missing") };
  if (profile) {
    if (doctor) {
      try {
        const result = await (dependencies.ensureAiMemory ?? ensureAiMemoryProfile)(profile, {
          stateDirectory: dependencies.stateDirectory, env: dependencies.env,
        });
        memoryStatus = { status: "ready", authentication: result.authStatus, version: result.version, endpoint: result.endpoint };
      } catch (error) {
        memoryStatus = { status: "unavailable", error: safeError(error) };
      }
    } else {
      try {
        const configured = readAiMemoryProfileConfig(profile);
        memoryStatus = { status: "configured", authentication: "token_file_readable", endpoint: configured.endpoint };
      } catch (error) {
        memoryStatus = { status: "unavailable", error: safeError(error) };
      }
    }
  }
  let graphify: GraphifyRuntimeStatus;
  try {
    graphify = await (dependencies.graphifyStatus ?? graphifyRuntimeStatus)({ stateDirectory: dependencies.stateDirectory, env: dependencies.env ?? process.env });
  } catch (error) {
    graphify = { status: "missing" };
  }
  let adapters: unknown;
  try {
    adapters = await (dependencies.adapterStatus ?? getProjectAdapterStatus)({ projectRoot: cwd });
  } catch (error) {
    adapters = { status: "conflict", error: safeError(error) };
  }
  const graphifyReport = {
    ...graphify,
    map_status: existsSync(join(cwd, "graphify-out", "graph.json")) ? "present_unverified" : "missing",
    freshness: "verified_during_tyrant_prepare_task",
  };
  const report = {
    status: doctor ? "diagnosed" : "status",
    active_default: profileSummary(selection.activeDefault),
    current_project_binding: selection.bindingError
      ? { status: "blocked", error: selection.bindingError }
      : selection.currentBinding
        ? { status: "bound", profile_id: selection.currentBinding.binding.profileId, profile_name: selection.currentBinding.profile.name, project_id: selection.currentBinding.binding.projectId, scope: selection.currentBinding.binding.scope }
        : { status: "not_initialized" },
    selected_profile: profileSummary(profile),
    ai_memory: memoryStatus,
    graphify: graphifyReport,
    adapters,
  };
  output(dependencies, "stdout", report);
  if (!doctor) return 0;
  const memoryReady = memoryStatus.status === "ready";
  const graphifyReady = graphify.status === "ready" && graphify.version === "0.9.109";
  return memoryReady && graphifyReady ? 0 : 1;
}

export async function runTyrantCli(args = process.argv.slice(2), dependencies: TyrantCliDependencies = {}): Promise<number> {
  try {
    const [operation, ...rest] = args;
    if (!operation) {
      await import("./index");
      return 0;
    }
    if (["--help", "-h", "help"].includes(operation)) {
      output(dependencies, "stdout", { usage: [
        "tyrant setup [<vault-path>] [--name <profile-label>] [--dsh-profile <name>]",
        "tyrant init [--vault <profile-label-or-id>] [--hosts <list>] [--dsh-profile <name>]",
        "tyrant status",
        "tyrant doctor",
      ] });
      return 0;
    }
    const allowed = operation === "setup" ? new Set(["--name", "--dsh-profile"])
      : operation === "init" ? new Set(["--vault", "--hosts", "--dsh-profile"])
        : new Set<string>();
    const parsed = parseArgs(rest, allowed);
    if (operation === "setup") return await setupVault(parsed, dependencies);
    if (operation === "init") return await initProject(parsed, dependencies);
    if (operation === "status") return await statusCommand(dependencies, false);
    if (operation === "doctor") return await statusCommand(dependencies, true);
    throw new Error("unknown_command");
  } catch (error) {
    output(dependencies, "stderr", { status: "blocked", error: safeError(error) });
    return 2;
  }
}

if (import.meta.main) process.exitCode = await runTyrantCli();
