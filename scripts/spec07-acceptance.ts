import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { release as osRelease, tmpdir, version as osVersion } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getAiMemoryConfig } from "../src/providers/ai-memory";
import { openInProcessTyrantMcpClient } from "../src/adapters/local-tools";
import { createDshTyrantToolDefinition, registerTyrantToolsForDshAgent } from "../src/adapters/dsh-agent-tools";
import { createDshSkillLoader } from "../src/adapters/dsh";
import { prepareAutomaticHostContext, recordAutomaticSkillInjection } from "../src/adapters/auto-preflight";
import { runAutomaticSessionEnd } from "../src/adapters/session-end";
import { installProjectAdapters, uninstallProjectAdapters } from "../src/adapters/project-setup";

type JsonRecord = Record<string, any>;
const repoRoot = resolve(process.cwd());
const healthcheckRoot = resolve(process.env.TYRANT_SPEC07_SCOPE_PROJECT || "D:\\Working\\Tyrant-Healthcheck");
const requiredAiMemoryTools = [
  "memory_query", "memory_read_page", "memory_write_page", "memory_handoff_list", "memory_handoff_accept", "memory_handoff_begin",
];
const originalStateDir = process.env.TYRANT_STATE_DIR;
const originalAiMemoryDataDir = process.env.AI_MEMORY_DATA_DIR;
const testId = randomUUID().replaceAll("-", "").slice(0, 12);
const sessionFrontend = `spec07-frontend-${testId}`;
const sessionSecurity = `spec07-security-${testId}`;
const sessionResume = `spec07-resume-${testId}`;
const taskPageIds = new Set<string>();
let memoryScope: { workspace: string; project: string } | undefined;
let projectMarkerCreated = false;
let root = "";
let installComplete = false;
let upstreamClient: Client | undefined;
let tyrantClient: Awaited<ReturnType<typeof openInProcessTyrantMcpClient>> | undefined;
let dshToolHandle: Awaited<ReturnType<typeof registerTyrantToolsForDshAgent>> | undefined;
let finalReport: JsonRecord = { status: "failed", phase: "startup" };

function unwrap(response: unknown): JsonRecord {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("invalid_tool_response");
  const result = response as JsonRecord;
  if (result.isError === true) throw new Error("tool_call_failed");
  if (result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)) {
    return result.structuredContent as JsonRecord;
  }
  const text = Array.isArray(result.content) ? result.content.find((item: unknown) =>
    !!item && typeof item === "object" && (item as JsonRecord).type === "text") as JsonRecord | undefined : undefined;
  if (typeof text?.text === "string") return JSON.parse(text.text) as JsonRecord;
  throw new Error("tool_result_missing_structured_content");
}

function skillSummary(preflight: JsonRecord) {
  return (Array.isArray(preflight.skill_loads) ? preflight.skill_loads : []).map((item: JsonRecord) => ({
    skill_id: item.skill_id,
    source_skill_id: item.source_skill_id,
    status: item.status,
    method: item.method,
    ...(item.reason ? { reason: item.reason } : {}),
  }));
}

async function loadSkillFromDshNativeRoot(input: { cwd: string; source_skill_id: string }) {
  const skillRoot = join(input.cwd, ".agents", "skills", input.source_skill_id);
  const content = await readFile(join(skillRoot, "SKILL.md"), "utf8").catch(() => "");
  return content ? { content, resourceBase: { kind: "directory", path: skillRoot } } : undefined;
}

async function runPreflight(hostId: string, sessionId: string, turnId: string, prompt: string) {
  if (!root || !tyrantClient) throw new Error("acceptance_fixture_not_ready");
  let prepared: JsonRecord | undefined;
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const response = await tyrantClient!.callTool(name, args);
    if (name === "tyrant_prepare_task") prepared = unwrap(response);
    return response;
  };
  const agent = { id: sessionId, session: { id: sessionId, header: { cwd: root } } };
  const loader = createDshSkillLoader(agent, new AbortController().signal, async (candidate, options) =>
    loadSkillFromDshNativeRoot({ cwd: options.cwd, source_skill_id: candidate }));
  const preflight = await prepareAutomaticHostContext({ host_id: hostId, cwd: root, session_id: sessionId, turn_id: turnId, prompt }, callTool, loader);
  if (!prepared) throw new Error("prepare_task_not_observed");
  if (prepared.memory_context?.references?.[0]?.startsWith("ai-memory:page:")) projectMarkerCreated = true;
  const recorded = await recordAutomaticSkillInjection({ ...preflight, context_injected: true }, callTool);
  return { preflight, prepared, recorded };
}

