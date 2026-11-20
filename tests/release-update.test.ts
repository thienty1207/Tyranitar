import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll } from "bun:test";
import { activateVaultProfile, bindProjectProfile, resolveProjectProfile } from "../src/setup/profiles";
import { registerInstalledProject } from "../src/setup/install-state";
import { installProjectAdapters } from "../src/adapters/project-setup";

const releaseUpdateApi = await import("../src/setup/release-update").catch(() => undefined);
const fixtures = await mkdtemp(join(tmpdir(), "tyrant-release-update-"));
afterAll(async () => { await rm(fixtures, { recursive: true, force: true }); });

function releaseFixture(sha256: string) {
  return {
    tag_name: "v0.1.1",
    draft: false,
    prerelease: false,
    assets: [{
      name: "tyrant-engine-0.1.1-windows-x64.zip",
      browser_download_url: "https://github.com/thienty1207/Tyranitar/releases/download/v0.1.1/tyrant-engine-0.1.1-windows-x64.zip",
      digest: `sha256:${sha256}`,
      state: "uploaded",
    }],
  };
}

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content);
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");
}

async function engineFixture(root: string, hookBody: string): Promise<void> {
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
    const content = `Pinned release-update fixture: ${file}\n`;
    const vendorPath = `vendor/skills/${file}`;
    const target = join(root, vendorPath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
    const sourcePath = file.startsWith("_licenses/") ? "LICENSE"
      : file.startsWith("design-taste-frontend/") ? `skills/taste-skill/${file.slice("design-taste-frontend/".length)}`
        : file.startsWith("security-audit/") ? `skills/security-audit/${file.slice("security-audit/".length)}`
          : `skills/engineering/${file}`;
    records.push({ source_path: sourcePath, vendor_path: vendorPath, project_path: `.tyrant/skills/${file}`, git_blob_sha: gitBlobSha(content), sha256: createHash("sha256").update(content).digest("hex"), size: Buffer.byteLength(content) });
  }
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "integrations"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "// Tyrant MCP entry\n");
  await writeFile(join(root, "integrations", "command-hook.js"), hookBody);
  await writeFile(join(root, "vendor", "skills", "manifest.json"), JSON.stringify({ schema_version: 1, packages, files: records }));
}

test("release updater exposes strict release, digest, and archive path validators", () => {
  expect(releaseUpdateApi?.selectWindowsReleaseAsset).toBeDefined();
  expect(releaseUpdateApi?.verifyReleaseDigest).toBeDefined();
  expect(releaseUpdateApi?.isSafeArchiveEntry).toBeDefined();
});

test("selects only a published stable Windows asset whose tag, name, and GitHub URL agree", () => {
  if (!releaseUpdateApi) throw new Error("release_update_module_missing");
  const digest = "a".repeat(64);
  expect(releaseUpdateApi.selectWindowsReleaseAsset(releaseFixture(digest))).toEqual({
    version: "0.1.1",
    url: "https://github.com/thienty1207/Tyranitar/releases/download/v0.1.1/tyrant-engine-0.1.1-windows-x64.zip",
    sha256: digest,
  });
  expect(() => releaseUpdateApi.selectWindowsReleaseAsset({ ...releaseFixture(digest), draft: true })).toThrow("release_not_published");
  expect(() => releaseUpdateApi.selectWindowsReleaseAsset({ ...releaseFixture(digest), prerelease: true })).toThrow("release_prerelease_unsupported");
  expect(() => releaseUpdateApi.selectWindowsReleaseAsset({ ...releaseFixture(digest), tag_name: "latest" })).toThrow("release_tag_invalid");
  expect(() => releaseUpdateApi.selectWindowsReleaseAsset({ ...releaseFixture(digest), assets: [] })).toThrow("release_asset_missing");
});

