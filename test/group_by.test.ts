import test from 'node:test';
import assert from 'node:assert/strict';

import { runPipeline } from '../src/runtime.js';
import { createDefaultRegistry } from '../src/commands/registry.js';
import { parsePipeline } from '../src/parser.js';

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

test('groupBy groups items by key and preserves group order', async () => {
  const input = [
    { from: 'a', id: 1 },
    { from: 'b', id: 2 },
    { from: 'a', id: 3 },
  ];
  const out = await run('groupBy --key from', input);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].key, 'a');
  assert.deepEqual(out[0].items.map((x: any) => x.id), [1, 3]);
  assert.equal(out[0].count, 2);
  assert.deepEqual(out[1].key, 'b');
});

test('groupBy supports nested key paths', async () => {
  const input = [
    { user: { id: 'u1' } },
    { user: { id: 'u2' } },
    { user: { id: 'u1' } },
  ];
  const out = await run('groupBy --key user.id', input);
  assert.deepEqual(out.map((g: any) => g.key), ['u1', 'u2']);
  assert.equal(out[0].count, 2);
});
