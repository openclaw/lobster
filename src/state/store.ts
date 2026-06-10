import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { randomBytes } from "node:crypto";

export function defaultStateDir(env) {
  return (
    (env?.LOBSTER_STATE_DIR && String(env.LOBSTER_STATE_DIR).trim()) ||
    path.join(os.homedir(), ".lobster", "state")
  );
}

export function keyToPath(stateDir, key) {
  const safe = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!safe) throw new Error("state key is empty/invalid");
  return path.join(stateDir, `${safe}.json`);
}

export function stableStringify(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, v[k]]),
      );
    }
    return v;
  });
}

type AtomicWriteOptions = {
  renameFile?: typeof fsp.rename;
  syncParentDir?: (filePath: string) => Promise<void>;
};

type AtomicExclusiveWriteOptions = {
  linkFile?: typeof fsp.link;
  syncParentDir?: (filePath: string) => Promise<void>;
};

function isDirectorySyncUnsupportedError(err: any): boolean {
  return [
    "EACCES",
    "EBADF",
    "EINVAL",
    "EISDIR",
    "ENOSYS",
    "ENOTSUP",
    "EOPNOTSUPP",
    "EPERM",
  ].includes(err?.code);
}

async function syncParentDir(filePath: string) {
  await syncDirectory(path.dirname(filePath));
}

