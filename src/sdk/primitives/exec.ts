import { tokenizeCommand } from "../../command_tokens.js";
/**
 * Exec primitive - Execute shell commands and return JSON output
 *
 * @example
 * import { Lobster, exec } from '@clawdbot/lobster';
 *
 * new Lobster()
 *   .pipe(exec('gh pr view 123 --repo owner/repo --json title,url'))
 *   .pipe(items => items.filter(e => e.unread))
 */

import { runAbortableProcess } from "../../abortable_process.js";

function parseCommand(command: string) {
	const [executable, ...argv] = tokenizeCommand(command, "sdk");
	return { command: executable, argv };
}

/**
 * Create an exec stage
 *
 * @param {string} cmdString - Command to execute
 * @param {Object} [options]
 * @param {boolean} [options.json=true] - Parse output as JSON
 * @param {boolean} [options.shell=false] - Use shell execution
 * @param {string} [options.cwd] - Working directory
 * @returns {Object} Stage object with run method
 */
export function exec(cmdString, options: any = {}) {
	const parseJson = options.json !== false;
	const useShell = options.shell === true;
	const cwd = options.cwd ?? process.cwd();

	return {
		type: "exec",
		command: cmdString,

		async run({ input, ctx }) {
			// Drain input (exec doesn't use input stream)
			for await (const _item of input) {
				// no-op
			}

			const env = ctx.env ?? process.env;
			const invocation = useShell ? { shellCommand: cmdString } : parseCommand(cmdString);
			const command = "command" in invocation ? invocation.command : cmdString;
			const { stdout, stderr, code } = await runAbortableProcess({
				...invocation,
				env,
				cwd,
				signal: ctx.signal,
				forceTerminationSignal: ctx.forceTerminationSignal,
				notFoundMessage: useShell
					? "exec shell not found; check LOBSTER_SHELL or ComSpec"
					: `Failed to execute ${command}: spawn ${command} ENOENT`,
			});
			if (code !== 0) {
				throw new Error(`${command} exited with code ${code}: ${stderr.trim() || stdout.trim()}`);
			}

			// Parse output
			let output;
			if (parseJson) {
				try {
					output = JSON.parse(stdout.trim() || "[]");
				} catch {
					throw new Error(`exec output is not valid JSON: ${stdout.slice(0, 100)}`);
				}
			} else {
				output = stdout;
			}

			// Normalize to array
			const items = Array.isArray(output) ? output : [output];

			return {
				output: (async function* () {
					for (const item of items) {
						yield item;
					}
				})(),
			};
		},
	};
}

/**
 * Create an exec stage that runs in shell mode
 * Convenience wrapper for exec(cmd, { shell: true })
 *
 * @param {string} cmdString
 * @param {Object} [options]
 * @returns {Object}
 */
export function shell(cmdString, options = {}) {
	return exec(cmdString, { ...options, shell: true });
}
