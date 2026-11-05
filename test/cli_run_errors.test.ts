import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const targetForms = {
	"--file": (target: string) => ["--file", target],
	positional: (target: string) => [target],
	"positional --dry-run": (target: string) => [target, "--dry-run"],
};

for (const [form, targetArgs] of Object.entries(targetForms)) {
	for (const kind of ["missing", "directory", "extension"] as const) {
		test(`tool run reports ${kind} ${form} workflow target errors as JSON`, async () => {
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
					["bin/lobster.js", "run", "--mode", "tool", ...targetArgs(target)],
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
}

test("human run reports a missing relative positional workflow as a parse error", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-positional-error-"));
	try {
		const result = spawnSync(
			process.execPath,
			[resolve("bin/lobster.js"), "run", "missing.lobster"],
			{ cwd: dir, encoding: "utf8" },
		);
		assert.equal(result.status, 2);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /^Parse error: .*ENOENT/);
		assert.doesNotMatch(result.stderr, /Unknown command/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

for (const token of ["llm.invok", "--unknown=flows/data.json"]) {
	test(`run still reports ${token} as an unknown command`, () => {
		const result = spawnSync(process.execPath, ["bin/lobster.js", "run", "--mode", "tool", token], {
			encoding: "utf8",
		});
		assert.equal(result.status, 1);
		const envelope = JSON.parse(result.stdout);
		assert.equal(envelope.error.type, "runtime_error");
		assert.equal(envelope.error.message, `Unknown command: ${token}`);
	});
}

test("run keeps a quoted pipeline with path-like arguments as a pipeline", () => {
	const result = spawnSync(
		process.execPath,
		[
			"bin/lobster.js",
			"run",
			"--mode",
			"tool",
			'exec --json node -e "console.log(JSON.stringify(process.argv.slice(1)))" flows/data.json',
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	const envelope = JSON.parse(result.stdout);
	assert.equal(envelope.ok, true);
	assert.deepEqual(envelope.output, ["flows/data.json"]);
});

test("run keeps a quoted pipeline with --dry-run as a pipeline", () => {
	const result = spawnSync(
		process.execPath,
		["bin/lobster.js", "run", "--mode", "tool", "a/b|json", "--dry-run"],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 1);
	const envelope = JSON.parse(result.stdout);
	assert.equal(envelope.error.type, "runtime_error");
	assert.equal(envelope.error.message, "Unknown command: a/b");
});

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

test("help graph shows the graph help listed under Commands", () => {
	const result = spawnSync(process.execPath, ["bin/lobster.js", "help", "graph"], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0);
	assert.match(result.stdout, /--format\s+Output format: mermaid \(default\), dot, ascii/);
	assert.equal(result.stderr, "");
});
