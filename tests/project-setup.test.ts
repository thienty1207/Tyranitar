import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectAdapterHost } from "../src/adapters/project-setup";

const setupApi = await import("../src/adapters/project-setup").catch(() => undefined);
const activationApi = await import("../src/adapters/activation").catch(() => undefined);

async function fixture(hosts: ProjectAdapterHost[] = ["codex", "claude-code", "opencode"]) {
  const base = await mkdtemp(join(tmpdir(), "tyrant-project-setup-"));
  const projectRoot = join(base, "project");
  const tyrantRoot = join(base, "tyrant");
  await mkdir(projectRoot);
  await mkdir(join(tyrantRoot, "src"), { recursive: true });
  await mkdir(join(tyrantRoot, "integrations", "opencode"), { recursive: true });
  await mkdir(join(tyrantRoot, "vendor", "skills"), { recursive: true });
  await writeFile(join(tyrantRoot, "src", "index.ts"), "// MCP server entry\n");
  await writeFile(join(tyrantRoot, "integrations", "command-hook.js"), "// bundled command adapter\n");
  await writeFile(join(tyrantRoot, "integrations", "opencode", "index.js"), "// bundled OpenCode adapter\n");
  const packages = [
    { repository: "https://github.com/mattpocock/skills", commit: "d1478fcb140db0b93c0c8df17bcfd311844749d0", tree_sha: "42b57b23ac2979fce601ce1d4b4d6c1d46471bbe", license: "MIT", skill_ids: ["ask-matt", "tdd", "diagnosing-bugs", "code-review"] },
    { repository: "https://github.com/Leonxlnx/taste-skill", commit: "f6b76575f949707b4e3c37cd86cb44b0b98643e8", tree_sha: "8684feda2c345302dab976ae4c42ae62e04e1263", license: "MIT", skill_ids: ["design-taste-frontend"] },
    { repository: "https://github.com/cloudflare/security-audit-skill", commit: "c1c8a8c1471069fb0e188eeaff69b8e8db6564a8", tree_sha: "8cd03bb3941496e441d6248aaae2429a35b93cc3", license: "MIT", skill_ids: ["security-audit"] },
  ];
  const files = [
    "ask-matt/SKILL.md", "tdd/SKILL.md", "diagnosing-bugs/SKILL.md", "code-review/SKILL.md",
    "design-taste-frontend/SKILL.md", "security-audit/SKILL.md",
    "_licenses/mattpocock-skills-LICENSE", "_licenses/Leonxlnx-taste-skill-LICENSE", "_licenses/cloudflare-security-audit-skill-LICENSE",
  ];
  const records: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const content = `Pinned upstream fixture: ${file}\n`;
    const vendorPath = `vendor/skills/${file}`;
    const target = join(tyrantRoot, vendorPath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
    const sourcePath = file.startsWith("_licenses/") ? "LICENSE"
      : file.startsWith("design-taste-frontend/") ? `skills/taste-skill/${file.slice("design-taste-frontend/".length)}`
        : file.startsWith("security-audit/") ? `skills/security-audit/${file.slice("security-audit/".length)}`
          : `skills/engineering/${file}`;
    records.push({ source_path: sourcePath, vendor_path: vendorPath, project_path: `.tyrant/skills/${file}`, git_blob_sha: gitBlobSha(content), sha256: createHash("sha256").update(content).digest("hex"), size: Buffer.byteLength(content) });
  }
  await writeFile(join(tyrantRoot, "vendor", "skills", "manifest.json"), JSON.stringify({ schema_version: 1, packages, files: records }));
  return { base, projectRoot, tyrantRoot, hosts, options: { projectRoot, tyrantRoot, hosts } };
}

async function digest(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function gitBlobSha(content: string | Buffer) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");
}