test("requires the GitHub asset SHA-256 digest and rejects tampered or untrusted package metadata", () => {
  if (!releaseUpdateApi) throw new Error("release_update_module_missing");
  const bytes = new TextEncoder().encode("tyrant release archive fixture");
  const digest = createHash("sha256").update(bytes).digest("hex");
  expect(releaseUpdateApi.verifyReleaseDigest(bytes, `sha256:${digest}`)).toBe(true);
  expect(releaseUpdateApi.verifyReleaseDigest(bytes, `sha256:${"0".repeat(64)}`)).toBe(false);
  expect(() => releaseUpdateApi.verifyReleaseDigest(bytes, digest)).toThrow("release_digest_invalid");
  expect(() => releaseUpdateApi.selectWindowsReleaseAsset({
    ...releaseFixture(digest),
    assets: [{ ...releaseFixture(digest).assets[0], browser_download_url: "https://example.com/tyrant.zip" }],
  })).toThrow("release_asset_url_untrusted");
  expect(() => releaseUpdateApi.selectWindowsReleaseAsset({
    ...releaseFixture(digest),
    assets: [{ ...releaseFixture(digest).assets[0], digest: null }],
  })).toThrow("release_digest_missing");
});

test("rejects ZIP entry paths that escape the staged package directory", () => {
  if (!releaseUpdateApi) throw new Error("release_update_module_missing");
  expect(releaseUpdateApi.isSafeArchiveEntry("src/index.ts")).toBe(true);
  expect(releaseUpdateApi.isSafeArchiveEntry("vendor/skills/manifest.json")).toBe(true);
  expect(releaseUpdateApi.isSafeArchiveEntry("../outside.txt")).toBe(false);
  expect(releaseUpdateApi.isSafeArchiveEntry("src/../../outside.txt")).toBe(false);
  expect(releaseUpdateApi.isSafeArchiveEntry("C:/Windows/system.ini")).toBe(false);
  expect(releaseUpdateApi.isSafeArchiveEntry("\\server\share\file")).toBe(false);
});

test("downloads, verifies, stages, activates, and refreshes a newer stable Windows release", async () => {
  if (!releaseUpdateApi) throw new Error("release_update_module_missing");
  const bytes = new TextEncoder().encode("verified 0.1.1 archive");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const requests: string[] = [];
  const calls: string[] = [];
  const result = await releaseUpdateApi.updateTyrant({
    platform: "win32",
    currentVersion: "0.1.0",
    currentRoot: "C:\\Tyrant\\versions\\0.1.0",
    stateDirectory: "C:\\Users\\tester\\AppData\\Local\\Tyrant",
    fetch: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("api.github.com")) return new Response(JSON.stringify(releaseFixture(digest)), { status: 200 });
      return new Response(bytes, { status: 200 });
    },
    installArchive: async (asset, archiveBytes) => {
      expect(asset.version).toBe("0.1.1");
      expect(archiveBytes).toEqual(bytes);
      calls.push("install");
      return "C:\\Users\\tester\\AppData\\Local\\Tyrant\\versions\\0.1.1";
    },
    activateVersion: async (version) => { calls.push(`activate:${version}`); },
    refreshDsh: async () => { calls.push("dsh"); return { status: "installed", profile: "desktop" }; },
    refreshProjects: async () => { calls.push("projects"); return [{ project_root: "D:\\project", status: "updated" }]; },
  });
  expect(requests).toHaveLength(2);
  expect(calls).toEqual(["install", "activate:0.1.1", "dsh", "projects"]);
  expect(result).toMatchObject({ status: "updated", previous_version: "0.1.0", version: "0.1.1" });
});

test("does not install or activate a release when its downloaded bytes fail the published digest", async () => {
  if (!releaseUpdateApi) throw new Error("release_update_module_missing");
  const bytes = new TextEncoder().encode("modified archive");
  const calls: string[] = [];
  await expect(releaseUpdateApi.updateTyrant({
    platform: "win32",
    currentVersion: "0.1.0",
    currentRoot: "C:\\Tyrant\\versions\\0.1.0",
    stateDirectory: "C:\\Users\\tester\\AppData\\Local\\Tyrant",
    fetch: async (input) => String(input).includes("api.github.com")
      ? new Response(JSON.stringify(releaseFixture("a".repeat(64))), { status: 200 })
      : new Response(bytes, { status: 200 }),
    installArchive: async () => { calls.push("install"); return "unused"; },
    activateVersion: async () => { calls.push("activate"); },
  })).rejects.toThrow("release_digest_mismatch");
  expect(calls).toEqual([]);
});

