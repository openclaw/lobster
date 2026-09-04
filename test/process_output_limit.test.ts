import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { exec } from "../src/sdk/primitives/exec.js";
import { runWorkflowFile } from "../src/workflows/file.js";

const OVER_LIMIT_BYTES = 10 * 1024 * 1024 + 1;
const FLOOD_SCRIPT = `process.stdout.write('x'.repeat(${OVER_LIMIT_BYTES}))`;

function streamOf(items: unknown[]) {
	return (async function* () {
		for (const item of items) yield item;
	})();
}

function execCtx(registry: ReturnType<typeof createDefaultRegistry>) {
	return {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		env: process.env,
		registry,
		mode: "human" as const,
		render: { json() {}, lines() {} },
	};
}

test("exec rejects a child that floods stdout past 10 MiB", async () => {
	const registry = createDefaultRegistry();
	const cmd = registry.get("exec");

	await assert.rejects(
		cmd.run({
			input: streamOf([]),
			args: { _: [process.execPath, "-e", FLOOD_SCRIPT] },
			ctx: execCtx(registry),
		}),
		/Process output exceeded 10485760 bytes/,
	);
});

test("workflow run step rejects a child that floods stdout past 10 MiB", async () => {
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-output-limit-"));
	try {
		const filePath = path.join(tmpDir, "workflow.lobster");
		await fsp.writeFile(
			filePath,
			JSON.stringify(
				{
					name: "flood",
					steps: [
						{
							id: "flood",
							run: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(FLOOD_SCRIPT)}`,
						},
					],
				},
				null,
				2,
			),
			"utf8",
		);

		await assert.rejects(
			runWorkflowFile({
				filePath,
				ctx: {
					stdin: process.stdin,
					stdout: process.stdout,
					stderr: process.stderr,
					env: { ...process.env, LOBSTER_STATE_DIR: path.join(tmpDir, "state") },
					mode: "tool",
				},
			}),
			/Process output exceeded 10485760 bytes/,
		);
	} finally {
		await fsp.rm(tmpDir, { recursive: true, force: true });
	}
});

test("sdk exec rejects a child that floods stdout past 10 MiB", async () => {
	const quoted = [process.execPath, "-e", FLOOD_SCRIPT]
		.map((part) => `"${part.replaceAll('"', '\\"')}"`)
		.join(" ");
	const stage = exec(quoted, { json: false });

	await assert.rejects(
		stage.run({
			input: streamOf([]),
			ctx: { env: process.env },
		}),
		/Process output exceeded 10485760 bytes/,
	);
});
