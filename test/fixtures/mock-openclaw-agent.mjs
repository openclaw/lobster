import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const writeResponse = () => {
	process.stdout.write(
		JSON.stringify({
			runId: "fixture-run",
			status: "ok",
			result: { payloads: [{ text: "fixture reply" }] },
		}),
	);
};

if (process.argv.includes("--spawn-descendant")) {
	const helper = spawn(
		process.execPath,
		[
			"-e",
			`const { writeFileSync } = require("node:fs");
process.once("SIGTERM", () => {});
writeFileSync(process.env.MOCK_OPENCLAW_AGENT_DESCENDANT_STARTED_FILE, String(process.pid));
setTimeout(() => writeFileSync(process.env.MOCK_OPENCLAW_AGENT_DESCENDANT_COMPLETED_FILE, "completed"), 650);`,
		],
		{ env: process.env, stdio: "ignore" },
	);
	helper.unref();
}

if (process.argv.includes("--sleep")) {
	setTimeout(writeResponse, 10_000);
} else {
	writeResponse();
}
