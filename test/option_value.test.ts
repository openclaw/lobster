import test from "node:test";
import assert from "node:assert/strict";

import { runPipeline } from "../src/runtime.js";
import { createDefaultRegistry } from "../src/commands/registry.js";
import { parsePipeline } from "../src/parser.js";

async function run(text: string) {
	const result = await runPipeline({
		pipeline: parsePipeline(text),
		registry: createDefaultRegistry(),
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		env: process.env,
		mode: "tool",
		input: [{ a: 2 }, { a: 1 }, { a: 1 }],
	});
	return result.items;
}

for (const [command, option] of [
	["head", "n"],
	["groupBy", "key"],
	["sort", "key"],
	["dedupe", "key"],
	["map", "wrap"],
	["map", "unwrap"],
]) {
	for (const form of [`--${option}`, `--${option}=`, `--${option} ""`, `--${option} --other`]) {
		test(`${command} ${form} requires a value`, async () => {
			await assert.rejects(run(`${command} ${form}`), {
				message: `${command} --${option} requires a value`,
			});
		});
	}
}

test("value options with a value keep working", async () => {
	assert.deepEqual(await run("head --n 1"), [{ a: 2 }]);
	assert.deepEqual(await run("dedupe --key a | sort --key a | map --unwrap a"), [1, 2]);
	assert.deepEqual(
		(await run("groupBy --key a")).map((g: any) => [g.key, g.count]),
		[
			[2, 1],
			[1, 2],
		],
	);
});
