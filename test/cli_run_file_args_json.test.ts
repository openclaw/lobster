import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

function runLobster(args: string[], opts?: { env?: Record<string, string | undefined> }) {
	const res = spawnSync(process.execPath, [path.join("bin", "lobster.js"), ...args], {
		cwd: path.resolve("."),
		env: { ...process.env, ...(opts?.env ?? undefined) },
		encoding: "utf8",
	});
	return res;
}

test("cli: run --file passes --args-json into workflow args", async () => {
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cli-"));
	const filePath = path.join(tmpDir, "workflow.lobster");

	// Print both template-substituted arg and env-injected arg (LOBSTER_ARG_TASK)
	// so we catch regressions in either path.
	const workflow = `name: test\nargs:\n  task:\n    default: ""\nsteps:\n  - id: s\n    command: >\n      node -e "process.stdout.write(JSON.stringify({task: '\${task}', env: process.env.LOBSTER_ARG_TASK}))"\n`;

	await fsp.writeFile(filePath, workflow, "utf8");

	const res = runLobster(["run", "--file", filePath, "--args-json", '{"task":"test"}']);

	assert.equal(
		res.status,
		0,
		`expected exit 0, got ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
	);

	const parsed = JSON.parse(String(res.stdout).trim());
	assert.deepEqual(parsed, [{ task: "test", env: "test" }]);
});

const nonObjectArgsJson = ["null", "[1,2]", '["production"]', '"production"', "7", "true"];
const emptyArgsJsonForms = [["--args-json="], ["--args-json", ""], ["--args-json"]];

test("cli: run --file rejects a non-object --args-json before any step runs", async () => {
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cli-"));
	const filePath = path.join(tmpDir, "workflow.lobster");
	const markerPath = path.join(tmpDir, "ran");
	const workflow = `name: test\nargs:\n  target:\n    default: staging\nsteps:\n  - id: s\n    run: touch "${markerPath}"\n`;
	await fsp.writeFile(filePath, workflow, "utf8");

	for (const argsJson of nonObjectArgsJson) {
		const human = runLobster(["run", "--file", filePath, "--args-json", argsJson]);
		assert.equal(human.status, 2, `human exit for ${argsJson}: ${human.stderr}`);
		assert.equal(human.stderr, "run --args-json must be a JSON object\n");
		assert.equal(human.stdout, "");

		const tool = runLobster(["run", "--mode", "tool", filePath, "--args-json", argsJson]);
		assert.equal(tool.status, 2, `tool exit for ${argsJson}: ${tool.stdout}`);
		assert.deepEqual(JSON.parse(tool.stdout).error, {
			type: "parse_error",
			message: "run --args-json must be a JSON object",
		});
	}

	for (const emptyArgs of emptyArgsJsonForms) {
		const res = runLobster(["run", "--file", filePath, ...emptyArgs]);
		assert.equal(res.status, 2, `exit for ${emptyArgs.join(" ")}: ${res.stderr}`);
		assert.equal(res.stderr, "run --args-json must be valid JSON\n");
	}

	await assert.rejects(fsp.stat(markerPath), { code: "ENOENT" });
});

test("cli: workflows.run rejects a non-object --args-json", () => {
	for (const argsJson of nonObjectArgsJson) {
		const res = runLobster([
			"run",
			"--mode",
			"tool",
			`workflows.run --name github.pr.monitor --args-json '${argsJson}'`,
		]);
		assert.equal(res.status, 1, `exit for ${argsJson}: ${res.stdout}`);
		assert.equal(
			JSON.parse(res.stdout).error.message,
			"workflows.run --args-json must be a JSON object",
		);
	}

	const empty = runLobster([
		"run",
		"--mode",
		"tool",
		`workflows.run --name github.pr.monitor --args-json ''`,
	]);
	assert.equal(
		JSON.parse(empty.stdout).error.message,
		"workflows.run --args-json must be valid JSON",
	);
});

test("cli: graph rejects invalid, empty and non-object --args-json", async () => {
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cli-"));
	const filePath = path.join(tmpDir, "workflow.lobster");
	await fsp.writeFile(filePath, "name: test\nsteps:\n  - id: s\n    run: echo hi\n", "utf8");

	const invalid = runLobster(["graph", "--file", filePath, "--args-json", "nope"]);
	assert.equal(invalid.status, 2);
	assert.equal(invalid.stderr, "graph --args-json must be valid JSON\n");

	for (const emptyArgs of emptyArgsJsonForms) {
		const res = runLobster(["graph", "--file", filePath, ...emptyArgs]);
		assert.equal(res.status, 2, `exit for ${emptyArgs.join(" ")}: ${res.stderr}`);
		assert.equal(res.stderr, "graph --args-json must be valid JSON\n");
	}

	for (const argsJson of nonObjectArgsJson) {
		const res = runLobster(["graph", "--file", filePath, "--args-json", argsJson]);
		assert.equal(res.status, 2, `exit for ${argsJson}: ${res.stderr}`);
		assert.equal(res.stderr, "graph --args-json must be a JSON object\n");
	}
});
