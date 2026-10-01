import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { resumeToolRequest, runToolRequest } from "../src/core/index.js";

const source = 'exec --json node -e "process.stdout.write(JSON.stringify([1,2,3]))"';

function runCli(args: string[], env = process.env) {
	const result = spawnSync(process.execPath, ["bin/lobster.js", ...args], {
		encoding: "utf8",
		env,
		timeout: 10_000,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	return result.stdout;
}

for (const renderer of ["json", "table"]) {
	for (const limit of [0, 2]) {
		test(`CLI tool ${renderer} returns one envelope for ${limit} items`, () => {
			const envelope = JSON.parse(
				runCli(["run", "--mode", "tool", `${source} | head --n ${limit} | ${renderer}`]),
			);
			assert.equal(envelope.ok, true);
			assert.deepEqual(envelope.output, [1, 2].slice(0, limit));
		});
	}

	test(`core tool ${renderer} preserves typed items for downstream commands`, async () => {
		let written = "";
		const stdout = new Writable({
			write(chunk, _encoding, callback) {
				written += chunk;
				callback();
			},
		});
		const envelope = await runToolRequest({
			pipeline: `${source} | ${renderer} | head --n 1`,
			ctx: { stdout },
		});
		assert.equal(envelope.ok, true);
		assert.deepEqual(envelope.output, [1]);
		assert.equal(written, "");
	});

	test(`CLI approval resume with ${renderer} returns one envelope`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "lobster-render-resume-"));
		try {
			const env = { ...process.env, LOBSTER_STATE_DIR: directory };
			const paused = JSON.parse(
				runCli(["run", "--mode", "tool", `${source} | approve --emit | ${renderer}`], env),
			);
			assert.equal(paused.status, "needs_approval");
			const resumed = JSON.parse(
				runCli(["resume", "--token", paused.requiresApproval.resumeToken, "--approve", "yes"], env),
			);
			assert.equal(resumed.ok, true);
			assert.deepEqual(resumed.output, [1, 2, 3]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test(`core input resume with ${renderer} preserves the response`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "lobster-render-input-"));
		try {
			const ctx = { env: { ...process.env, LOBSTER_STATE_DIR: directory } };
			const paused = await runToolRequest({ pipeline: `ask --prompt Input | ${renderer}`, ctx });
			assert.equal(paused.status, "needs_input");
			const resumed = await resumeToolRequest({
				token: paused.requiresInput?.resumeToken,
				response: { decision: "approve" },
				ctx,
			});
			assert.equal(resumed.ok, true);
			assert.deepEqual(resumed.output, [{ decision: "approve" }]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test(`human ${renderer} still renders terminal output`, () => {
		const output = runCli(["run", `${source} | ${renderer}`]);
		if (renderer === "json") assert.deepEqual(JSON.parse(output), [1, 2, 3]);
		else assert.equal(output, "1\n2\n3\n");
	});
}

test("workflow tool steps keep captured renderer output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "lobster-render-workflow-"));
	try {
		const filePath = join(directory, "render.lobster");
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "render", pipeline: `${source} | head --n 1 | json` },
					{
						id: "inspect",
						run: 'node -e "process.stdout.write(JSON.stringify({captured:process.env.CAPTURED}))"',
						env: { CAPTURED: "$render.json" },
					},
				],
			}),
		);
		const result = await runToolRequest({ filePath });
		assert.equal(result.ok, true);
		assert.deepEqual(result.output, [{ captured: "[1]" }]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
