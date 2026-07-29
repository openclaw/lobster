import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { readLineFromStream } from "../src/read_line.js";

test("readLineFromStream resolves on newline", async () => {
	const input = new PassThrough();
	const promise = readLineFromStream(input);
	input.write("yes\n");
	input.end();

	const value = await promise;
	assert.equal(value, "yes");
});

test("readLineFromStream accepts sequential reads from one stream", async () => {
	const input = new PassThrough();
	const first = readLineFromStream(input);
	input.write("yes\n");
	assert.equal(await first, "yes");

	const second = readLineFromStream(input, { timeoutMs: 50 });
	input.write("no\n");
	assert.equal(await second, "no");
	input.end();
});

test("readLineFromStream preserves the next line from a combined input chunk", async () => {
	const input = new PassThrough();
	const first = readLineFromStream(input);
	input.end("yes\nno\n");
	assert.equal(await first, "yes");
	assert.equal(await readLineFromStream(input), "no");
});

test("readLineFromStream resolves on end without newline", async () => {
	const input = new PassThrough();
	const promise = readLineFromStream(input);
	input.write("partial");
	input.end();

	const value = await promise;
	assert.equal(value, "partial");
});

test("readLineFromStream times out when no input arrives", async () => {
	const input = new PassThrough();
	await assert.rejects(
		() => readLineFromStream(input, { timeoutMs: 5 }),
		/Timed out waiting for input/,
	);
});

test("readLineFromStream rejects when its signal is aborted", async () => {
	const input = new PassThrough();
	const controller = new AbortController();
	const promise = readLineFromStream(input, { signal: controller.signal });
	controller.abort(new Error("input cancelled"));

	await assert.rejects(() => promise, /input cancelled/);
	assert.equal(input.readableFlowing, false);
	input.end();
});
