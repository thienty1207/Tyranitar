import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const messages = await import("../src/adapters/dsh-message").catch(() => undefined);
const dshPlugin = await import("../integrations/dsh/index").catch(() => undefined);

test("Tyrant automatic-context messages follow DSH's immutable user-message contract", () => {
  expect(messages?.createTyrantUserMessage).toBeDefined();
  if (!messages) return;

  const content = [{ type: "text", text: "Tyrant context" }];
  const source = { kind: "tyrant", form: "automatic-context", request_id: "request-1" };
  const message = messages.createTyrantUserMessage({ content, source });

  expect(message.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(message.role).toBe("user");
  expect(message.content[0].text).toBe("Tyrant context");
  expect(message.source.request_id).toBe("request-1");
  expect(Object.isFrozen(message)).toBe(true);
  expect(Object.isFrozen(message.content)).toBe(true);
  expect(Object.isFrozen(message.content[0])).toBe(true);

  content[0].text = "changed after creation";
  expect(message.content[0].text).toBe("Tyrant context");
});

test("DSH Tyrant plugin entry imports without an unavailable host-only package", () => {
  expect(dshPlugin?.apply).toBeFunction();
});

test("built DSH integration entry can load in the Node host", () => {
  const entry = join(process.cwd(), "integrations", "dsh", "index.js");
  const script = `import(${JSON.stringify(new URL(`file:///${entry.replaceAll("\\", "/")}`).href)})`;
  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
});
