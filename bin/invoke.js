import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function quotePipelineArgument(value) {
	// Escape for Lobster's double-quoted token syntax, not for a shell.
	return `"${String(value).replace(/[\\"$`]/g, "\\$&")}"`;
}

export function runInvoke(commandName) {
	const pipeline = [commandName, ...process.argv.slice(2).map(quotePipelineArgument)].join(" ");
	const result = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("./lobster.js", import.meta.url)), pipeline],
		{ stdio: "inherit", env: process.env },
	);
	if (result.error)
		console.error(`${commandName} failed to spawn lobster: ${result.error.message}`);
	process.exit(result.status ?? 1);
}
