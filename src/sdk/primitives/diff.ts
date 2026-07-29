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

import { diffAndStore } from "../../state/store.js";

function stateEnv(ctx) {
	return ctx?.stateDir
		? { ...(ctx?.env ?? process.env), LOBSTER_STATE_DIR: ctx.stateDir }
		: (ctx?.env ?? process.env);
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
export function diffLast(key, options: any = {}) {
	if (!key) throw new Error("diffLast requires a key");

	const changesOnly = options.changesOnly === true;

	return {
		type: "diff.last",
		key,

		async run({ input, ctx }) {
			// Collect all input items
			const items = [];
			for await (const item of input) {
				items.push(item);
			}

			const value = items.length === 1 ? items[0] : items;

			const { before, after, changed } = await diffAndStore({
				env: stateEnv(ctx),
				key,
				value,
				signal: ctx?.signal,
			});

			// Build result
			const result = {
				kind: "diff.last",
				key,
				changed,
				before,
				after,
			};

			// If changesOnly and no change, output suppressed marker
			if (changesOnly && !changed) {
				return {
					output: (async function* () {
						yield { kind: "diff.last", key, changed: false, suppressed: true };
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
export async function diffAndStoreValue(key, value, ctx: any = {}) {
	return diffAndStore({ env: stateEnv(ctx), key, value, signal: ctx?.signal });
}
