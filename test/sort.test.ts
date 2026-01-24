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

test('sort sorts primitives ascending by default', async () => {
  const out = await run('sort', [3, 1, 2]);
  assert.deepEqual(out, [1, 2, 3]);
});

test('sort supports --desc', async () => {
  const out = await run('sort --desc', ["b", "a", "c"]);
  assert.deepEqual(out, ["c", "b", "a"]);
});

test('sort sorts objects by --key and is stable', async () => {
  const input = [
    { id: 'a', k: 2 },
    { id: 'b', k: 1 },
    { id: 'c', k: 2 },
  ];
  const out = await run('sort --key k', input);
  assert.deepEqual(out.map((x: any) => x.id), ['b', 'a', 'c']);
});

test('sort places undefined/null last', async () => {
  const input = [
    { id: 'a', k: undefined },
    { id: 'b', k: 2 },
    { id: 'c', k: null },
    { id: 'd', k: 1 },
  ];
  const out = await run('sort --key k', input);
  assert.deepEqual(out.map((x: any) => x.id), ['d', 'b', 'a', 'c']);
});