test("setup preview lists only project-scoped adapter files and writes nothing", async () => {
  expect(setupApi?.previewProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture();
  try {
    const preview = await setupApi.previewProjectAdapters(f.options);
    expect(preview.status).toBe("ready");
    expect(preview.changes.map((item: { path: string }) => item.path)).toEqual(expect.arrayContaining([
      ".tyrant/adapters/command-hook.js",
      ".codex/config.toml",
      ".claude/settings.json",
      ".mcp.json",
      ".opencode/opencode.jsonc",
      ".opencode/plugins/tyrant-engine.js",
      ".tyrant/skills/manifest.json",
      ".tyrant/skills/ask-matt/SKILL.md",
      ".tyrant/skills/design-taste-frontend/SKILL.md",
      ".tyrant/skills/security-audit/SKILL.md",
    ]));
    expect(preview.changes.some((item: { path: string }) => item.path === ".codex/hooks.json")).toBe(false);
    expect(await readdir(f.projectRoot)).toEqual([]);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("setup accepts a Windows CRLF checkout for pinned LF skill files and installs canonical bytes", async () => {
  expect(setupApi?.previewProjectAdapters).toBeDefined();
  expect(setupApi?.installProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture();
  const relativePath = "vendor/skills/ask-matt/SKILL.md";
  const canonical = Buffer.from("Pinned upstream fixture: ask-matt/SKILL.md\n");
  try {
    await writeFile(join(f.tyrantRoot, relativePath), Buffer.from(canonical.toString("utf8").replaceAll("\n", "\r\n")));
    const preview = await setupApi.previewProjectAdapters(f.options);
    expect(preview.status).toBe("ready");

    const installed = await setupApi.installProjectAdapters(f.options);
    expect(installed.status).toBe("installed");
    expect(await readFile(join(f.projectRoot, ".tyrant/skills/ask-matt/SKILL.md"))).toEqual(canonical);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("setup refuses project paths with shell substitution characters in generated hooks", async () => {
  expect(setupApi?.previewProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture(["codex", "claude-code"]);
  const unsafeProject = join(f.base, "project-$(marker)-`whoami`");
  await mkdir(unsafeProject);
  try {
    const preview = await setupApi.previewProjectAdapters({ ...f.options, projectRoot: unsafeProject });
    expect(preview.status).toBe("conflict");
    expect(preview.conflicts.some((item: { reason: string }) => item.reason === "hook_path_has_unsupported_characters")).toBe(true);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("setup preserves unrelated hook settings and repeated install is idempotent", async () => {
  expect(setupApi?.installProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture();
  const codexPath = join(f.projectRoot, ".codex", "config.toml");
  const claudePath = join(f.projectRoot, ".claude", "settings.json");
  const codexOriginal = [
    'model = "keep-model"',
    '[mcp_servers.github]',
    'command = "echo"',
    'args = ["keep"]',
    '[[hooks.PreToolUse]]',
    'matcher = "Bash"',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    'command = "echo keep"',
    "",
  ].join("\n");
  const claudeOriginal = JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo keep" }] }] } }, null, 2);
  const mcpOriginal = JSON.stringify({ mcpServers: { github: { type: "stdio", command: "echo", args: ["keep"] } } }, null, 2);
  await mkdir(join(f.projectRoot, ".codex"), { recursive: true });
  await mkdir(join(f.projectRoot, ".claude"), { recursive: true });
  await writeFile(codexPath, codexOriginal);
  await writeFile(claudePath, claudeOriginal);
  await writeFile(join(f.projectRoot, ".mcp.json"), mcpOriginal);
  try {
    const first = await setupApi.installProjectAdapters(f.options);
    expect(first.status).toBe("installed");
    expect(await readFile(join(f.projectRoot, ".tyrant", "skills", "ask-matt", "SKILL.md"), "utf8")).toContain("Pinned upstream fixture: ask-matt/SKILL.md");
    expect(JSON.parse(await readFile(join(f.projectRoot, ".tyrant", "skills", "manifest.json"), "utf8")).files).toHaveLength(9);
    const codex = Bun.TOML.parse(await readFile(codexPath, "utf8")) as Record<string, any>;
    const claude = JSON.parse(await readFile(claudePath, "utf8"));
    const mcpConfig = JSON.parse(await readFile(join(f.projectRoot, ".mcp.json"), "utf8"));
    const openCodeConfig = Bun.JSONC.parse(await readFile(join(f.projectRoot, ".opencode", "opencode.jsonc"), "utf8")) as Record<string, any>;
    expect(codex.model).toBe("keep-model");
    expect(codex.mcp_servers.github).toEqual({ command: "echo", args: ["keep"] });
    expect(codex.mcp_servers.tyrant.env.TYRANT_PROJECT_ROOT).toBe(realpathSync.native(f.projectRoot));
    expect(codex.hooks.PreToolUse).toHaveLength(1);
    expect(codex.hooks.UserPromptSubmit).toHaveLength(1);
    expect(codex.hooks.UserPromptSubmit[0].hooks[0].additionalContextLimit).toBe(0);
    expect(codex.hooks.SessionEnd).toHaveLength(1);
    expect(claude.permissions).toEqual({ allow: ["Read"] });
    expect(claude.hooks.PreToolUse).toEqual(JSON.parse(claudeOriginal).hooks.PreToolUse);
    expect(claude.hooks.UserPromptSubmit).toHaveLength(1);
    expect(claude.hooks.UserPromptSubmit[0].hooks[0].onFailure).toBe("block");
    expect(claude.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(60);
    expect(claude.hooks.SessionEnd[0].hooks[0].timeout).toBe(60);
    expect(codex.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
    expect(mcpConfig.mcpServers.github).toEqual(JSON.parse(mcpOriginal).mcpServers.github);
    expect(mcpConfig.mcpServers.tyrant.args.at(-1).endsWith("index.ts")).toBe(true);
    expect(mcpConfig.mcpServers.tyrant.env.TYRANT_PROJECT_ROOT).toBe("${CLAUDE_PROJECT_DIR:-.}");
    expect(openCodeConfig.mcp.servers.tyrant.command.at(-1).endsWith("index.ts")).toBe(true);
    expect(openCodeConfig.mcp.servers.tyrant.cwd).toBe(".");
    const paths = [codexPath, claudePath, join(f.projectRoot, ".mcp.json"), join(f.projectRoot, ".opencode", "opencode.jsonc"), join(f.projectRoot, ".tyrant", "adapters", "command-hook.js"), join(f.projectRoot, ".opencode", "plugins", "tyrant-engine.js")];
    const before = await Promise.all(paths.map(digest));
    const backupRoot = join(f.projectRoot, ".tyrant", "adapters", "backups");
    const backupCount = (await readdir(backupRoot)).length;
    const second = await setupApi.installProjectAdapters(f.options);
    expect(second.status).toBe("already_configured");
    expect(await Promise.all(paths.map(digest))).toEqual(before);
    expect((await readdir(backupRoot)).length).toBe(backupCount);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("setup blocks when a pinned skill source file fails its SHA-256 record", async () => {
  expect(setupApi?.previewProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture();
  try {
    await writeFile(join(f.tyrantRoot, "vendor", "skills", "ask-matt", "SKILL.md"), "tampered upstream content\n");
    const preview = await setupApi.previewProjectAdapters(f.options);
    expect(preview.status).toBe("conflict");
    expect(preview.conflicts.some((item: { reason: string }) => item.reason.includes("pinned_skill_hash_mismatch"))).toBe(true);
    expect(await readdir(f.projectRoot)).toEqual([]);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("setup detects changed skill bytes even when the editable SHA-256 and size are updated", async () => {
  expect(setupApi?.previewProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture();
  try {
    const content = Buffer.from("modified skill body with a matching editable sha256\n");
    const skillPath = join(f.tyrantRoot, "vendor", "skills", "ask-matt", "SKILL.md");
    await writeFile(skillPath, content);
    const manifestPath = join(f.tyrantRoot, "vendor", "skills", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = manifest.files.find((file: { vendor_path: string }) => file.vendor_path === "vendor/skills/ask-matt/SKILL.md");
    entry.sha256 = createHash("sha256").update(content).digest("hex");
    entry.size = content.length;
    await writeFile(manifestPath, JSON.stringify(manifest));

    const preview = await setupApi.previewProjectAdapters(f.options);
    expect(preview.status).toBe("conflict");
    expect(preview.conflicts.some((item: { reason: string }) => item.reason.includes("pinned_skill_hash_mismatch"))).toBe(true);
    expect(await readdir(f.projectRoot)).toEqual([]);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("setup never overwrites an existing unowned pinned skill", async () => {
  expect(setupApi?.previewProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture();
  const target = join(f.projectRoot, ".tyrant", "skills", "ask-matt", "SKILL.md");
  try {
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "user-owned skill\n");
    const preview = await setupApi.previewProjectAdapters(f.options);
    expect(preview.status).toBe("conflict");
    expect(preview.conflicts).toContainEqual({ path: ".tyrant/skills/ask-matt/SKILL.md", reason: "unowned_pinned_skill_target_already_exists" });
    expect(await readFile(target, "utf8")).toBe("user-owned skill\n");
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("setup refuses an unallowlisted skill even when it is added to the local manifest", async () => {
  expect(setupApi?.previewProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture();
  try {
    const extraPath = join(f.tyrantRoot, "vendor", "skills", "site-clone", "SKILL.md");
    const content = "Site Clone must stay excluded.\n";
    await mkdir(join(extraPath, ".."), { recursive: true });
    await writeFile(extraPath, content);
    const manifestPath = join(f.tyrantRoot, "vendor", "skills", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files.push({
      source_path: "skills/site-clone/SKILL.md",
      vendor_path: "vendor/skills/site-clone/SKILL.md",
      project_path: ".tyrant/skills/site-clone/SKILL.md",
      git_blob_sha: "b".repeat(40), sha256: createHash("sha256").update(content).digest("hex"), size: Buffer.byteLength(content),
    });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const preview = await setupApi.previewProjectAdapters(f.options);
    expect(preview.status).toBe("conflict");
    expect(preview.conflicts.some((item: { reason: string }) => item.reason === "pinned_skill_source_path_not_allowlisted")).toBe(true);
    expect(await readdir(f.projectRoot)).toEqual([]);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("setup rejects dot-segment aliases in pinned skill manifest paths", async () => {
  expect(setupApi?.previewProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture();
  try {
    const manifestPath = join(f.tyrantRoot, "vendor", "skills", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = manifest.files.find((file: { vendor_path: string }) => file.vendor_path === "vendor/skills/ask-matt/SKILL.md");
    entry.vendor_path = "vendor/skills/./ask-matt/SKILL.md";
    entry.project_path = ".tyrant/skills/./ask-matt/SKILL.md";
    await writeFile(manifestPath, JSON.stringify(manifest));

    const preview = await setupApi.previewProjectAdapters(f.options);
    expect(preview.status).toBe("conflict");
    expect(preview.conflicts.some((item: { reason: string }) => item.reason === "unsafe_managed_path")).toBe(true);
    expect(await readdir(f.projectRoot)).toEqual([]);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("malformed host config aborts setup before any target is written", async () => {
  expect(setupApi?.installProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture();
  const malformed = join(f.projectRoot, ".claude", "settings.json");
  await mkdir(join(f.projectRoot, ".claude"), { recursive: true });
  await writeFile(malformed, "{ not valid json");
  try {
    const result = await setupApi.installProjectAdapters(f.options);
    expect(result.status).toBe("conflict");
    expect(result.conflicts.map((item: { path: string }) => item.path)).toContain(".claude/settings.json");
    expect(await readdir(f.projectRoot)).toEqual([".claude"]);
    expect(await readFile(malformed, "utf8")).toBe("{ not valid json");
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("a user-modified managed file makes setup stop without touching other targets", async () => {
  expect(setupApi?.installProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture();
  try {
    expect((await setupApi.installProjectAdapters(f.options)).status).toBe("installed");
    const pluginPath = join(f.projectRoot, ".opencode", "plugins", "tyrant-engine.js");
    await writeFile(pluginPath, "// user edit\n");
    const commandPath = join(f.projectRoot, ".tyrant", "adapters", "command-hook.js");
    const commandHash = await digest(commandPath);
    const result = await setupApi.installProjectAdapters(f.options);
    expect(result.status).toBe("conflict");
    expect(result.conflicts.map((item: { path: string }) => item.path)).toContain(".opencode/plugins/tyrant-engine.js");
    expect(await digest(commandPath)).toBe(commandHash);
    expect(await readFile(pluginPath, "utf8")).toBe("// user edit\n");
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("rollback restores prior config bytes and removes only new adapter files", async () => {
  expect(setupApi?.rollbackProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture();
  const configPath = join(f.projectRoot, ".codex", "config.toml");
  const original = 'model = "preserve"\n';
  await mkdir(join(f.projectRoot, ".codex"), { recursive: true });
  await writeFile(configPath, original);
  try {
    expect((await setupApi.installProjectAdapters(f.options)).status).toBe("installed");
    const result = await setupApi.rollbackProjectAdapters({ projectRoot: f.projectRoot });
    expect(result.status).toBe("rolled_back");
    expect(await readFile(configPath, "utf8")).toBe(original);
    await expect(readFile(join(f.projectRoot, ".mcp.json"))).rejects.toThrow();
    await expect(readFile(join(f.projectRoot, ".opencode", "plugins", "tyrant-engine.js"))).rejects.toThrow();
    await expect(readFile(join(f.projectRoot, ".tyrant", "adapters", "command-hook.js"))).rejects.toThrow();
    expect(await readdir(join(f.projectRoot, ".tyrant", "adapters", "backups")).catch(() => [])).toEqual([]);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("rollback safely recovers an installation interrupted after some files were written", async () => {
  expect(setupApi?.installProjectAdapters).toBeDefined();
  expect(setupApi?.rollbackProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture();
  try {
    expect((await setupApi.installProjectAdapters(f.options)).status).toBe("installed");
    const manifestPath = join(f.projectRoot, ".tyrant", "adapters", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.status = "installing";
    delete manifest.manifest_sha256;
    manifest.manifest_sha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const notYetWritten = join(f.projectRoot, ".opencode", "plugins", "tyrant-engine.js");
    await rm(notYetWritten);
    const result = await setupApi.rollbackProjectAdapters({ projectRoot: f.projectRoot });
    expect(result.status).toBe("rolled_back");
    await expect(readFile(join(f.projectRoot, ".codex", "config.toml"))).rejects.toThrow();
    await expect(readFile(join(f.projectRoot, ".claude", "settings.json"))).rejects.toThrow();
    await expect(readFile(manifestPath)).rejects.toThrow();
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("rollback can resume after a crash restored one managed target", async () => {
  expect(setupApi?.installProjectAdapters).toBeDefined();
  expect(setupApi?.rollbackProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture();
  const configPath = join(f.projectRoot, ".codex", "config.toml");
  const original = 'model = "resume-rollback"\n';
  await mkdir(join(f.projectRoot, ".codex"), { recursive: true });
  await writeFile(configPath, original);
  try {
    expect((await setupApi.installProjectAdapters(f.options)).status).toBe("installed");
    const manifest = JSON.parse(await readFile(join(f.projectRoot, ".tyrant", "adapters", "manifest.json"), "utf8"));
    const managed = manifest.files.find((file: { path: string }) => file.path === ".codex/config.toml");
    expect(managed?.backup_path).toBeTruthy();
    await writeFile(configPath, await readFile(join(f.projectRoot, managed.backup_path)));
    const result = await setupApi.rollbackProjectAdapters({ projectRoot: f.projectRoot });
    expect(result.status).toBe("rolled_back");
    expect(await readFile(configPath, "utf8")).toBe(original);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("setup refuses backup writes through a project-local junction", async () => {
  expect(setupApi?.installProjectAdapters).toBeDefined();
  if (!setupApi || process.platform !== "win32") return;
  const f = await fixture();
  const external = join(f.base, "outside-project");
  const backupRoot = join(f.projectRoot, ".tyrant", "adapters", "backups");
  const configPath = join(f.projectRoot, ".codex", "config.toml");
  const original = 'model = "must-stay"\n';
  await mkdir(external);
  await mkdir(join(f.projectRoot, ".codex"), { recursive: true });
  await mkdir(join(f.projectRoot, ".tyrant", "adapters"), { recursive: true });
  await writeFile(configPath, original);
  await symlink(external, backupRoot, "junction");
  try {
    const result = await setupApi.installProjectAdapters(f.options);
    expect(result.status).toBe("conflict");
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await readdir(external)).toHaveLength(0);
    await expect(readFile(join(f.projectRoot, ".mcp.json"))).rejects.toThrow();
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("uninstall refuses to overwrite any user-edited managed entry", async () => {
  expect(setupApi?.uninstallProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture();
  try {
    expect((await setupApi.installProjectAdapters(f.options)).status).toBe("installed");
    const configPath = join(f.projectRoot, ".claude", "settings.json");
    const edited = `${await readFile(configPath, "utf8")}\n`;
    await writeFile(configPath, edited);
    const pluginPath = join(f.projectRoot, ".opencode", "plugins", "tyrant-engine.js");
    const pluginHash = await digest(pluginPath);
    const result = await setupApi.uninstallProjectAdapters({ projectRoot: f.projectRoot });
    expect(result.status).toBe("conflict");
    expect(result.conflicts.map((item: { path: string }) => item.path)).toContain(".claude/settings.json");
    expect(await digest(pluginPath)).toBe(pluginHash);
    expect(await readFile(configPath, "utf8")).toBe(edited);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("activation receipt records that an adapter hook ran without storing task text", async () => {
  expect(setupApi?.recordAdapterExecution).toBeDefined();
  expect(setupApi?.getProjectAdapterStatus).toBeDefined();
  if (!setupApi) return;
  const f = await fixture(["codex"]);
  try {
    const installed = await setupApi.installProjectAdapters(f.options);
    expect(installed.status).toBe("installed");
    if (installed.status !== "installed") throw new Error("Expected adapter installation.");
    expect(installed.hosts.codex).toBe("configured_pending_trust");
    await setupApi.recordAdapterExecution(f.projectRoot, "codex");
    const status = await setupApi.getProjectAdapterStatus({ projectRoot: f.projectRoot });
    expect(status.hosts.codex).toBe("hook_executed");
    const receipt = await readFile(join(f.projectRoot, ".tyrant", "adapters", "activation.json"), "utf8");
    expect(receipt).not.toContain("secret");
    expect(JSON.parse(receipt).executions.codex.count).toBe(1);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("activation receipt reads reject oversized project-controlled JSON before parsing or rewriting it", async () => {
  expect(activationApi?.readAdapterActivation).toBeDefined();
  expect(activationApi?.recordAdapterExecution).toBeDefined();
  if (!activationApi) return;
  const projectRoot = await mkdtemp(join(tmpdir(), "tyrant-oversized-activation-"));
  const receiptPath = join(projectRoot, ".tyrant", "adapters", "activation.json");
  await mkdir(join(projectRoot, ".tyrant", "adapters"), { recursive: true });
  const oversized = JSON.stringify({ schema_version: 1, executions: {}, padding: "x".repeat(70_000) });
  await writeFile(receiptPath, oversized);
  try {
    expect(await activationApi.readAdapterActivation(projectRoot)).toBeUndefined();
    await expect(activationApi.recordAdapterExecution(projectRoot, "dsh")).rejects.toThrow("activation_receipt_too_large");
    expect(await readFile(receiptPath, "utf8")).toBe(oversized);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("activation status distinguishes a blocked preflight from context injection", async () => {
  expect(setupApi?.recordAdapterExecution).toBeDefined();
  expect(setupApi?.getProjectAdapterStatus).toBeDefined();
  if (!setupApi) return;
  const f = await fixture(["codex"]);
  try {
    expect((await setupApi.installProjectAdapters(f.options)).status).toBe("installed");
    await setupApi.recordAdapterExecution(f.projectRoot, "codex", "context_injected");
    await setupApi.recordAdapterExecution(f.projectRoot, "codex", "blocked");
    const status = await setupApi.getProjectAdapterStatus({ projectRoot: f.projectRoot });
    expect(status.hosts.codex).toBe("hook_blocked");
    const receipt = JSON.parse(await readFile(join(f.projectRoot, ".tyrant", "adapters", "activation.json"), "utf8"));
    expect(receipt.executions.codex).toMatchObject({ count: 2, blocked_count: 1, injected_count: 1, last_outcome: "blocked" });
    expect(JSON.stringify(receipt)).not.toContain("Fix the API");
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("DSH setup stages pinned skills and explains plugin activation while Claude Desktop stays MCP-only", async () => {
  expect(setupApi?.previewProjectAdapters).toBeDefined();
  expect(setupApi?.installProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture(["dsh", "claude-desktop"]);
  try {
    const preview = await setupApi.previewProjectAdapters(f.options);
    expect(preview.status).toBe("ready");
    expect(preview.changes.map((item: { path: string }) => item.path)).toContain(".tyrant/skills/ask-matt/SKILL.md");
    expect(preview.changes.map((item: { path: string }) => item.path)).toContain(".agents/skills/ask-matt/SKILL.md");
    expect(preview.hosts).toMatchObject({ dsh: "profile_plugin_managed", "claude-desktop": "mcp_only" });
    expect(preview.manual_actions).toEqual([]);
    const installed = await setupApi.installProjectAdapters(f.options);
    expect(installed.status).toBe("installed");
    expect(installed.manual_actions).toEqual([]);
    expect(await readFile(join(f.projectRoot, ".tyrant", "skills", "ask-matt", "SKILL.md"), "utf8")).toContain("Pinned upstream fixture");
    expect(await readFile(join(f.projectRoot, ".agents", "skills", "ask-matt", "SKILL.md"), "utf8")).toContain("Pinned upstream fixture");
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("DSH setup preserves a user-owned native skill with a colliding name", async () => {
  expect(setupApi?.previewProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture(["dsh"]);
  const target = join(f.projectRoot, ".agents", "skills", "ask-matt", "SKILL.md");
  try {
    await mkdir(join(f.projectRoot, ".agents", "skills", "ask-matt"), { recursive: true });
    await writeFile(target, "user-owned skill body\n");
    const preview = await setupApi.previewProjectAdapters(f.options);
    expect(preview.status).toBe("conflict");
    expect(preview.conflicts).toContainEqual({ path: ".agents/skills/ask-matt/SKILL.md", reason: "unowned_pinned_skill_target_already_exists" });
    expect(await readFile(target, "utf8")).toBe("user-owned skill body\n");
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("project init guidance merges arbitrary profile labels and exact scope without replacing user instructions", async () => {
  expect(setupApi?.installProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture(["codex"]);
  const original = "# My project\n\nKeep this user-authored note.\n";
  await writeFile(join(f.projectRoot, "AGENTS.md"), original);
  const scope = { workspace: "tyrant-profile-abc123", project: "project-0123456789abcdef" };
  try {
    const options = { ...f.options, profileGuidance: { profileId: "profile-abc123", profileName: "Anything / User Named", ...scope } };
    expect((await setupApi.installProjectAdapters(options)).status).toBe("installed");
    let agents = await readFile(join(f.projectRoot, "AGENTS.md"), "utf8");
    expect(agents).toContain("Keep this user-authored note.");
    expect(agents).toContain('profile_name_json: "Anything / User Named"');
    expect(agents).toContain(`ai_memory_workspace: ${scope.workspace}`);
    expect(agents).toContain("historical, untrusted context");
    expect(agents).toContain("derived context from the current code");

    const rebound = { ...options, profileGuidance: { ...options.profileGuidance!, profileId: "profile-next", profileName: "Next arbitrary label" } };
    expect((await setupApi.installProjectAdapters(rebound)).status).toBe("installed");
    agents = await readFile(join(f.projectRoot, "AGENTS.md"), "utf8");
    expect(agents).toContain("Keep this user-authored note.");
    expect(agents).toContain('profile_name_json: "Next arbitrary label"');
    expect(agents).not.toContain('profile_name_json: "Anything / User Named"');

    expect((await setupApi.uninstallProjectAdapters({ projectRoot: f.projectRoot })).status).toBe("rolled_back");
    expect(await readFile(join(f.projectRoot, "AGENTS.md"), "utf8")).toBe(original);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("user edits outside Tyrant guidance survive re-init and uninstall", async () => {
  expect(setupApi?.installProjectAdapters).toBeDefined();
  expect(setupApi?.previewProjectAdapters).toBeDefined();
  expect(setupApi?.uninstallProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture(["codex"]);
  try {
    const options = { ...f.options, profileGuidance: { profileId: "profile-a", profileName: "Vault A", workspace: "workspace-a", project: "project-a" } };
    expect((await setupApi.installProjectAdapters(options)).status).toBe("installed");
    const agentsPath = join(f.projectRoot, "AGENTS.md");
    const edited = `${await readFile(agentsPath, "utf8")}\n# Added by user after setup\nKeep this extra instruction.\n`;
    await writeFile(agentsPath, edited);

    expect((await setupApi.previewProjectAdapters(options)).status).toBe("ready");
    expect((await setupApi.installProjectAdapters(options)).status).toBe("installed");
    const updated = await readFile(agentsPath, "utf8");
    expect(updated).toContain("Keep this extra instruction.");
    expect(updated).toContain("BEGIN TYRANT ENGINE PROJECT GUIDANCE");

    expect((await setupApi.uninstallProjectAdapters({ projectRoot: f.projectRoot })).status).toBe("rolled_back");
    const afterUninstall = await readFile(agentsPath, "utf8");
    expect(afterUninstall).toContain("Keep this extra instruction.");
    expect(afterUninstall).not.toContain("BEGIN TYRANT ENGINE PROJECT GUIDANCE");
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("updates registered managed adapter files only when prior hashes still match", async () => {
  expect(setupApi?.installProjectAdapters).toBeDefined();
  expect(setupApi?.previewProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture(["codex"]);
  try {
    const first = { ...f.options, profileGuidance: { profileId: "profile-a", profileName: "Vault A", workspace: "workspace-a", project: "project-a" } };
    expect((await setupApi.installProjectAdapters(first)).status).toBe("installed");
    const oldConfig = await readFile(join(f.projectRoot, ".codex", "config.toml"), "utf8");
    await writeFile(join(f.tyrantRoot, "integrations", "command-hook.js"), "// updated command adapter\n");

    const update = { ...first, allowManagedUpgrade: true };
    expect((await setupApi.previewProjectAdapters(update)).status).toBe("ready");
    expect((await setupApi.installProjectAdapters(update)).status).toBe("installed");
    expect(await readFile(join(f.projectRoot, ".tyrant", "adapters", "command-hook.js"), "utf8")).toBe("// updated command adapter\n");
    expect(await readFile(join(f.projectRoot, ".codex", "config.toml"), "utf8")).toBe(oldConfig);

    const userEdited = join(f.projectRoot, ".tyrant", "adapters", "command-hook.js");
    await writeFile(userEdited, "// local edit\n");
    const blocked = await setupApi.previewProjectAdapters(update);
    expect(blocked.status).toBe("conflict");
    expect(await readFile(userEdited, "utf8")).toBe("// local edit\n");
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("uninstall preserves user text added outside Tyrant guidance without re-init", async () => {
  expect(setupApi?.installProjectAdapters).toBeDefined();
  expect(setupApi?.uninstallProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture(["codex"]);
  try {
    const options = { ...f.options, profileGuidance: { profileId: "profile-a", profileName: "Vault A", workspace: "workspace-a", project: "project-a" } };
    expect((await setupApi.installProjectAdapters(options)).status).toBe("installed");
    const agentsPath = join(f.projectRoot, "AGENTS.md");
    await writeFile(agentsPath, `${await readFile(agentsPath, "utf8")}\n# User edit\nKeep this after uninstall.\n`);
    expect((await setupApi.uninstallProjectAdapters({ projectRoot: f.projectRoot })).status).toBe("rolled_back");
    const restored = await readFile(agentsPath, "utf8");
    expect(restored).toContain("Keep this after uninstall.");
    expect(restored).not.toContain("BEGIN TYRANT ENGINE PROJECT GUIDANCE");
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("project setup blocks ambiguous managed guidance markers before writing", async () => {
  expect(setupApi?.previewProjectAdapters).toBeDefined();
  if (!setupApi) return;
  const f = await fixture(["codex"]);
  await writeFile(join(f.projectRoot, "AGENTS.md"), "<!-- BEGIN TYRANT ENGINE PROJECT GUIDANCE -->\npartial block\n");
  try {
    const preview = await setupApi.previewProjectAdapters({
      ...f.options,
      profileGuidance: { profileId: "profile-a", profileName: "A", workspace: "workspace-a", project: "project-a" },
    });
    expect(preview.status).toBe("conflict");
    expect(preview.conflicts).toContainEqual({ path: "AGENTS.md", reason: "project_guidance_block_ambiguous" });
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});
