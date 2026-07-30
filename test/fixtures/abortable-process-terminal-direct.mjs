#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [runnerPath] = process.argv.slice(2);
const { runAbortableProcess } = await import(pathToFileURL(runnerPath).href);

function processGroupId() {
	const stat = readFileSync("/proc/self/stat", "utf8");
	const fields = stat
		.slice(stat.lastIndexOf(")") + 1)
		.trim()
		.split(/\s+/);
	return Number(fields[2]);
}

writeFileSync(process.env.LOBSTER_TERMINAL_DIRECT_GROUP_FILE, String(processGroupId()), "utf8");

await runAbortableProcess({
	command: process.execPath,
	argv: [
		"-e",
		`const { writeFileSync } = require("node:fs");
writeFileSync(process.env.LOBSTER_TERMINAL_DIRECT_STARTED_FILE, String(process.pid));
setTimeout(() => writeFileSync(process.env.LOBSTER_TERMINAL_DIRECT_COMPLETED_FILE, "completed"), 700);`,
	],
	env: process.env,
	notFoundMessage: "node missing",
});
