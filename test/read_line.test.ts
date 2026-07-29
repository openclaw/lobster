import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { EventEmitter } from "node:events";
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

test("readLineFromStream returns buffered input after a child pipe reaches EOF", async () => {
	const child = spawn(process.execPath, ["-e", "process.stdout.write('yes\\npartial')"], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	assert.ok(child.stdout);

	const first = readLineFromStream(child.stdout);
	assert.equal(await first, "yes");
	await once(child, "close");
	assert.equal(await readLineFromStream(child.stdout, { timeoutMs: 50 }), "partial");
});

test("readLineFromStream drains a buffer that remains readable after EOF", async () => {
	let buffered: Buffer | null = Buffer.from("partial");
	const input = Object.assign(new EventEmitter(), {
		readableEnded: true,
		closed: true,
		read() {
			const value = buffered;
			buffered = null;
			return value;
		},
		pause() {},
		resume() {},
	}) as unknown as NodeJS.ReadableStream;

	assert.equal(await readLineFromStream(input), "partial");
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