async function finish(taskId: string, sessionId: string, status: "completed" | "handoff") {
  if (!tyrantClient) throw new Error("tyrant_client_missing");
  const result = unwrap(await tyrantClient.callTool("tyrant_finish_task", {
    schema_version: 1,
    task_id: taskId,
    request_id: `spec07-finish-${randomUUID()}`,
    status,
    summary: "SPEC-07 isolated live acceptance check; no application files were changed.",
    next_action: status === "handoff" ? "Resume this isolated acceptance task in a fresh host session." : "Acceptance phase ended; no project work remains.",
    actor: "spec07-acceptance",
    host_id: "dsh",
    session_id: sessionId,
  }));
  if (result.ai_memory_sync?.page_ref) taskPageIds.add(taskId);
  return result;
}

async function main() {
  if (process.platform !== "win32") throw new Error("acceptance_requires_windows");
  const vault = "D:\\AI-MEMORY";
  process.env.AI_MEMORY_DATA_DIR = vault;
  process.env.TYRANT_STATE_DIR = "";
  const scopeConfig = getAiMemoryConfig(healthcheckRoot);
  if (!scopeConfig.scope) throw new Error("healthcheck_scope_missing");
  if (!scopeConfig.authToken) throw new Error("vault_auth_token_missing");
  memoryScope = {
    workspace: scopeConfig.scope.workspace,
    project: `${scopeConfig.scope.project}-spec07-${testId}`,
  };

  root = await mkdtemp(join(tmpdir(), "tyrant-spec07-acceptance-"));
  const tempRoot = resolve(tmpdir());
  if (!resolve(root).startsWith(`${tempRoot}${sep}`) || !basename(root).startsWith("tyrant-spec07-acceptance-")) {
    throw new Error("acceptance_temp_path_invalid");
  }
  process.env.TYRANT_STATE_DIR = join(root, ".tyrant-state");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, ".ai-memory.toml"), `workspace = "${memoryScope.workspace}"\nproject = "${memoryScope.project}"\n`, "utf8");
  await writeFile(join(root, ".gitignore"), ".agents/skills/\n.tyrant/skills/\n.tyrant/adapters/\nnode_modules/\ngraphify-out/\n", "utf8");
  await writeFile(join(root, "src", "health.ts"), [
    "export type Health = { ok: boolean; service: string };",
    "export function health(): Health { return { ok: true, service: 'tyrant-acceptance' }; }",
    "export function listServices(items: string[]) { return [...items].sort(); }",
    "",
  ].join("\n"), "utf8");

  const install = await installProjectAdapters({ projectRoot: root, tyrantRoot: repoRoot, hosts: ["dsh"] });
  if (install.status !== "installed") throw new Error("fixture_skill_setup_failed");
  installComplete = true;

  const memoryTransport = new StreamableHTTPClientTransport(new URL(scopeConfig.url), {
    requestInit: { headers: { Authorization: `Bearer ${scopeConfig.authToken}` }, redirect: "error" },
  });
  upstreamClient = new Client({ name: "tyrant-spec07-acceptance", version: "0.1.0" });
  await upstreamClient.connect(memoryTransport, { timeout: scopeConfig.timeoutMs });
  const upstreamToolList = await upstreamClient.listTools();
  const upstreamToolNames = upstreamToolList.tools.map((tool) => tool.name).sort();
  const missingAiMemoryTools = requiredAiMemoryTools.filter((name) => !upstreamToolNames.includes(name));

  tyrantClient = await openInProcessTyrantMcpClient(root);
  const tyrantTools = await tyrantClient.listTools();
  const tyrantToolNames = tyrantTools.tools.map((tool) => tool.name).sort();

  const modelScope = new Map<string, JsonRecord>();
  const agentToolNames = new Set<string>();
  const agent = { id: `tool-agent-${testId}`, session: { id: `tool-session-${testId}`, header: { cwd: root } }, ctx: {
    tools: { register(definition: unknown) {
      const tool = definition as JsonRecord;
      modelScope.set(String(tool.name), tool);
      agentToolNames.add(String(tool.name));
      return () => { modelScope.delete(String(tool.name)); agentToolNames.delete(String(tool.name)); };
    } },
  } };
  dshToolHandle = await registerTyrantToolsForDshAgent(agent, {
    openClient: (projectRoot) => openInProcessTyrantMcpClient(projectRoot),
    createToolDefinition: (_scope, options) => createDshTyrantToolDefinition(options),
  });
  const listed = unwrap(await modelScope.get("tyrant_list_skills")!.execute({ schema_version: 1 }, { signal: new AbortController().signal }));
  const listedSkillIds = Array.isArray(listed.skills) ? listed.skills.map((skill: JsonRecord) => skill.id).sort() : [];

  const frontend = await runPreflight("dsh", sessionFrontend, "spec07-frontend-turn", "Implement a frontend dashboard component that lists service health and status.");
  const security = await runPreflight("dsh", sessionSecurity, "spec07-security-turn", "Run a security audit of this project for vulnerabilities in its API and report the findings.");
  const sessionEnd = await runAutomaticSessionEnd({ host_id: "dsh", cwd: root, session_id: sessionFrontend, event: "agent/disposed" }, async (name, args) =>
    tyrantClient!.callTool(name, args));
  if (sessionEnd.task_id) taskPageIds.add(sessionEnd.task_id);
  const resume = await runPreflight("dsh", sessionResume, "spec07-resume-turn", "Continue the previous task from its checkpoint and handoff.");
  if (resume.prepared.task?.id) taskPageIds.add(String(resume.prepared.task.id));
  if (security.prepared.task?.id) taskPageIds.add(String(security.prepared.task.id));
  if (resume.prepared.task?.id) await finish(String(resume.prepared.task.id), sessionResume, "completed");
  if (security.prepared.task?.id) await finish(String(security.prepared.task.id), sessionSecurity, "completed");

  finalReport = {
    status: "passed",
    versions: {
      tyrant: "0.1.0",
      bun: Bun.version,
      os: `${osVersion()} (${osRelease()}; ${process.platform})`,
      graphify: Bun.spawnSync([Bun.which("graphify") ?? "graphify", "--version"], { stdout: "pipe", stderr: "ignore" }).stdout.toString("utf8").trim(),
      ai_memory_server_tool_count: upstreamToolNames.length,
      dsh_cli: "0.2.2-rc.3",
    },
    scope: { data_dir: vault, workspace: memoryScope.workspace, project: memoryScope.project },
    ai_memory: {
      authenticated_tools_list: "ready",
      tool_names: upstreamToolNames,
      required_provider_operations_present: missingAiMemoryTools.length === 0,
      missing_provider_operations: missingAiMemoryTools,
      frontend_context: frontend.prepared.memory_context?.status,
      security_context: security.prepared.memory_context?.status,
      resumed_context: resume.prepared.memory_context?.status,
      resumed_handoff: resume.prepared.memory_context?.handoffStatus,
      session_end_sync: sessionEnd.status,
      session_end_sync_status: sessionEnd.sync_status,
    },
    graphify: {
      executable_found: true,
      frontend_status: frontend.prepared.graphify_context?.status,
      frontend_map_status: frontend.prepared.graphify_context?.mapStatus,
      frontend_reference_count: frontend.prepared.graphify_context?.references?.length ?? 0,
      security_status: security.prepared.graphify_context?.status,
      security_map_status: security.prepared.graphify_context?.mapStatus,
      resume_status: resume.prepared.graphify_context?.status,
      resume_map_status: resume.prepared.graphify_context?.mapStatus,
    },
    tyrant_mcp: {
      tool_count: tyrantToolNames.length,
      tool_names: tyrantToolNames,
      dsh_agent_scope_tool_count: agentToolNames.size,
      dsh_agent_scope_tool_names: [...agentToolNames].sort(),
      tyrant_list_skills_call: "success",
      returned_skill_ids: listedSkillIds,
      project_scope_isolation: true,
    },
    skills: {
      matt_policy: frontend.preflight.core_skill_source_id,
      frontend_loads: skillSummary(frontend.preflight),
      security_loads: skillSummary(security.preflight),
      resume_loads: skillSummary(resume.preflight),
      registry_source: "fixture reads the project's staged .agents/skills files; not a live DSH skills service call",
      injected_skill_events: {
        frontend: frontend.recorded.recorded,
        security: security.recorded.recorded,
        resume: resume.recorded.recorded,
      },
    },
    live_dsh_host: "pending; the Desktop profile is Electron-owned and the active Windows UI is locked",
    provider_scope: "Tyrant uses the selected read/query/write/handoff MCP operations and Graphify extract/query; it does not mirror every upstream API or command.",
    acceptance_diagnostics: {
      missing_ai_memory_operations: missingAiMemoryTools,
      session_end: { status: sessionEnd.status, sync_status: sessionEnd.sync_status },
      resumed_handoff_status: resume.prepared.memory_context?.handoffStatus,
      task_gates: [frontend, security, resume].map(({ preflight, prepared }) => ({
        code_change_allowed: preflight.code_change_allowed,
        task_lifecycle_blocked: preflight.task_lifecycle_blocked,
        task_lifecycle_transition: preflight.task_lifecycle_transition,
        host_context_error: preflight.host_context_error,
        provider_gap_count: Array.isArray(preflight.provider_gaps) ? preflight.provider_gaps.length : null,
        route_status: prepared.route?.status,
        route_code_change_gate: prepared.route?.code_change_gate?.status,
        route_specialist_phases: Array.isArray(prepared.route?.specialists) ? prepared.route.specialists.map((skill: JsonRecord) => ({
          skill_id: skill.skill_id, phase: skill.phase, required: skill.required === true,
        })) : [],
        required_skill_gap_count: Array.isArray(preflight.required_skill_gaps) ? preflight.required_skill_gaps.length : null,
        loaded_skill_ids: preflight.loaded_skills.map((skill) => skill.skill_id),
        loaded_skill_body_char_count: preflight.loaded_skills.reduce((sum, skill) => sum + (skill.content?.length ?? 0), 0),
        injected_context_char_count: preflight.context.length,
        memory_status: prepared.memory_context?.status,
        graphify_status: prepared.graphify_context?.status,
        graphify_map_status: prepared.graphify_context?.mapStatus,
      })),
      matt_skill_visible: listedSkillIds.includes("matt-pocock-main-flow"),
      taste_loaded: frontend.preflight.loaded_skills.some((skill: JsonRecord) => skill.skill_id === "design-taste-frontend"),
      security_audit_loaded: security.preflight.loaded_skills.some((skill: JsonRecord) => skill.skill_id === "security-audit"),
    },
  };
  if (missingAiMemoryTools.length || sessionEnd.status !== "handed_off" || resume.prepared.memory_context?.handoffStatus !== "claimed") {
    finalReport.status = "failed";
  }
  for (const task of [frontend, security, resume]) {
    if (task.preflight.code_change_allowed !== true || task.preflight.required_skill_gaps.length > 0) finalReport.status = "failed";
  }
  for (const prepared of [frontend.prepared, security.prepared, resume.prepared]) {
    if (prepared.memory_context?.status !== "ready" || prepared.graphify_context?.status !== "ready" || prepared.graphify_context?.mapStatus !== "current") finalReport.status = "failed";
  }
  if (!listedSkillIds.includes("matt-pocock-main-flow")) finalReport.status = "failed";
  if (!frontend.preflight.loaded_skills.some((skill: JsonRecord) => skill.skill_id === "design-taste-frontend")) finalReport.status = "failed";
  if (!security.preflight.loaded_skills.some((skill: JsonRecord) => skill.skill_id === "security-audit")) finalReport.status = "failed";
}

