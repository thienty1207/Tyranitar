import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const versionApi = await import("../src/version").catch(() => undefined);
const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

test("runtime and package metadata agree on Tyrant release 0.1.1", () => {
  expect(versionApi?.TYRANT_VERSION).toBe("0.1.1");
  expect(packageManifest.version).toBe("0.1.1");
});
