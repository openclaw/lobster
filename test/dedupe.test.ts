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

test('dedupe removes duplicate primitives (stable)', async () => {
  const out = await run('dedupe', [1, 2, 1, 3, 2]);
  assert.deepEqual(out, [1, 2, 3]);
});

test('dedupe supports --key', async () => {
  const input = [
    { id: 'a', v: 1 },
    { id: 'b', v: 2 },
    { id: 'a', v: 3 },
  ];
  const out = await run('dedupe --key id', input);
  assert.deepEqual(out, [input[0], input[1]]);
});

test('dedupe treats undefined keys as a key value', async () => {
  const input = [
    { id: undefined, v: 1 },
    { id: undefined, v: 2 },
    { id: 'x', v: 3 },
  ];
  const out = await run('dedupe --key id', input);
  assert.equal(out.length, 2);
  assert.equal(out[0].v, 1);
  assert.equal(out[1].v, 3);
});
