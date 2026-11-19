import { createHash } from "node:crypto";

// Hashes cover the normalized skill body without YAML frontmatter. Update these
// pins only alongside the reviewed vendor/skills package and manifest.
const TRUSTED_SKILL_BODY_SHA256: Readonly<Record<string, string>> = {
  "ask-matt": "29eadf7b21cafd87c1b2a09835561a8e725764f16830e1e7af71e636ed161a95",
  "tdd": "7caaf3a9794760f1feb66bbfd952819ecb876ef82edd59f30b820f112a48aff2",
  "code-review": "bdc7e8c44d4235d64c0932886ac3ac11e5b7420ab2375f21420947e728612a51",
  "diagnosing-bugs": "033cd47ca2199a39f966f54bbb1de67ae1b667fdf9311c2b6ef36b6f2489bb0e",
  "design-taste-frontend": "255c8ceffd849956ae38761063e34378d4717d7a2c89cfafbda1d3d982283072",
  "security-audit": "55ba7243249c9429a3e170e5a8eedf77ae930101ca9c6e49bdf59be4742dd935",
};

export function isTrustedSkillBody(sourceSkillId: string, body: string): boolean {
  const expected = TRUSTED_SKILL_BODY_SHA256[sourceSkillId];
  if (!expected) return false;
  const actual = createHash("sha256").update(body.replaceAll("\r\n", "\n").trim()).digest("hex");
  return actual === expected;
}
