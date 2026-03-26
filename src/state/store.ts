import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';

export function defaultStateDir(env) {
  return (
    (env?.LOBSTER_STATE_DIR && String(env.LOBSTER_STATE_DIR).trim()) ||
    path.join(os.homedir(), '.lobster', 'state')
  );
}

export function keyToPath(stateDir, key) {
  const safe = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!safe) throw new Error('state key is empty/invalid');
  return path.join(stateDir, `${safe}.json`);
}

export function stableStringify(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
}

export async function readStateJson({ env, key }) {
  const stateDir = defaultStateDir(env);
  const filePath = keyToPath(stateDir, key);

  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeStateJson({ env, key, value }) {
  const stateDir = defaultStateDir(env);
  const filePath = keyToPath(stateDir, key);

  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export async function deleteStateJson({ env, key }) {
  const stateDir = defaultStateDir(env);
  const filePath = keyToPath(stateDir, key);
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Generate a short, human-friendly approval ID (8 hex chars).
 * These are easy to copy/paste in chat interfaces where full
 * base64url resume tokens are unwieldy.
 */
export function generateApprovalId(): string {
  return randomBytes(4).toString('hex');
}

/**
 * Write a reverse-index file that maps approvalId → stateKey.
 * Call this after writeStateJson to enable short-ID resume.
 */
export async function writeApprovalIndex({ env, stateKey, approvalId }: {
  env: Record<string, string | undefined>;
  stateKey: string;
  approvalId: string;
}) {
  const stateDir = defaultStateDir(env);
  const safe = approvalId.replace(/[^a-f0-9]/g, '');
  if (!safe) return;
  await fsp.mkdir(stateDir, { recursive: true });
  const indexPath = path.join(stateDir, `approval_${safe}.json`);
  await fsp.writeFile(indexPath, JSON.stringify({ stateKey, createdAt: new Date().toISOString() }) + '\n', 'utf8');
}

/**
 * Look up a state key by short approval ID.
 * Returns the stateKey string or null if not found.
 */
export async function findStateKeyByApprovalId({ env, approvalId }: {
  env: Record<string, string | undefined>;
  approvalId: string;
}): Promise<string | null> {
  const stateDir = defaultStateDir(env);
  const safe = approvalId.replace(/[^a-f0-9]/g, '');
  if (!safe) return null;
  const indexPath = path.join(stateDir, `approval_${safe}.json`);
  try {
    const text = await fsp.readFile(indexPath, 'utf8');
    const data = JSON.parse(text);
    return typeof data?.stateKey === 'string' ? data.stateKey : null;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Delete the approval ID index file (cleanup after resume or cancel).
 */
export async function deleteApprovalId({ env, approvalId }: {
  env: Record<string, string | undefined>;
  approvalId: string;
}) {
  const stateDir = defaultStateDir(env);
  const safe = approvalId.replace(/[^a-f0-9]/g, '');
  if (!safe) return;
  const indexPath = path.join(stateDir, `approval_${safe}.json`);
  try {
    await fsp.unlink(indexPath);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Clean up any approval index file that points to the given stateKey.
 * Used when resuming via --token (where we don't know the approvalId).
 * Scans index files in the state dir — O(n) but n is tiny in practice.
 */
export async function cleanupApprovalIndexByStateKey({ env, stateKey }: {
  env: Record<string, string | undefined>;
  stateKey: string;
}) {
  const stateDir = defaultStateDir(env);
  let files: string[];
  try {
    files = await fsp.readdir(stateDir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  for (const file of files) {
    if (!file.startsWith('approval_') || !file.endsWith('.json')) continue;
    try {
      const text = await fsp.readFile(path.join(stateDir, file), 'utf8');
      const data = JSON.parse(text);
      if (data?.stateKey === stateKey) {
        await fsp.unlink(path.join(stateDir, file)).catch(() => {});
        return; // one index per stateKey
      }
    } catch { /* skip corrupt files */ }
  }
}

export async function diffAndStore({ env, key, value }) {
  const before = await readStateJson({ env, key });
  const changed = stableStringify(before) !== stableStringify(value);
  await writeStateJson({ env, key, value });
  return { before, after: value, changed };
}
