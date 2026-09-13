/**
 * GitHub PR View Stage - Fetch PR details via gh CLI
 *
 * @example
 * import { Lobster } from '@clawdbot/lobster';
 * import { ghPrView } from '@clawdbot/lobster/recipes/github';
 *
 * new Lobster()
 *   .pipe(ghPrView({ repo: 'owner/repo', pr: 123 }))
 *   .pipe(pr => console.log(pr.state));
 */

import { runGithubPr, parseGithubPr } from "../read_pr.js";

/**
 * Create a GitHub PR view stage
 *
 * @param {Object} options
 * @param {string} options.repo - Repository in owner/repo format
 * @param {number} options.pr - PR number
 * @param {string[]} [options.fields] - Fields to fetch
 * @returns {Object} Stage object with run method
 */
export function ghPrView(options) {
	const { repo, pr } = options;

	if (!repo) throw new Error("ghPrView requires repo");
	if (!pr) throw new Error("ghPrView requires pr");

	return {
		type: "github.pr.view",
		repo,
		pr,

		async run({ input, ctx }) {
			// Drain input
			for await (const _item of input) {
				// no-op
			}

			const stdout = await runGithubPr({
				repo,
				pr,
				fields: options.fields,
				env: ctx.env,
				cwd: process.cwd(),
				signal: ctx.signal,
				forceTerminationSignal: ctx.forceTerminationSignal,
			});

			const parsed = parseGithubPr(stdout);

			return {
				output: (async function* () {
					yield parsed;
				})(),
			};
		},
	};
}
