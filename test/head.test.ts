import test from "node:test";
import assert from "node:assert/strict";

import { runPipeline } from "../src/runtime.js";
import { createDefaultRegistry } from "../src/commands/registry.js";
import { parsePipeline } from "../src/parser.js";

async function run(text: string, input: AsyncIterable<unknown> | unknown[]) {
	const result = await runPipeline({
		pipeline: parsePipeline(text),
		registry: createDefaultRegistry(),
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		env: process.env,
		mode: "tool",
		input,
	});
	return result.items;
}

for (const n of [0, 1, 3, 10]) {
	test(`head --n ${n} never requests an item beyond its limit`, async () => {
		let reads = 0;
		let closed = false;
		const input = (async function* () {
			try {
				for (let i = 0; i < n; i++) {
					reads++;
					yield i;
				}
				reads++;
				throw new Error("read beyond requested limit");
			} finally {
				closed = true;
			}
		})();

		assert.deepEqual(
			await run(`head --n ${n}`, input),
			Array.from({ length: n }, (_, i) => i),
		);
		assert.equal(reads, n);
		// Zero must not even start the generator; positive limits close it early.
		assert.equal(closed, n > 0);
	});
}

test("head closes upstream lazy stages at the requested boundary", async () => {
	let closed = false;
	const input = (async function* () {
		try {
			yield { id: 1 };
			throw new Error("upstream was read twice");
		} finally {
			closed = true;
		}
	})();
	assert.deepEqual(await run("pick id | head --n 1 | map --unwrap id", input), [1]);
	assert.equal(closed, true);
});

test("head handles empty, short, and default-length input", async () => {
	assert.deepEqual(await run("head", []), []);
	assert.deepEqual(await run("head --n 5", [1, 2]), [1, 2]);
	assert.deepEqual(
		await run(
			"head",
			Array.from({ length: 12 }, (_, i) => i),
		),
		Array.from({ length: 10 }, (_, i) => i),
	);
});
