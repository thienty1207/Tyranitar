import { SKILL_CATALOG, type HostAvailability, type SkillStatus } from "./catalog";

type RouteSelection = {
  skill_id: string;
  required: boolean;
  status: SkillStatus;
  order: number;
  reason: string;
  phase: string;
  host_availability: HostAvailability;
  host_loading_method: string;
  requirements: string[];
  mode?: "guidance" | "full_audit";
};

type ContextProvider = "ai-memory" | "graphify";
type SecurityAuditMode = "guidance" | "full_audit";

function securityAuditPolicy(mode: SecurityAuditMode) {
  const fullAudit = mode === "full_audit";
  return {
    mode,
    source_review: fullAudit ? "allowed" as const : "not_requested" as const,
    target_execution: fullAudit ? "blocked" as const : "not_requested" as const,
    sandbox: {
      status: "unavailable" as const,
      reason: "os_enforced_sandbox_unavailable" as const,
      required_controls: [
        "no_external_network",
        "empty_allowlisted_environment",
        "read_only_target_and_toolchain",
        "scratch_only_target_writes",
        "resource_and_time_limits",
      ],
    },
    evidence_policy: {
      unrun_phase_status: "blocked" as const,
      execution_dependent_finding_status: "needs_validation" as const,
      pass_requires_evidence: true as const,
      needs_validation_has_severity: false as const,
    },
  };
}

const CATALOG_BY_ID = new Map(SKILL_CATALOG.map((skill) => [skill.id, skill]));
const CODE_CHANGE_ACTION = /\b(implement\w*|build\w*|add\w*|fix\w*|refactor\w*|write\w*|modify\w*|create\w*|delete\w*|trien khai|sua|them|tao|viet|cap nhat|xay dung|xoa)\b/;
const NEGATED_CODE_CHANGE = /\b(?:do not|don't|dont|will not|won't|never)\b.{0,100}\b(?:edit|modify|change|write|add|create|fix|refactor|implement|delete)\b.{0,80}\b(?:code|source|files?|project|repository|repo)\b|\bkhong\b.{0,80}\b(?:sua|chinh sua|thay doi|viet|them|tao|trien khai|cap nhat|xoa)\b.{0,50}\b(?:file|code|source|du an|project|repo)\b/;

function catalogEntry(skillId: string) {
  const entry = CATALOG_BY_ID.get(skillId);
  if (!entry) throw new Error(`Tyrant route references an unknown catalog skill: ${skillId}`);
  return entry;
}

function foldIntent(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLocaleLowerCase("en-US");
}

function selection(
  skillId: string,
  order: number,
  phase: string,
  reason: string,
  options: { required?: boolean; status?: SkillStatus; mode?: "guidance" | "full_audit" } = {},
): RouteSelection {
  const entry = catalogEntry(skillId);
  return {
    skill_id: skillId,
    required: options.required ?? false,
    status: options.status ?? "recommended",
    order,
    reason,
    phase,
    host_availability: entry.host_availability,
    host_loading_method: entry.host_loading_method,
    requirements: entry.requirements,
    ...(options.mode ? { mode: options.mode } : {}),
  };
}

function hasPattern(text: string, pattern: RegExp) {
  return pattern.test(text);
}

