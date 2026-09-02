/**
 * Exec primitive - Execute shell commands and return JSON output
 *
 * @example
 * import { Lobster, exec } from 'lobster-sdk';
 *
 * new Lobster()
 *   .pipe(exec('gh pr view 123 --repo owner/repo --json title,url'))
 *   .pipe(items => items.filter(e => e.unread))
 */

import { DEFAULT_MAX_OUTPUT_BYTES, runAbortableProcess } from "../../abortable_process.js";
import { resolveInlineShellCommand } from "../../shell.js";

/**
 * Run a process and capture output
 * @param {string} command
 * @param {string[]} argv
 * @param {Object} options
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function runProcess(command, argv, { env, cwd }) {
	const { stdout, stderr, code } = await runAbortableProcess({
		command,
		argv,
		env,
		cwd,
		maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
		notFoundMessage: `Failed to execute ${command}: spawn ${command} ENOENT`,
	});
	if (code === 0) {
		return { stdout, stderr };
	}
	throw new Error(`${command} exited with code ${code}: ${stderr.trim() || stdout.trim()}`);
}

/**
 * Parse a shell command string into command and arguments
 * Simple parsing - for complex cases, use options.shell
 * @param {string} cmdString
 * @returns {{command: string, args: string[]}}
 */
function parseCommand(cmdString) {
	const tokens = [];
	let current = "";
	let quote = null;

	for (let i = 0; i < cmdString.length; i++) {
		const ch = cmdString[i];

		if (quote) {
			if (ch === "\\" && cmdString[i + 1]) {
				current += cmdString[i + 1];
				i++;
				continue;
			}
			if (ch === quote) {
				quote = null;
				continue;
			}
			current += ch;
			continue;
		}

		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}

		if (ch === " " || ch === "\t") {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += ch;
	}

	if (current.length > 0) {
		tokens.push(current);
	}

	const [command, ...args] = tokens;
	return { command, args };
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

			let stdout;

			if (useShell) {
				// Shell execution
				const shell = resolveInlineShellCommand({ command: cmdString, env });
				const result = await runProcess(shell.command, shell.argv, { env, cwd });
				stdout = result.stdout;
			} else {
				// Direct execution
				const { command, args } = parseCommand(cmdString);
				const result = await runProcess(command, args, { env, cwd });
				stdout = result.stdout;
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
