import { promises as fsp } from 'node:fs';

import { defaultStateDir, keyToPath } from '../../state/store.js';

export const stateGetCommand = {
  name: 'state.get',
  meta: {
    description: 'Read a JSON value from Lobster state',
    argsSchema: {
      type: 'object',
      properties: {
        _: { type: 'array', items: { type: 'string' }, description: 'Key' },
      },
      required: ['_'],
    },
    sideEffects: ['reads_state'],
  },
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
  meta: {
    description: 'Write a JSON value to Lobster state',
    argsSchema: {
      type: 'object',
      properties: {
        _: { type: 'array', items: { type: 'string' }, description: 'Key' },
      },
      required: ['_'],
    },
    sideEffects: ['writes_state'],
  },
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
