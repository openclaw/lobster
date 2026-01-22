/**
 * Diff primitive - Compare current value against last stored value
 *
 * @example
 * import { Lobster, diffLast } from 'lobster-sdk';
 *
 * new Lobster()
 *   .pipe(fetchPRStatus())
 *   .pipe(diffLast('pr-123'))
 *   .pipe(result => {
 *     if (result.changed) {
 *       console.log('PR changed!', result.changes);
 *     }
 *   });
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Get the state directory
 * @param {Object} ctx
 * @returns {string}
 */
function getStateDir(ctx) {
  return (
    ctx?.stateDir ||
    (ctx?.env?.LOBSTER_STATE_DIR && String(ctx.env.LOBSTER_STATE_DIR).trim()) ||
    path.join(os.homedir(), '.lobster', 'state')
  );
}

/**
 * Convert a key to a safe file path
 * @param {string} stateDir
 * @param {string} key
 * @returns {string}
 */
function keyToPath(stateDir, key) {
  const safe = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!safe) throw new Error('state key is empty/invalid');
  return path.join(stateDir, `${safe}.json`);
}

/**
 * Stable JSON stringify for comparison
 * @param {any} value
 * @returns {string}
 */
function stableStringify(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
}

/**
 * Create a diff.last stage
 *
 * Compares the input against the last stored value for the given key,
 * stores the new value, and outputs a diff result.
 *
 * @param {string} key - State key to compare against
 * @param {Object} [options]
 * @param {boolean} [options.changesOnly=false] - If true, suppress output when unchanged
 * @returns {Object} Stage object with run method
 */
export function diffLast(key, options = {}) {
  if (!key) throw new Error('diffLast requires a key');

  const changesOnly = options.changesOnly === true;

  return {
    type: 'diff.last',
    key,

    async run({ input, ctx }) {
      // Collect all input items
      const items = [];
      for await (const item of input) {
        items.push(item);
      }

      const value = items.length === 1 ? items[0] : items;

      const stateDir = getStateDir(ctx);
      const filePath = keyToPath(stateDir, key);

      // Read previous value
      let before = null;
      try {
        const text = await fsp.readFile(filePath, 'utf8');
        before = JSON.parse(text);
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          throw err;
        }
      }

      // Compare
      const changed = stableStringify(before) !== stableStringify(value);

      // Store new value
      await fsp.mkdir(stateDir, { recursive: true });
      await fsp.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');

      // Build result
      const result = {
        kind: 'diff.last',
        key,
        changed,
        before,
        after: value,
      };

      // If changesOnly and no change, output suppressed marker
      if (changesOnly && !changed) {
        return {
          output: (async function* () {
            yield { kind: 'diff.last', key, changed: false, suppressed: true };
          })(),
        };
      }

      return {
        output: (async function* () {
          yield result;
        })(),
      };
    },
  };
}

/**
 * Diff and store directly (not as a pipeline stage)
 * @param {string} key
 * @param {any} value
 * @param {Object} [ctx]
 * @returns {Promise<{before: any, after: any, changed: boolean}>}
 */
export async function diffAndStoreValue(key, value, ctx = {}) {
  const stateDir = getStateDir(ctx);
  const filePath = keyToPath(stateDir, key);

  // Read previous value
  let before = null;
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    before = JSON.parse(text);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      throw err;
    }
  }

  // Compare
  const changed = stableStringify(before) !== stableStringify(value);

  // Store new value
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');

  return { before, after: value, changed };
}
