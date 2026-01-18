import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

function defaultStateDir(env) {
  return (
    (env.LOBSTER_STATE_DIR && String(env.LOBSTER_STATE_DIR).trim()) ||
    path.join(os.homedir(), '.lobster', 'state')
  );
}

function keyToPath(stateDir, key) {
  // Simple, safe file keying.
  const safe = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!safe) throw new Error('state key is empty/invalid');
  return path.join(stateDir, `${safe}.json`);
}

export const stateGetCommand = {
  name: 'state.get',
  help() {
    return `state.get — read a JSON value from Lobster state\n\nUsage:\n  state.get <key>\n\nEnv:\n  LOBSTER_STATE_DIR overrides storage directory\n`;
  },
  async run({ args, ctx }) {
    const key = args._[0];
    if (!key) throw new Error('state.get requires a key');

    const stateDir = defaultStateDir(ctx.env);
    const filePath = keyToPath(stateDir, key);

    let value = null;
    try {
      const text = await fsp.readFile(filePath, 'utf8');
      value = JSON.parse(text);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        value = null;
      } else {
        throw err;
      }
    }

    return { output: asStream([value]) };
  },
};

export const stateSetCommand = {
  name: 'state.set',
  help() {
    return `state.set — write a JSON value to Lobster state\n\nUsage:\n  <value> | state.set <key>\n\nNotes:\n  - Consumes the entire input stream; stores a single JSON value.\n`;
  },
  async run({ input, args, ctx }) {
    const key = args._[0];
    if (!key) throw new Error('state.set requires a key');

    const items = [];
    for await (const item of input) items.push(item);

    const value = items.length === 1 ? items[0] : items;

    const stateDir = defaultStateDir(ctx.env);
    const filePath = keyToPath(stateDir, key);

    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');

    return { output: asStream([value]) };
  },
};

async function* asStream(items) {
  for (const item of items) yield item;
}
