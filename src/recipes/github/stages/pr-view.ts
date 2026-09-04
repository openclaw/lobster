/**
 * GitHub PR View Stage - Fetch PR details via gh CLI
 *
 * @example
 * import { Lobster } from 'lobster-sdk';
 * import { ghPrView } from 'lobster/recipes/github';
 *
 * new Lobster()
 *   .pipe(ghPrView({ repo: 'owner/repo', pr: 123 }))
 *   .pipe(pr => console.log(pr.state));
 */

import { DEFAULT_MAX_OUTPUT_BYTES, runAbortableProcess } from "../../../abortable_process.js";

/**
 * Run gh command
 * @param {string[]} argv
 * @param {Object} options
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function runGh(argv, { env, cwd }) {
	const { stdout, stderr, code } = await runAbortableProcess({
		command: "gh",
		argv,
		env,
		cwd,
		maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
		notFoundMessage: "gh not found on PATH (install GitHub CLI)",
	});
	if (code === 0) {
		return { stdout, stderr };
	}
	throw new Error(`gh failed (${code}): ${stderr.trim() || stdout.trim()}`);
}

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
	const fields = options.fields ?? [
		"number",
		"title",
		"url",
		"state",
		"isDraft",
		"mergeable",
		"reviewDecision",
		"author",
		"baseRefName",
		"headRefName",
		"updatedAt",
	];

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

			const argv = ["pr", "view", String(pr), "--repo", String(repo), "--json", fields.join(",")];

			const { stdout } = (await runGh(argv, { env: ctx.env, cwd: process.cwd() })) as any;

			let parsed;
			try {
				parsed = JSON.parse(stdout.trim());
			} catch {
				throw new Error("gh returned non-JSON output");
			}

			return {
				output: (async function* () {
					yield parsed;
				})(),
			};
		},
	};
}
