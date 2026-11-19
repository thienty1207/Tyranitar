import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type AutomaticAdapterHost = "codex" | "claude-code" | "opencode" | "dsh";

type ActivationOutcome = "context_injected" | "blocked";
type ActivationEntry = {
  first_seen_at: string;
  last_seen_at: string;
  count: number;
  injected_count?: number;
  blocked_count?: number;
  last_outcome?: ActivationOutcome;
};
type ActivationReceipt = { schema_version: 1; installation_id?: string; executions: Partial<Record<AutomaticAdapterHost, ActivationEntry>> };
const MAX_ACTIVATION_RECEIPT_BYTES = 64 * 1024;
const MAX_ADAPTER_MANIFEST_BYTES = 1024 * 1024;

async function readBoundedUtf8(path: string, maxBytes: number, errorCode: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("adapter_state_not_regular_file");
    if (info.size > maxBytes) throw new Error(errorCode);
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > maxBytes) throw new Error(errorCode);
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function ensureSafeParents(projectRoot: string, target: string): Promise<void> {
  const root = await realpath(projectRoot);
  if (!inside(root, target)) throw new Error("adapter_receipt_path_outside_project");
  const rel = relative(root, dirname(target));
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("adapter_receipt_parent_not_owned");
      if (!inside(root, await realpath(current))) throw new Error("adapter_receipt_path_outside_project");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
}

function parseReceipt(raw: string): ActivationReceipt {
  if (Buffer.byteLength(raw, "utf8") > MAX_ACTIVATION_RECEIPT_BYTES) throw new Error("activation_receipt_too_large");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("activation_receipt_invalid");
  const receipt = parsed as Partial<ActivationReceipt>;
  if (receipt.schema_version !== 1 || typeof receipt.executions !== "object" || receipt.executions === null || Array.isArray(receipt.executions)) {
    throw new Error("activation_receipt_invalid");
  }
  if (receipt.installation_id !== undefined && (typeof receipt.installation_id !== "string" || receipt.installation_id.length > 128)) {
    throw new Error("activation_receipt_invalid");
  }
  for (const [host, entry] of Object.entries(receipt.executions)) {
    if (!["codex", "claude-code", "opencode", "dsh"].includes(host) || typeof entry !== "object" || entry === null ||
      typeof entry.first_seen_at !== "string" || entry.first_seen_at.length > 64 || typeof entry.last_seen_at !== "string" || entry.last_seen_at.length > 64 || !Number.isSafeInteger(entry.count) || entry.count < 1 ||
      (entry.injected_count !== undefined && (!Number.isSafeInteger(entry.injected_count) || entry.injected_count < 0)) ||
      (entry.blocked_count !== undefined && (!Number.isSafeInteger(entry.blocked_count) || entry.blocked_count < 0)) ||
      (entry.last_outcome !== undefined && !["context_injected", "blocked"].includes(entry.last_outcome))) {
      throw new Error("activation_receipt_invalid");
    }
  }
  return receipt as ActivationReceipt;
}

export async function readAdapterActivation(projectRoot: string): Promise<ActivationReceipt | undefined> {
  let root: string;
  try {
    root = await realpath(resolve(projectRoot));
  } catch {
    return undefined;
  }
  const target = resolve(root, ".tyrant", "adapters", "activation.json");
  if (!inside(root, target)) return undefined;
  let current = root;
  for (const part of [".tyrant", "adapters", "activation.json"]) {
    current = resolve(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return undefined;
      if (part !== "activation.json" && !info.isDirectory()) return undefined;
      if (part === "activation.json" && !info.isFile()) return undefined;
      if (!inside(root, await realpath(current))) return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return undefined;
    }
  }
  try {
    return parseReceipt(await readBoundedUtf8(target, MAX_ACTIVATION_RECEIPT_BYTES, "activation_receipt_too_large"));
  } catch {
    return undefined;
  }
}

export async function recordAdapterExecution(
  projectRoot: string,
  host: AutomaticAdapterHost,
  outcome: ActivationOutcome = "context_injected",
  now = new Date(),
): Promise<void> {
  const absoluteRoot = resolve(projectRoot);
  const target = resolve(absoluteRoot, ".tyrant", "adapters", "activation.json");
  await ensureSafeParents(absoluteRoot, target);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("adapter_receipt_target_not_owned");
    if (!inside(await realpath(absoluteRoot), await realpath(target))) throw new Error("adapter_receipt_path_outside_project");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let receipt: ActivationReceipt = { schema_version: 1, executions: {} };
  try {
    receipt = parseReceipt(await readBoundedUtf8(target, MAX_ACTIVATION_RECEIPT_BYTES, "activation_receipt_too_large"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let installationId: string | undefined;
  try {
    const manifest: unknown = JSON.parse(await readBoundedUtf8(resolve(absoluteRoot, ".tyrant", "adapters", "manifest.json"), MAX_ADAPTER_MANIFEST_BYTES, "adapter_manifest_too_large"));
    if (typeof manifest === "object" && manifest !== null && !Array.isArray(manifest) &&
      (manifest as Record<string, unknown>).owner === "tyrant-engine" && (manifest as Record<string, unknown>).status === "installed" &&
      typeof (manifest as Record<string, unknown>).installation_id === "string") {
      installationId = (manifest as Record<string, unknown>).installation_id as string;
    }
  } catch {
    // A plugin-manager-only DSH install may not have a project setup manifest.
  }
  if (receipt.installation_id !== installationId) receipt = { schema_version: 1, ...(installationId ? { installation_id: installationId } : {}), executions: {} };
  const previous = receipt.executions[host];
  const stamp = now.toISOString();
  receipt.executions[host] = {
    first_seen_at: previous?.first_seen_at ?? stamp,
    last_seen_at: stamp,
    count: (previous?.count ?? 0) + 1,
    injected_count: (previous?.injected_count ?? previous?.count ?? 0) + (outcome === "context_injected" ? 1 : 0),
    blocked_count: (previous?.blocked_count ?? 0) + (outcome === "blocked" ? 1 : 0),
    last_outcome: outcome,
  };
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function hashAdapterReceipt(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
