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

import { readStateJson, writeStateJson } from "../../state/store.js";

function stateEnv(ctx) {
	return ctx?.stateDir
		? { ...(ctx?.env ?? process.env), LOBSTER_STATE_DIR: ctx.stateDir }
		: (ctx?.env ?? process.env);
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

			const value = await readStateJson({ env: stateEnv(ctx), key });

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

			await writeStateJson({ env: stateEnv(ctx), key, value, signal: ctx?.signal });

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
	return readStateJson({ env: stateEnv(ctx), key });
}

/**
 * Write state directly (not as a pipeline stage)
 * @param {string} key
 * @param {any} value
 * @param {Object} [ctx]
 * @returns {Promise<void>}
 */
export async function writeState(key, value, ctx: any = {}) {
	await writeStateJson({ env: stateEnv(ctx), key, value, signal: ctx?.signal });
}