test("reports already-current releases without downloading or changing the active version", async () => {
  if (!releaseUpdateApi) throw new Error("release_update_module_missing");
  const bytes = new TextEncoder().encode("unused");
  const digest = createHash("sha256").update(bytes).digest("hex");
  let requestCount = 0;
  const result = await releaseUpdateApi.updateTyrant({
    platform: "win32",
    currentVersion: "0.1.1",
    currentRoot: "C:\\Tyrant\\versions\\0.1.1",
    stateDirectory: "C:\\Users\\tester\\AppData\\Local\\Tyrant",
    fetch: async () => { requestCount += 1; return new Response(JSON.stringify(releaseFixture(digest)), { status: 200 }); },
    installArchive: async () => { throw new Error("must_not_install"); },
    activateVersion: async () => { throw new Error("must_not_activate"); },
  });
  expect(result).toEqual({ status: "up_to_date", previous_version: "0.1.1", version: "0.1.1" });
  expect(requestCount).toBe(1);
});

test("default update refreshes registered projects while preserving their vault binding", { timeout: 30_000 }, async () => {
  if (!releaseUpdateApi) throw new Error("release_update_module_missing");
  const stateDirectory = join(fixtures, "state");
  const projectRoot = join(fixtures, "registered-project");
  const vaultPath = join(fixtures, "vault");
  const firstEngineRoot = join(fixtures, "engine-0.1.0");
  const nextEngineRoot = join(fixtures, "engine-0.1.1");
  await Promise.all([mkdir(projectRoot, { recursive: true }), mkdir(vaultPath, { recursive: true })]);
  await engineFixture(firstEngineRoot, "// Tyrant 0.1.0 hook\n");
  await engineFixture(nextEngineRoot, "// Tyrant 0.1.1 hook\n");
  const profile = await activateVaultProfile({ vaultPath, name: "Project vault", endpoint: "http://127.0.0.1:49375/mcp", configPath: join(vaultPath, "config.toml") }, { stateDirectory });
  const binding = await bindProjectProfile({ projectRoot, profile }, { stateDirectory });
  const guidance = { profileId: profile.id, profileName: profile.name, ...binding.scope };
  expect((await installProjectAdapters({ projectRoot, tyrantRoot: firstEngineRoot, hosts: ["codex"], profileGuidance: guidance })).status).toBe("installed");
  await registerInstalledProject(projectRoot, ["codex"], { stateDirectory });

  const bytes = new TextEncoder().encode("verified 0.1.1 archive");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const result = await releaseUpdateApi.updateTyrant({
    platform: "win32",
    currentVersion: "0.1.0",
    currentRoot: "C:\\Tyrant\\versions\\0.1.0",
    stateDirectory,
    env: {},
    fetch: async (input) => String(input).includes("api.github.com")
      ? new Response(JSON.stringify(releaseFixture(digest)), { status: 200 })
      : new Response(bytes, { status: 200 }),
    installArchive: async () => nextEngineRoot,
    activateVersion: async () => undefined,
    refreshDsh: async () => ({ status: "ready", profile: "workstation" }),
  });

  expect(result.projects).toEqual([{ project_root: realpathSync.native(projectRoot), status: "updated" }]);
  expect(await readFile(join(projectRoot, ".tyrant", "adapters", "command-hook.js"), "utf8")).toBe("// Tyrant 0.1.1 hook\n");
  const codexConfig = Bun.TOML.parse(await readFile(join(projectRoot, ".codex", "config.toml"), "utf8")) as { mcp_servers: { tyrant: { args: string[] } } };
  expect(codexConfig.mcp_servers.tyrant.args).toEqual(["run", join(nextEngineRoot, "src", "index.ts")]);
  const after = await resolveProjectProfile(projectRoot, { stateDirectory });
  expect(after?.binding.profileId).toBe(profile.id);
  expect(after?.binding.scope).toEqual(binding.scope);
});
