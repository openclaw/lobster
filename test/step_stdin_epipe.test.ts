import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { runWorkflowFile } from "../src/workflows/file.js";

async function runWorkflow(workflow: unknown) {
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-stdin-epipe-"));
	const stateDir = path.join(tmpDir, "state");
	const filePath = path.join(tmpDir, "workflow.lobster");
	await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

	return runWorkflowFile({
		filePath,
		ctx: {
			stdin: process.stdin,
			stdout: process.stdout,
			stderr: process.stderr,
			env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
			mode: "tool",
			registry: createDefaultRegistry(),
		},
	});
}

test("a step that exits before draining large stdin fails cleanly instead of crashing", async () => {
	// 300KB exceeds the OS pipe buffer (64KB on Linux), so the write to the
	// second step's stdin is still pending when that step exits without reading.
	// Before the EPIPE guard, this crashed the engine instead of reporting the
	// step failure.
	await assert.rejects(
		() =>
			runWorkflow({
				steps: [
					{
						id: "big",
						command: "node -e \"process.stdout.write('x'.repeat(300000))\"",
					},
					{
						id: "fast_fail",
						command: 'node -e "process.exit(1)"',
						stdin: "$big.stdout",
					},
				],
			}),
		/workflow command failed \(1\)/,
	);
});
