/**
 * State primitives - Persistent state management
 *
 * @example
 * import { Lobster, stateGet, stateSet } from 'lobster-sdk';
 *
 * // Read state
 * new Lobster()
 *   .pipe(stateGet('my-key'))
 *   .pipe(value => console.log(value));
 *
 * // Write state
 * new Lobster()
 *   .pipe(() => ({ count: 42 }))
 *   .pipe(stateSet('my-key'));
 */

import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Write a file atomically (stage to a sibling temp file, fsync, then rename).
 * `rename(2)` is atomic on a single filesystem, so a concurrent reader or a
 * crash never observes a truncated/partial file. Plain `fsp.writeFile`
 * truncates the target up front, leaving a corruption window on SIGKILL/OOM/
 * power loss. New state files are private by default; existing file modes are
 * preserved across replacement. Kept local to keep the SDK self-contained.
 * @param {string} filePath
 * @param {string} data
 */
async function writeFileAtomic(filePath, data) {
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
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.chmod(tmpPath, mode);
    await fsp.rename(tmpPath, filePath);
    cleanup = false;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (cleanup) await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
}

/**
 * Get the state directory
 * @param {Object} ctx
 * @returns {string}
 */
function getStateDir(ctx) {
  return (
    ctx?.stateDir ||
    (ctx?.env?.LOBSTER_STATE_DIR && String(ctx.env.LOBSTER_STATE_DIR).trim()) ||
    path.join(os.homedir(), ".lobster", "state")
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
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!safe) throw new Error("state key is empty/invalid");
  return path.join(stateDir, `${safe}.json`);
}

/**
 * Create a state.get stage
 *
 * @param {string} key - State key to read
 * @returns {Object} Stage object with run method
 */
export function stateGet(key) {
  if (!key) throw new Error("stateGet requires a key");

  return {
    type: "state.get",
    key,

    async run({ input, ctx }) {
      // Drain input
      for await (const _item of input) {
        // no-op
      }

      const stateDir = getStateDir(ctx);
      const filePath = keyToPath(stateDir, key);

      let value = null;
      try {
        const text = await fsp.readFile(filePath, "utf8");
        value = JSON.parse(text);
      } catch (err) {
        if (err?.code !== "ENOENT") {
          throw err;
        }
        // File doesn't exist, return null
      }

      return {
        output: (async function* () {
          yield value;
        })(),
      };
    },
  };
}

/**
 * Create a state.set stage
 *
 * @param {string} key - State key to write
 * @returns {Object} Stage object with run method
 */
export function stateSet(key) {
  if (!key) throw new Error("stateSet requires a key");

  return {
    type: "state.set",
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

      await fsp.mkdir(stateDir, { recursive: true });
      await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + "\n");

      // Pass through the value
      return {
        output: (async function* () {
          yield value;
        })(),
      };
    },
  };
}

/**
 * State namespace - provides get/set methods
 *
 * @example
 * import { state } from 'lobster-sdk';
 *
 * new Lobster()
 *   .pipe(state.get('my-key'))
 *   .pipe(state.set('my-key'));
 */
export const state = {
  get: stateGet,
  set: stateSet,
};

/**
 * Read state directly (not as a pipeline stage)
 * @param {string} key
 * @param {Object} [ctx]
 * @returns {Promise<any>}
 */
export async function readState(key, ctx = {}) {
  const stateDir = getStateDir(ctx);
  const filePath = keyToPath(stateDir, key);

  try {
    const text = await fsp.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write state directly (not as a pipeline stage)
 * @param {string} key
 * @param {any} value
 * @param {Object} [ctx]
 * @returns {Promise<void>}
 */
export async function writeState(key, value, ctx = {}) {
  const stateDir = getStateDir(ctx);
  const filePath = keyToPath(stateDir, key);

  await fsp.mkdir(stateDir, { recursive: true });
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + "\n");
}
