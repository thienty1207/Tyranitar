import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

export function canonicalExistingPath(value: string, platform: NodeJS.Platform = process.platform): string {
  const paths = pathApi(platform);
  let canonical = paths.resolve(value);
  if (platform !== "win32") return paths.normalize(canonical);

  try {
    canonical = realpathSync.native(canonical);
  } catch {
    // Non-existent paths are compared lexically; existing Windows paths are
    // resolved above so 8.3 aliases and long names share one identity.
  }
  if (/^\\\\\?\\UNC\\/i.test(canonical)) canonical = `\\\\${canonical.slice(8)}`;
  else if (canonical.startsWith("\\\\?\\")) canonical = canonical.slice(4);
  return win32.normalize(canonical);
}

export function canonicalPathIdentity(value: string, platform: NodeJS.Platform = process.platform): string {
  const canonical = canonicalExistingPath(value, platform);
  return platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
}

export function isPathWithin(root: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = pathApi(platform);
  const relativePath = paths.relative(canonicalPathIdentity(root, platform), canonicalPathIdentity(candidate, platform));
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relativePath));
}
