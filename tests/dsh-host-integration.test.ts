import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const integration = await import("../integrations/dsh/index").catch(() => undefined);

test("DSH bundle registers and serves Tyrant tools in each real agent scope", async () => {
  expect(integration?.apply).toBeFunction();
  if (!integration) return;

  const workspace = await mkdtemp(join(tmpdir(), "tyrant-dsh-host-"));
  const listeners = new Map<string, (payload: any) => Promise<unknown>>();
  const definitions = new Map<string, any>();
  const ctx = {
    on(event: string, listener: (payload: any) => Promise<unknown>) {
      listeners.set(event, listener);
    },
  };
  const agent = {
    id: "acceptance-agent",
    session: { id: "acceptance-session", header: { cwd: workspace } },
    ctx: {
      tools: {
        register(definition: any) {
          definitions.set(definition.name, definition);
          return () => { definitions.delete(definition.name); };
        },
      },
    },
  };

  integration.apply(ctx as any);
  try {
    const created = listeners.get("agent/created");
    expect(created).toBeDefined();
    await created?.({ agent });

    expect(definitions.size).toBe(36);
    expect(definitions.has("tyrant_prepare_task")).toBe(true);
    expect(definitions.has("tyrant_list_skills")).toBe(true);

    const listSkills = definitions.get("tyrant_list_skills");
    const result = await listSkills.execute({ schema_version: 1 }, { signal: new AbortController().signal });
    const skillIds = result.structuredContent.skills.map((skill: { id: string }) => skill.id);
    expect(skillIds).toContain("matt-pocock-main-flow");
    expect(skillIds).toContain("design-taste-frontend");
    expect(skillIds).toContain("security-audit");
  } finally {
    await listeners.get("agent/disposed")?.({ agent });
    await rm(workspace, { recursive: true, force: true });
  }
});
