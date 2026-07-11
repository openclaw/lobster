#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);

function mark(path, value) {
	if (path) writeFileSync(path, value, "utf8");
}

function waitForCompletion({ startedFile, terminatedFile, completedFile, output }) {
	process.once("SIGTERM", () => {
		mark(terminatedFile, "SIGTERM");
		process.exit(143);
	});
	mark(startedFile, String(process.pid));
	setTimeout(() => {
		mark(completedFile, "completed");
		process.stdout.write(JSON.stringify(output));
	}, 1200);
}

if (argv[0] === "gmail" && argv[1] === "search") {
	waitForCompletion({
		startedFile: process.env.MOCK_GOG_SEARCH_STARTED_FILE,
		terminatedFile: process.env.MOCK_GOG_SEARCH_TERMINATED_FILE,
		completedFile: process.env.MOCK_GOG_SEARCH_COMPLETED_FILE,
		output: [{ to: "user@example.com", subject: "Reply", body: "Hello" }],
	});
} else if (argv[0] === "gmail" && argv[1] === "send") {
	waitForCompletion({
		startedFile: process.env.MOCK_GOG_SEND_STARTED_FILE,
		terminatedFile: process.env.MOCK_GOG_SEND_TERMINATED_FILE,
		completedFile: process.env.MOCK_GOG_SEND_COMPLETED_FILE,
		output: { ok: true },
	});
} else {
	process.stderr.write(`mock-gog-cancellation: unsupported args: ${argv.join(" ")}\n`);
	process.exit(2);
}
