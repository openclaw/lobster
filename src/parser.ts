import { tokenizeCommand } from "./command_tokens.js";

function splitPipes(input) {
	const parts = [];
	let current = "";
	let quote = null;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (quote) {
			if (ch === "\\") {
				const next = input[i + 1];
				if (next) {
					current += ch + next;
					i++;
					continue;
				}
			}
			current += ch;
			if (ch === quote) {
				quote = null;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}

		if (ch === "|") {
			parts.push(current.trim());
			current = "";
			continue;
		}

		current += ch;
	}

	if (quote) throw new Error("Unclosed quote");
	if (current.trim().length > 0) parts.push(current.trim());
	return parts;
}

function parseArgs(tokens, booleanFlags: readonly string[] = []) {
	const args = { _: [] };

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];

		if (tok.startsWith("--")) {
			const eq = tok.indexOf("=");
			if (eq !== -1) {
				const key = tok.slice(2, eq);
				const value = tok.slice(eq + 1);
				args[key] = value;
				continue;
			}

			const key = tok.slice(2);
			const next = tokens[i + 1];
			if (booleanFlags.includes(key) || next === undefined || next.startsWith("--")) {
				args[key] = true;
				continue;
			}
			args[key] = next;
			i++;
			continue;
		}

		args._.push(tok);
	}

	return args;
}

export function parsePipeline(input) {
	const stages = splitPipes(input);
	if (stages.length === 0) throw new Error("Empty pipeline");

	return stages.map((stage) => {
		const tokens = tokenizeCommand(stage);
		if (tokens.length === 0) throw new Error("Empty command stage");
		const name = tokens[0];
		// exec's JSON switch must not consume the child executable as its value.
		const args = parseArgs(tokens.slice(1), name === "exec" ? ["json"] : []);
		return { name, args, raw: stage };
	});
}