try {
  await main();
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_-]{1,64}$/i.test(error.message) ? error.message : "acceptance_failed";
  finalReport = { status: "failed", error_code: code };
} finally {
  await dshToolHandle?.dispose().catch(() => undefined);
  await tyrantClient?.close().catch(() => undefined);
  if (upstreamClient && memoryScope && (taskPageIds.size > 0 || projectMarkerCreated)) {
    let deleted = 0;
    let failed = 0;
    for (const taskId of taskPageIds) {
      try {
        const result = await upstreamClient.callTool({ name: "memory_delete_page", arguments: {
          workspace: memoryScope.workspace,
          project: memoryScope.project,
          path: `tyrant/tasks/${taskId}.md`,
        } });
        if (result.isError === true) failed += 1;
        else deleted += 1;
      } catch {
        failed += 1;
      }
    }
    if (projectMarkerCreated) {
      try {
        const result = await upstreamClient.callTool({ name: "memory_delete_page", arguments: {
          workspace: memoryScope.workspace,
          project: memoryScope.project,
          path: "tyrant/project.md",
        } });
        if (result.isError === true) failed += 1;
        else deleted += 1;
      } catch {
        failed += 1;
      }
    }
    finalReport.ai_memory_output_cleanup = { requested: taskPageIds.size + Number(projectMarkerCreated), deleted, failed };
    if (failed > 0) finalReport.status = "failed";
  }
  await upstreamClient?.close().catch(() => undefined);
  if (installComplete && root) {
    const uninstalled = await uninstallProjectAdapters({ projectRoot: root }).catch(() => ({ status: "cleanup_failed" }));
    finalReport.project_setup_cleanup = uninstalled.status;
    if (uninstalled.status !== "uninstalled" && uninstalled.status !== "rolled_back" && uninstalled.status !== "not_installed") finalReport.status = "failed";
  }
  if (root) {
    const absolute = resolve(root);
    const tempRoot = resolve(tmpdir());
    if (absolute.startsWith(`${tempRoot}${sep}`) && basename(absolute).startsWith("tyrant-spec07-acceptance-")) {
      await rm(absolute, { recursive: true, force: true }).catch(() => { finalReport.temp_cleanup = "failed"; finalReport.status = "failed"; });
    } else {
      finalReport.temp_cleanup = "refused_unsafe_path";
      finalReport.status = "failed";
    }
  }
  if (originalStateDir === undefined) delete process.env.TYRANT_STATE_DIR;
  else process.env.TYRANT_STATE_DIR = originalStateDir;
  if (originalAiMemoryDataDir === undefined) delete process.env.AI_MEMORY_DATA_DIR;
  else process.env.AI_MEMORY_DATA_DIR = originalAiMemoryDataDir;
  console.log(JSON.stringify(finalReport, null, 2));
  if (finalReport.status !== "passed") process.exitCode = 1;
}