async function syncDirectory(dir: string) {
  let handle;
  try {
    handle = await fsp.open(dir, "r");
  } catch (err) {
    if (isDirectorySyncUnsupportedError(err)) return;
    throw err;
  }

  try {
    await handle.sync();
  } catch (err) {
    if (!isDirectorySyncUnsupportedError(err)) throw err;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function syncCreatedDirectoryChain(firstCreated: string, finalDir: string) {
  const final = path.resolve(finalDir);
  let current = path.resolve(firstCreated);

  await syncDirectory(path.dirname(current));
  while (current !== final) {
    await syncDirectory(current);
    const relative = path.relative(current, final);
    const next = relative.split(path.sep)[0];
    if (!next || next === "..") break;
    current = path.join(current, next);
  }
}

export async function ensureDirectory(dir: string) {
  const created = await fsp.mkdir(dir, { recursive: true });
  if (created) await syncCreatedDirectoryChain(created, dir);
}

export function isJsonSyntaxError(err) {
  return err instanceof SyntaxError;
}

function isLinkUnsupportedError(err: any): boolean {
  return ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(err?.code);
}

export function isAtomicExclusiveUnsupportedError(err: any): boolean {
  return err?.code === "ENOTSUP" && err?.cause && isLinkUnsupportedError(err.cause);
}

function isOptionalApprovalIndexPersistenceError(err: any): boolean {
  return (
    isAtomicExclusiveUnsupportedError(err) ||
    ["EACCES", "EDQUOT", "EIO", "ENOSPC", "EPERM", "EROFS"].includes(err?.code)
  );
}

/**
 * Write a file atomically: stage to a sibling temp file, fsync, then rename
 * over the target. `rename(2)` is atomic on a single filesystem, so a reader
 * (or a crash) never observes a truncated/partial file — it sees either the
 * complete old content or the complete new content. Plain `fsp.writeFile`
 * truncates the target up front, leaving a corruption window on SIGKILL/OOM/
 * power loss. New state files are private by default; existing file modes are
 * preserved across replacement. The temp file is removed on any failed path.
 */
export async function writeFileAtomic(filePath, data, options: AtomicWriteOptions = {}) {
  const renameFile = options.renameFile ?? fsp.rename;
  const syncDir = options.syncParentDir ?? syncParentDir;
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let mode = 0o600;
  let handle;
  let cleanup = true;
  try {
    try {
      mode = (await fsp.stat(filePath)).mode & 0o777;
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    handle = await fsp.open(tmpPath, "wx", mode);
    await handle.writeFile(data, "utf8");
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameFile(tmpPath, filePath);
    await syncDir(filePath);
    cleanup = false;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (cleanup) await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
}

export async function writeFileAtomicExclusive(
  filePath,
  data,
  options: AtomicExclusiveWriteOptions = {},
) {
  const linkFile = options.linkFile ?? fsp.link;
  const syncDir = options.syncParentDir ?? syncParentDir;
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await fsp.open(tmpPath, "wx", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await linkFile(tmpPath, filePath);
    } catch (err) {
      if (!isLinkUnsupportedError(err)) throw err;
      const unsupported = new Error(
        "Atomic exclusive file creation requires hard-link support on this filesystem",
      );
      (unsupported as NodeJS.ErrnoException).code = "ENOTSUP";
      (unsupported as Error).cause = err;
      throw unsupported;
    }
    try {
      await fsp.unlink(tmpPath);
      await syncDir(filePath);
    } catch (err) {
      await fsp.unlink(filePath).catch(() => {});
      await syncDir(filePath).catch(() => {});
      throw err;
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
}

export async function readStateJson({ env, key }) {
  const stateDir = defaultStateDir(env);
  const filePath = keyToPath(stateDir, key);

  try {
    const text = await fsp.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeStateJson({ env, key, value }) {
  const stateDir = defaultStateDir(env);
  const filePath = keyToPath(stateDir, key);

  await ensureDirectory(stateDir);
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + "\n");
}

export async function deleteStateJson({ env, key }) {
  const stateDir = defaultStateDir(env);
  const filePath = keyToPath(stateDir, key);
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
}

function sanitizeApprovalId(approvalId: string): string {
  return approvalId.replace(/[^a-f0-9]/g, "");
}

/**
 * Generate a short, human-friendly approval ID (8 hex chars).
 * These are easy to copy/paste in chat interfaces where full
 * base64url resume tokens are unwieldy.
 */
export function generateApprovalId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Write a reverse-index file that maps approvalId → stateKey.
 * Call this after writeStateJson to enable short-ID resume.
 */
export async function writeApprovalIndex({
  env,
  stateKey,
  approvalId,
  options,
}: {
  env: Record<string, string | undefined>;
  stateKey: string;
  approvalId: string;
  options?: AtomicExclusiveWriteOptions;
}) {
  const stateDir = defaultStateDir(env);
  const safe = sanitizeApprovalId(approvalId);
  if (!safe) return;
  await ensureDirectory(stateDir);
  const indexPath = path.join(stateDir, `approval_${safe}.json`);
  await writeFileAtomicExclusive(
    indexPath,
    JSON.stringify({ stateKey, createdAt: new Date().toISOString() }) + "\n",
    options,
  );
}

/**
 * Create a unique approval ID index without ever overwriting an existing mapping.
 */
export async function createApprovalIndex({
  env,
  stateKey,
  options,
}: {
  env: Record<string, string | undefined>;
  stateKey: string;
  options?: AtomicExclusiveWriteOptions;
}): Promise<string | null> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const approvalId = generateApprovalId();
    try {
      await writeApprovalIndex({ env, stateKey, approvalId, options });
      return approvalId;
    } catch (err: any) {
      if (err?.code === "EEXIST") continue;
      if (isOptionalApprovalIndexPersistenceError(err)) return null;
      throw err;
    }
  }
  throw new Error("Could not allocate a unique approval ID");
}

/**
 * Look up a state key by short approval ID.
 * Returns the stateKey string or null if not found.
 */
export async function findStateKeyByApprovalId({
  env,
  approvalId,
}: {
  env: Record<string, string | undefined>;
  approvalId: string;
}): Promise<string | null> {
  const stateDir = defaultStateDir(env);
  const safe = sanitizeApprovalId(approvalId);
  if (!safe) return null;
  const indexPath = path.join(stateDir, `approval_${safe}.json`);
  try {
    const text = await fsp.readFile(indexPath, "utf8");
    const data = JSON.parse(text);
    return typeof data?.stateKey === "string" ? data.stateKey : null;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    if (isJsonSyntaxError(err)) return null;
    throw err;
  }
}

/**
 * Delete the approval ID index file (cleanup after resume or cancel).
 */
export async function deleteApprovalId({
  env,
  approvalId,
}: {
  env: Record<string, string | undefined>;
  approvalId: string;
}) {
  const stateDir = defaultStateDir(env);
  const safe = sanitizeApprovalId(approvalId);
  if (!safe) return;
  const indexPath = path.join(stateDir, `approval_${safe}.json`);
  try {
    await fsp.unlink(indexPath);
  } catch (err: any) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
}

/**
 * Clean up any approval index file that points to the given stateKey.
 * Used when resuming via --token (where we don't know the approvalId).
 * Scans index files in the state dir — O(n) but n is tiny in practice.
 */
export async function cleanupApprovalIndexByStateKey({
  env,
  stateKey,
}: {
  env: Record<string, string | undefined>;
  stateKey: string;
}) {
  const stateDir = defaultStateDir(env);
  let files: string[];
  try {
    files = await fsp.readdir(stateDir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  for (const file of files) {
    if (!file.startsWith("approval_") || !file.endsWith(".json")) continue;
    try {
      const text = await fsp.readFile(path.join(stateDir, file), "utf8");
      const data = JSON.parse(text);
      if (data?.stateKey === stateKey) {
        await fsp.unlink(path.join(stateDir, file)).catch(() => {});
        return; // one index per stateKey
      }
    } catch {
      /* skip corrupt files */
    }
  }
}

export async function diffAndStore({ env, key, value }) {
  const before = await readStateJson({ env, key }).catch((err) => {
    if (isJsonSyntaxError(err)) return null;
    throw err;
  });
  const changed = stableStringify(before) !== stableStringify(value);
  await writeStateJson({ env, key, value });
  return { before, after: value, changed };
}
