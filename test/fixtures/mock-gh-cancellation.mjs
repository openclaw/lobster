#!/usr/bin/env node
import { writeFileSync } from "node:fs";

function mark(path, value) {
	if (path) writeFileSync(path, value, "utf8");
}

process.once("SIGTERM", () => {
	mark(process.env.MOCK_GH_TERMINATED_FILE, "SIGTERM");
	process.exit(143);
});
mark(process.env.MOCK_GH_STARTED_FILE, String(process.pid));
setTimeout(() => {
	mark(process.env.MOCK_GH_COMPLETED_FILE, "completed");
	process.stdout.write(
		JSON.stringify({
			number: 1,
			title: "Fixture PR",
			url: "https://example.invalid/pr/1",
			state: "OPEN",
			isDraft: false,
			mergeable: "MERGEABLE",
			reviewDecision: "",
			updatedAt: "2026-07-11T00:00:00Z",
			baseRefName: "main",
			headRefName: "fixture",
		}),
	);
}, 1200);
