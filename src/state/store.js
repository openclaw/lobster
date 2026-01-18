import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

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

export async function diffAndStore({ env, key, value }) {
  const before = await readStateJson({ env, key });
  const changed = stableStringify(before) !== stableStringify(value);
  await writeStateJson({ env, key, value });
  return { before, after: value, changed };
}
