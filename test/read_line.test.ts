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
