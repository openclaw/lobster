import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { createDefaultRegistry } from '../src/commands/registry.js';

function streamOf(items) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test('diff.last reports changed on first run and not changed on same input', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-diff-'));
  const env = { ...process.env, LOBSTER_STATE_DIR: tmp };
  const registry = createDefaultRegistry();
  const cmd = registry.get('diff.last');

  const first = await cmd.run({
    input: streamOf([{ a: 1 }]),
    args: { _: [], key: 'k' },
    ctx: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env, registry, mode: 'tool', render: { json() {}, lines() {} } },
  });
  const out1 = [];
  for await (const it of first.output) out1.push(it);
  assert.equal(out1[0].changed, true);

  const second = await cmd.run({
    input: streamOf([{ a: 1 }]),
    args: { _: [], key: 'k' },
    ctx: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env, registry, mode: 'tool', render: { json() {}, lines() {} } },
  });
  const out2 = [];
  for await (const it of second.output) out2.push(it);
  assert.equal(out2[0].changed, false);

  const third = await cmd.run({
    input: streamOf([{ a: 2 }]),
    args: { _: [], key: 'k' },
    ctx: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env, registry, mode: 'tool', render: { json() {}, lines() {} } },
  });
  const out3 = [];
  for await (const it of third.output) out3.push(it);
  assert.equal(out3[0].changed, true);
});
