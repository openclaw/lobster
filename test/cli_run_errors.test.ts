import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

for (const kind of ["missing", "directory", "extension"] as const) {
	test(`tool run reports ${kind} workflow target errors as JSON`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "lobster-target-error-"));
		try {
			const target =
				kind === "directory"
					? dir
					: join(dir, kind === "extension" ? "workflow.txt" : "missing.lobster");
			if (kind === "extension")
				await writeFile(target, JSON.stringify({ steps: [{ id: "ok", run: "echo ok" }] }));
			const result = spawnSync(
				process.execPath,
				["bin/lobster.js", "run", "--mode", "tool", "--file", target],
				{ encoding: "utf8" },
			);
			assert.equal(result.status, 2);
			const envelope = JSON.parse(result.stdout);
			assert.equal(envelope.protocolVersion, 1);
			assert.equal(envelope.ok, false);
			assert.equal(envelope.error.type, "parse_error");
			assert.match(
				envelope.error.message,
				kind === "missing" ? /ENOENT/ : kind === "directory" ? /not a file/ : /must end in/,
			);
			assert.equal(result.stderr, "");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}

test("human run reports missing workflow without an uncaught stack", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-human-error-"));
	try {
		const result = spawnSync(
			process.execPath,
			["bin/lobster.js", "run", "--file", join(dir, "missing.json")],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 2);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /^Parse error: .*ENOENT/);
		assert.doesNotMatch(result.stderr, /at async|node:internal/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

for (const flag of ["--help", "-h"]) {
	test(`graph ${flag} shows graph-specific options`, () => {
		const result = spawnSync(process.execPath, ["bin/lobster.js", "graph", flag], {
			encoding: "utf8",
		});
		assert.equal(result.status, 0);
		assert.match(result.stdout, /--format\s+Output format: mermaid \(default\), dot, ascii/);
		assert.equal(result.stderr, "");
	});
}
