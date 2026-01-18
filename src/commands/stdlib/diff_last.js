import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function defaultStateDir(env) {
  return (
    (env.LOBSTER_STATE_DIR && String(env.LOBSTER_STATE_DIR).trim()) ||
    path.join(os.homedir(), '.lobster', 'state')
  );
}

function keyToPath(stateDir, key) {
  const safe = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!safe) throw new Error('diff.last key is empty/invalid');
  return path.join(stateDir, `${safe}.json`);
}

function stableStringify(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
}

export const diffLastCommand = {
  name: 'diff.last',
  help() {
    return `diff.last — compare current items to last stored snapshot\n\nUsage:\n  <items> | diff.last --key <stateKey>\n\nOutput:\n  { changed, key, before, after }\n`;
  },
  async run({ input, args, ctx }) {
    const key = args.key ?? args._[0];
    if (!key) throw new Error('diff.last requires --key');

    const afterItems = [];
    for await (const item of input) afterItems.push(item);

    const stateDir = defaultStateDir(ctx.env);
    const filePath = keyToPath(stateDir, key);

    let before = null;
    try {
      const text = await fsp.readFile(filePath, 'utf8');
      before = JSON.parse(text);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }

    const after = afterItems.length === 1 ? afterItems[0] : afterItems;
    const changed = stableStringify(before) !== stableStringify(after);

    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.writeFile(filePath, JSON.stringify(after, null, 2) + '\n', 'utf8');

    return {
      output: (async function* () {
        yield { kind: 'diff.last', key, changed, before, after };
      })(),
    };
  },
};