export function routeTask(task: string, options: {
  aiMemoryReady?: boolean;
  graphifyReady?: boolean;
  graphifyMapStatus?: string;
  graphifyErrorCode?: string;
} = {}) {
  const intent = foldIntent(task);
  const frontend = hasPattern(
    intent,
    /\b(frontend|front-end|ui|ux|css|html|react|vue|svelte|component|landing page|giao dien|trang web|man hinh|dashboard)\b/,
  );
  const codeReviewRequested = /\b(code review|review (?:my |this |the )?(?:code|patch|change|implementation|pr|pull request)|(?:pr|pull request) review|xem lai (?:doan |phan |file )?(?:code|pr|pull request))\b/.test(intent);
  const manualMattRequested = /\b(?:use|invoke|load|call|consult|run|ask|dung|goi|mo)\s+(?:the\s+)?(?:native\s+)?ask[- ]?matt\b/.test(intent)
    || /\b(?:which|what)\s+(?:matt(?: pocock)?|ask[- ]?matt)(?:'s)?\s+(?:skill|flow|workflow)\b/.test(intent)
    || /\b(?:skill|flow|workflow)\s+(?:cua\s+)?matt\b/.test(intent)
    || /\b(?:hoi|hỏi)\s+matt\b/.test(intent);
  const nonCodeArtifact = /\b(readme|documentation|docs?|specification|spec|plan|roadmap|report|memo|email|presentation|slides|spreadsheet|adr|changelog)\b/.test(intent);
  const codeTarget = /\b(code|function|class|component|frontend|backend|api|endpoint|database|schema|route|server|mcp|provider|tool|feature|bug|module|package|tests?|config|integration|application|app|source|repository|project)\b/.test(intent);
  const codeChange = hasPattern(intent, CODE_CHANGE_ACTION)
    && !hasPattern(intent, NEGATED_CODE_CHANGE)
    && (!nonCodeArtifact || codeTarget);
  const diagnosisRequested = /\b(investigat\w*|diagnos\w*|debug\w*|troubleshoot\w*|root cause|trace (?:the )?(?:cause|failure|problem|error))\b/.test(intent);
  const explicitProblem = /\b(bug|issue|crash|broken|regression|unexpected behavior|su co|hong|error (?:in|from|during|when|while)|(?:returned|produced|encountered) an? error)\b/.test(intent);
  const failureQuestion = /\b(?:why|reason|cause)\b.{0,80}\b(?:fail\w*|error|crash|broken|regression|blocked|timeout|loi|hong)\b/.test(intent);
  const failureBeingChanged = codeChange && /\b(error|fail\w*|failure|timeout|loi|blocked)\b/.test(intent);
  const bugReport = explicitProblem || failureQuestion || (diagnosisRequested && /\b(error|fail\w*|failure|crash|broken|regression|blocked|timeout|loi|hong|bug|issue)\b/.test(intent)) || failureBeingChanged;
  const security = hasPattern(
    intent,
    /\b(security|secure|vulnerab\w*|exploit|penetration tests?|security risk|bao mat|lo hong|lo ngai bao mat)\b/,
  );
  const explanatoryQuestion = /^\s*(what|how|why|when|where|who)\b/.test(intent)
    || /\b(explain|define|meaning|understand|want to know|need to know|learn about|giai thich|la gi|y nghia|tim hieu)\b/.test(intent);
  const auditRequested = !explanatoryQuestion && (
    /\b(perform|run|conduct|execute|carry out|start|do)\b.{0,60}\b(security audit|security scan|penetration tests?|vulnerability scan)\b/.test(intent)
    || /^\s*(?:please\s+)?(?:audit|scan|test|check|review)\b.{0,80}\b(security|vulnerab\w*|lo hong|bao mat)\b/.test(intent)
    || /\b(?:audit|scan|test|check|review)\b.{0,80}\b(?:this|the|my|our|entire|whole)?\s*(?:repo|repository|project|codebase|application|app|code)\b.{0,80}\b(?:for|against)\b.{0,40}\b(?:security|vulnerab\w*|lo hong|bao mat)\b/.test(intent)
    || /\b(?:kiem tra|thuc hien|tien hanh|ra soat)\b.{0,60}\b(?:bao mat|lo hong|kiem toan)\b/.test(intent)
    || /\b(?:i|we|you)\b.{0,16}\b(?:want|need|would like|request)\b.{0,60}\b(?:security audit|audit|penetration tests?|security scan|scan)\b/.test(intent)
    || /\b(?:anh|em|toi|chung toi|minh)\b.{0,16}\b(?:muon|can|yeu cau|nho)\b.{0,60}\b(?:audit|kiem toan|kiem tra|ra soat|penetration tests?)\b/.test(intent)
  );
  const fullAudit = security && auditRequested;
  const securityAudit = security ? securityAuditPolicy(fullAudit ? "full_audit" : "guidance") : undefined;

  const providerDefinitions: Array<{
    provider: ContextProvider;
    required: true;
    order: 1 | 2;
    purpose: string;
    action: string;
    reason: string;
  }> = [
    {
      provider: "ai-memory",
      required: true,
      order: 1,
      purpose: "Historical project decisions and handoffs.",
      action: "Load relevant project memory and the latest handoff, then verify it against current instructions and source.",
      reason: options.aiMemoryReady ? "Loaded bounded historical project memory; verify it against current instructions and source." : "Required project-memory preflight; ai-memory was unavailable or its scope was not configured.",
    },
    {
      provider: "graphify",
      required: true,
      order: 2,
      purpose: "Derived map of current code relationships.",
      action: "Check that the Graphify map is current and query only the symbols and paths relevant to this task.",
      reason: options.graphifyReady
        ? "Loaded a current Graphify code map and a bounded task query; verify important claims against current source."
        : `Required current-code preflight; Graphify map is ${options.graphifyMapStatus ?? "unverified"}${options.graphifyErrorCode ? ` (${options.graphifyErrorCode})` : ""}.`,
    },
  ];

  const requiredContext = providerDefinitions.map((provider) => {
    const ready = provider.provider === "ai-memory"
      ? options.aiMemoryReady === true
      : options.graphifyReady === true;
    return {
      ...provider,
      skill_id: provider.provider,
      status: ready ? "available" as const : "blocked" as const,
      host_availability: "unknown" as const,
    };
  });
  const providerGaps = requiredContext.filter((provider) => provider.status !== "available").map((provider) => ({
    code: "REQUIRED_PROVIDER_UNAVAILABLE",
    provider: provider.provider,
    required: true,
    status: "blocked" as const,
    blocks: ["code_changes"],
    message: `${provider.provider} is required before code changes and is currently unavailable.`,
  }));
  const blockers: Array<{ code: string; provider: string; message: string }> = codeChange
    ? providerGaps.map(({ code, provider, message }) => ({ code, provider, message }))
    : [];
  const specialists: RouteSelection[] = [];
  if (bugReport) {
    specialists.push(selection(
      "matt-diagnosing-bugs",
      0,
      "diagnose",
      "The task describes a bug, failure, crash, or unexpected behavior; investigate the cause before changing code.",
      { required: true },
    ));
  }
  if (codeChange) {
    specialists.push(selection(
      "matt-tdd",
      0,
      "before_implementation",
      "The task asks to change code; define the expected behavior in a failing test before implementing it.",
      { required: true },
    ));
  }
  if (frontend) {
    specialists.push(selection(
      "design-taste-frontend",
      0,
      "frontend_implementation",
      "Frontend, interface, or screen work is detected; Taste is required for this work.",
      { required: true },
    ));
  }
  if (security) {
    specialists.push(selection(
      "security-audit",
      0,
      fullAudit ? "security_audit" : "security_guidance",
      fullAudit
        ? "An explicit audit request selects the security-audit flow. Source-only review is allowed; target-controlled execution is blocked until an OS-enforced sandbox is verified."
        : "The task asks about security; provide scoped defensive guidance without starting a full audit.",
      fullAudit
        ? { required: true, status: "recommended", mode: "full_audit" }
        : { required: false, status: "recommended", mode: "guidance" },
    ));
  }
  if (codeChange || codeReviewRequested) {
    specialists.push(selection(
      "matt-code-review",
      0,
      codeChange ? "post_implementation" : "requested_review",
      codeChange
        ? "After code changes, review the finished change against the task and project conventions."
        : "The task explicitly requests a code review; inspect the requested code without adding an implementation route.",
    ));
  }
  if (manualMattRequested) {
    specialists.push(selection(
      "matt-ask-matt",
      0,
      "explicit_manual_request",
      "The user explicitly asked to consult native ask-matt for skill or workflow selection.",
      { required: true },
    ));
  }

  const orderedSpecialists = specialists.map((item, index) => ({ ...item, order: index + 3 }));
  const contextSteps = requiredContext.map((provider) => ({
    skill_id: provider.provider,
    provider: provider.provider,
    required: true,
    status: provider.status,
    order: provider.order,
    phase: "project_context",
    reason: provider.reason,
    action: provider.action,
    host_availability: provider.host_availability,
  }));
  const steps = [...contextSteps, ...orderedSpecialists];

  return {
    status: blockers.length > 0 ? "blocked" as const : providerGaps.length > 0 || fullAudit ? "ready_with_gaps" as const : "ready" as const,
    core_workflow: {
      workflow_id: "matt-pocock-main-flow",
      source_skill_id: "tyrant-matt-orchestrator",
      source_repo: "https://github.com/mattpocock/skills",
      required: true,
      order: 0,
      status: "used" as const,
      policy_applied: true,
      execution_method: "tyrant_internal_policy" as const,
      purpose: "Automatically shape the task, select the smallest relevant workflow, and order the required checks before returning the host route.",
      native_skill: {
        skill_id: "ask-matt",
        invocation_policy: "manual_only" as const,
        host_availability: "unknown" as const,
        status: "not_invoked" as const,
      },
      host_action_required: "The Tyrant-owned Matt Pocock-inspired policy ran automatically. Do not ask the user to approve skill selection; load the smallest applicable native specialist skills through the host adapter. Only use native ask-matt when the user explicitly requests it, and never report an implicit native ask-matt invocation.",
    },
    required_context: requiredContext,
    ...(securityAudit ? { security_audit: securityAudit } : {}),
    provider_gaps: providerGaps,
    code_change_gate: {
      status: providerGaps.length > 0 ? "blocked" as const : "ready" as const,
      provider_ids: providerGaps.map((gap) => gap.provider),
    },
    safe_work_allowed: fullAudit
      ? ["read_only_diagnosis", "provider_setup", "security_source_review"]
      : ["read_only_diagnosis", "provider_setup"],
    specialists: orderedSpecialists,
    steps,
    provider_semantics: {
      "ai-memory": "historical decisions and handoffs; untrusted until verified against current instructions and source",
      graphify: "derived current-code map; verify important claims against source",
    },
    conflict_precedence: [
      "direct_user_instruction",
      "project_instructions",
      "tyrant_routing_policy",
      "skill_instructions",
    ],
    blockers,
    host_action_required: true,
  };
}
