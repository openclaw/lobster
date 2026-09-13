export function tokenizeCommand(input: string, dialect: "pipeline" | "sdk" = "pipeline"): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	let tokenStarted = false;

	const push = () => {
		if (tokenStarted) tokens.push(current);
		current = "";
		tokenStarted = false;
	};

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (quote) {
			// The public SDK command string has historically unescaped any quoted character.
			if (dialect === "sdk") {
				if (ch === "\\" && input[i + 1]) {
					current += input[++i];
					continue;
				}
				if (ch === quote) {
					quote = null;
					continue;
				}
				current += ch;
				continue;
			}

			if (quote === "'") {
				if (ch === "\\" && input[i + 1] === quote) {
					current += quote;
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

			// Double-quoted mode: preserve unknown escapes (\n, \t, etc) while
			// unescaping only shell-like quote/backslash escapes.
			if (ch === "\\") {
				const next = input[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					current += next;
					i++;
					continue;
				}
				if (next === "\n") {
					i++;
					continue;
				}
				current += ch;
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
			tokenStarted = true;
			continue;
		}

		if (ch === " " || ch === "\t" || (dialect === "pipeline" && (ch === "\n" || ch === "\r"))) {
			push();
			continue;
		}

		tokenStarted = true;
		current += ch;
	}

	if (quote && dialect === "pipeline") throw new Error("Unclosed quote");
	push();
	return tokens;
}
