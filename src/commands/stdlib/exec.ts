import { DEFAULT_MAX_OUTPUT_BYTES, runAbortableProcess } from "../../abortable_process.js";

export const execCommand = {
	name: "exec",
	meta: {
		description: "Run an OS command",
		argsSchema: {
			type: "object",
			properties: {
				json: { type: "boolean", description: "Parse stdout as JSON (single value)." },
				shell: { type: "string", description: "Run via the system shell with this command line." },
				_: { type: "array", items: { type: "string" }, description: "Command + args." },
			},
			required: ["_"],
		},
		sideEffects: ["local_exec"],
	},
	help() {
		return (
			`exec — run an OS command\n\n` +
			`Usage:\n` +
			`  exec <command...>\n` +
			`  exec --stdin raw|json|jsonl <command...>\n` +
			`  exec --json <command...>\n` +
			`  exec --shell "<command line>"\n\n` +
			`Notes:\n` +
			`  - With --json, parses stdout as JSON (single value).\n` +
			`  - With --stdin, writes pipeline input to stdin.\n` +
			`  - With --shell (or a single arg containing spaces), runs via the system shell.\n`
		);
	},
	async run({ input, args, ctx }) {
		const cmd = args._;
		const cwd = ctx?.cwd ?? process.cwd();

		const shellLine = typeof args.shell === "string" ? args.shell : null;
		const useShell = Boolean(args.shell) || (cmd.length === 1 && /\s/.test(cmd[0]));
		const stdinMode = typeof args.stdin === "string" ? String(args.stdin).toLowerCase() : null;

		if (!cmd.length && !shellLine) throw new Error("exec requires a command");

		let stdinPayload = null;
		if (stdinMode) {
			const items = [];
			for await (const item of input) items.push(item);
			stdinPayload = encodeStdin(items, stdinMode);
		} else {
			// Drain input to avoid dangling streams.
			for await (const _item of input) {
				// no-op
			}
		}

		const result = useShell
			? await runShellLine(shellLine ?? cmd[0] ?? "", {
					env: ctx.env,
					cwd,
					stdin: stdinPayload,
					signal: ctx.signal,
					forceTerminationSignal: ctx.forceTerminationSignal,
				})
			: await runProcess(cmd[0], cmd.slice(1), {
					env: ctx.env,
					cwd,
					stdin: stdinPayload,
					signal: ctx.signal,
					forceTerminationSignal: ctx.forceTerminationSignal,
				});

		if (args.json) {
			let parsed;
			try {
				parsed = JSON.parse(result.stdout.trim() || "null");
			} catch (err) {
				throw new Error(
					`exec --json could not parse stdout as JSON: ${err?.message ?? String(err)}`,
				);
			}

			return {
				output: asStream(Array.isArray(parsed) ? parsed : [parsed]),
			};
		}

		const lines = result.stdout.split(/\r?\n/).filter(Boolean);
		return { output: asStream(lines) };
	},
};

async function runProcess(command, argv, { env, cwd, stdin, signal, forceTerminationSignal }) {
	const { stdout, stderr, code } = await runAbortableProcess({
		command,
		argv,
		env,
		cwd,
		stdin,
		signal,
		forceTerminationSignal,
		maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
		notFoundMessage: `exec command not found: ${command}`,
	});
	if (code === 0) return { stdout, stderr };
	throw new Error(`exec failed (${code}): ${stderr.trim() || stdout.trim() || command}`);
}

function runShellLine(commandLine, { env, cwd, stdin, signal, forceTerminationSignal }) {
	return runAbortableProcess({
		shellCommand: commandLine,
		env,
		cwd,
		stdin,
		signal,
		forceTerminationSignal,
		maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
		notFoundMessage: "exec shell not found; check LOBSTER_SHELL or ComSpec",
	}).then(({ stdout, stderr, code }) => {
		if (code === 0) return { stdout, stderr };
		throw new Error(`exec failed (${code}): ${stderr.trim() || stdout.trim() || commandLine}`);
	});
}

function encodeStdin(items, mode) {
	if (mode === "json") return JSON.stringify(items);
	if (mode === "jsonl") {
		return items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : "");
	}
	if (mode === "raw") {
		return items.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n");
	}
	throw new Error(`exec --stdin must be raw, json, or jsonl (got ${mode})`);
}

async function* asStream(items) {
	for (const item of items) yield item;
}
