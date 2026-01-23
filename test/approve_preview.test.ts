import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultRegistry } from '../src/commands/registry.js';

function streamOf(items) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test('approve preview includes stdin sample when requested', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('approve');

  const result = await cmd.run({
    input: streamOf([{ a: 1 }, { a: 2 }]),
    args: {
      _: [],
      emit: true,
      prompt: 'ok?',
      'preview-from-stdin': true,
      limit: 1,
    },
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      registry,
      mode: 'tool',
      render: { json() {}, lines() {} },
    },
  });

  const items = [];
  for await (const item of result.output) items.push(item);
  assert.equal(items[0].type, 'approval_request');
  assert.ok(String(items[0].preview).includes('"a": 1'));
});
