import test from 'node:test';
import assert from 'node:assert/strict';

import { runPipeline } from '../src/runtime.js';
import { createDefaultRegistry } from '../src/commands/registry.js';
import { parsePipeline } from '../src/parser.js';
import { applyFilters, parseFilterExpression } from '../src/core/filters.js';

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
    mode: 'tool',
    input: (async function* () { for (const x of input) yield x; })(),
  });
  return res.items;
}

// --- Filter unit tests ---

test('parseFilterExpression parses simple filter', () => {
  assert.deepEqual(parseFilterExpression('upper'), ['upper']);
});

test('parseFilterExpression parses filter with arg', () => {
  assert.deepEqual(parseFilterExpression('truncate 80'), ['truncate', '80']);
});

test('parseFilterExpression parses filter with quoted args', () => {
  assert.deepEqual(parseFilterExpression('replace "-" "_"'), ['replace', '-', '_']);
});

test('applyFilters upper', () => {
  assert.equal(applyFilters('hello', ['upper']), 'HELLO');
});

test('applyFilters lower', () => {
  assert.equal(applyFilters('HELLO', ['lower']), 'hello');
});

test('applyFilters trim', () => {
  assert.equal(applyFilters('  hi  ', ['trim']), 'hi');
});

test('applyFilters truncate', () => {
  assert.equal(applyFilters('hello world', ['truncate 5']), 'hello...');
});

test('applyFilters truncate no-op when short', () => {
  assert.equal(applyFilters('hi', ['truncate 5']), 'hi');
});

test('applyFilters replace', () => {
  assert.equal(applyFilters('a-b-c', ['replace "-" "_"']), 'a_b_c');
});

test('applyFilters split', () => {
  assert.deepEqual(applyFilters('a,b,c', ['split ","']), ['a', 'b', 'c']);
});

test('applyFilters first', () => {
  assert.equal(applyFilters([1, 2, 3], ['first']), 1);
});

test('applyFilters last', () => {
  assert.equal(applyFilters([1, 2, 3], ['last']), 3);
});

test('applyFilters length on array', () => {
  assert.equal(applyFilters([1, 2, 3], ['length']), 3);
});

test('applyFilters length on string', () => {
  assert.equal(applyFilters('hello', ['length']), 5);
});

test('applyFilters join', () => {
  assert.equal(applyFilters(['a', 'b', 'c'], ['join ", "']), 'a, b, c');
});

test('applyFilters json', () => {
  assert.equal(applyFilters({ a: 1 }, ['json']), JSON.stringify({ a: 1 }, null, 2));
});

test('applyFilters default with null', () => {
  assert.equal(applyFilters(null, ['default "N/A"']), 'N/A');
});

test('applyFilters default with value', () => {
  assert.equal(applyFilters('ok', ['default "N/A"']), 'ok');
});

test('applyFilters round', () => {
  assert.equal(applyFilters(3.14159, ['round 2']), 3.14);
});

test('applyFilters chain', () => {
  assert.equal(applyFilters('  Hello World  ', ['trim', 'upper']), 'HELLO WORLD');
});

test('applyFilters unknown filter throws', () => {
  assert.throws(() => applyFilters('x', ['nonexistent']), /Unknown template filter/);
});

// --- Template integration tests ---

test('template with upper filter', async () => {
  const out = await run("template --text '{{name | upper}}'", [{ name: 'alice' }]);
  assert.deepEqual(out, ['ALICE']);
});

test('template with length filter', async () => {
  const out = await run("template --text '{{items | length}}'", [{ items: [1, 2, 3] }]);
  assert.deepEqual(out, ['3']);
});

test('template with default filter', async () => {
  const out = await run("template --text '{{missing | default \"N/A\"}}'", [{ other: 1 }]);
  assert.deepEqual(out, ['N/A']);
});

test('template with chained filters', async () => {
  const out = await run("template --text '{{name | trim | upper}}'", [{ name: '  bob  ' }]);
  assert.deepEqual(out, ['BOB']);
});

test('template without filters still works', async () => {
  const out = await run("template --text 'hi {{name}}'", [{ name: 'v' }]);
  assert.deepEqual(out, ['hi v']);
});

test('template with join filter', async () => {
  const out = await run("template --text '{{tags | join \", \"}}'", [{ tags: ['a', 'b', 'c'] }]);
  assert.deepEqual(out, ['a, b, c']);
});
