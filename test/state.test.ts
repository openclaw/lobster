import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { createDefaultRegistry } from '../src/commands/registry.js';
import { runPipeline } from '../src/runtime.js';

function streamOf(items) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test('state.set writes and state.get reads', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-state-'));
  const registry = createDefaultRegistry();

  const env = { ...process.env, LOBSTER_STATE_DIR: tmp };

  // write
  const setCmd = registry.get('state.set');
  await setCmd.run({
    input: streamOf([{ a: 1 }]),
    args: { _: ['demo-key'] },
    ctx: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env, registry, mode: 'tool', render: { json() {}, lines() {} } },
  });

  // read
  const getCmd = registry.get('state.get');
  const res = await getCmd.run({
    input: streamOf([]),
    args: { _: ['demo-key'] },
    ctx: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env, registry, mode: 'tool', render: { json() {}, lines() {} } },
  });

  const items = [];
  for await (const it of res.output) items.push(it);
  assert.deepEqual(items, [{ a: 1 }]);
});

test('state.get returns null for missing key', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-state-'));
  const registry = createDefaultRegistry();
  const env = { ...process.env, LOBSTER_STATE_DIR: tmp };

  const output = await runPipeline({
    pipeline: [{ name: 'state.get', args: { _: ['missing'] }, raw: 'state.get missing' }],
    registry,
    input: [],
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env,
    mode: 'tool',
  });

  assert.deepEqual(output.items, [null]);
});
