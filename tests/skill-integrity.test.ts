import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isTrustedSkillBody } from "../src/routing/skill-integrity";

const trustedSkillIds = ["ask-matt", "tdd", "code-review", "diagnosing-bugs", "design-taste-frontend", "security-audit"];

function bodyOf(content: string): string {
  const normalized = content.replaceAll("\r\n", "\n").trim();
  const end = normalized.startsWith("---\n") ? normalized.indexOf("\n---", 4) : -1;
  const start = end < 0 ? -1 : normalized.indexOf("\n", end + 4);
  return (start < 0 ? normalized : normalized.slice(start + 1)).trim();
}

test("runtime skill pins match every vendored body and reject modified or unknown bodies", async () => {
  for (const skillId of trustedSkillIds) {
    const file = join(import.meta.dir, "..", "vendor", "skills", skillId, "SKILL.md");
    const body = bodyOf(await readFile(file, "utf8"));
    expect(isTrustedSkillBody(skillId, body)).toBe(true);
    expect(isTrustedSkillBody(skillId, `${body}\nchanged`)).toBe(false);
  }
  expect(isTrustedSkillBody("unregistered-skill", "instructions")).toBe(false);
});
