import test from "node:test";
import assert from "node:assert/strict";

import { parsePipeline } from "../src/parser.js";
import { runPipeline } from "../src/runtime.js";
import { createDefaultRegistry } from "../src/commands/registry.js";
import { applyFilters, parseFilterExpression } from "../src/core/filters.js";

async function run(pipelineText: string, input: any[]) {
  const pipeline = parsePipeline(pipelineText);
  const registry = createDefaultRegistry();
  const res = await runPipeline({
    pipeline,
    registry,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: "tool",
    input: (async function* () {
      for (const x of input) yield x;
    })(),
  });
  return res.items;
}

test("parseFilterExpression parses simple filter", () => {
  assert.deepEqual(parseFilterExpression("upper"), ["upper"]);
});

test("parseFilterExpression parses filter args", () => {
  assert.deepEqual(parseFilterExpression("truncate 80"), ["truncate", "80"]);
});

test("parseFilterExpression parses quoted args", () => {
  assert.deepEqual(parseFilterExpression('replace "-" "_"'), ["replace", "-", "_"]);
});

test("applyFilters upper", () => {
  assert.equal(applyFilters("hello", ["upper"]), "HELLO");
});

test("applyFilters lower", () => {
  assert.equal(applyFilters("HELLO", ["lower"]), "hello");
});

test("applyFilters trim", () => {
  assert.equal(applyFilters("  hi  ", ["trim"]), "hi");
});

test("applyFilters truncate", () => {
  assert.equal(applyFilters("hello world", ["truncate 5"]), "hello...");
});

test("applyFilters replace", () => {
  assert.equal(applyFilters("a-b-c", ['replace "-" "_"']), "a_b_c");
});

test("applyFilters split", () => {
  assert.deepEqual(applyFilters("a,b,c", ['split ","']), ["a", "b", "c"]);
});

test("applyFilters first/last", () => {
  assert.equal(applyFilters([1, 2, 3], ["first"]), 1);
  assert.equal(applyFilters([1, 2, 3], ["last"]), 3);
});

test("applyFilters length on array and string", () => {
  assert.equal(applyFilters([1, 2, 3], ["length"]), 3);
  assert.equal(applyFilters("hello", ["length"]), 5);
});

test("applyFilters join", () => {
  assert.equal(applyFilters(["a", "b", "c"], ['join ", "']), "a, b, c");
});

test("applyFilters json/default/round", () => {
  assert.equal(applyFilters({ a: 1 }, ["json"]), JSON.stringify({ a: 1 }, null, 2));
  assert.equal(applyFilters(null, ['default "N/A"']), "N/A");
  assert.equal(applyFilters("ok", ['default "N/A"']), "ok");
  assert.equal(applyFilters(3.14159, ["round 2"]), 3.14);
});

test("applyFilters chain", () => {
  assert.equal(applyFilters("  Hello World  ", ["trim", "upper"]), "HELLO WORLD");
});

test("applyFilters date formatting is UTC-stable", () => {
  const result = applyFilters(1710000000000, ['date "YYYY-MM-DD"']);
  assert.equal(result, "2024-03-09");
});

test("applyFilters unknown filter throws", () => {
  assert.throws(() => applyFilters("x", ["nonexistent"]), /Unknown template filter/);
});

test("template filter integration: upper", async () => {
  const out = await run("template --text '{{name | upper}}'", [{ name: "alice" }]);
  assert.deepEqual(out, ["ALICE"]);
});

test("template filter integration: length", async () => {
  const out = await run("template --text '{{items | length}}'", [{ items: [1, 2, 3] }]);
  assert.deepEqual(out, ["3"]);
});

test("template filter integration: default", async () => {
  const out = await run("template --text '{{missing | default \"N/A\"}}'", [{ other: 1 }]);
  assert.deepEqual(out, ["N/A"]);
});

test("template filter integration: chained", async () => {
  const out = await run("template --text '{{name | trim | upper}}'", [{ name: "  bob  " }]);
  assert.deepEqual(out, ["BOB"]);
});

test("template integration without filters remains unchanged", async () => {
  const out = await run("template --text 'hi {{name}}'", [{ name: "v" }]);
  assert.deepEqual(out, ["hi v"]);
});

test("template filter integration: join", async () => {
  const out = await run("template --text '{{tags | join \", \"}}'", [{ tags: ["a", "b", "c"] }]);
  assert.deepEqual(out, ["a, b, c"]);
});

test("template filter splitter handles quoted pipe characters", async () => {
  const out = await run("template --text '{{line | split \"|\" | first}}'", [{ line: "a|b|c" }]);
  assert.deepEqual(out, ["a"]);
});
