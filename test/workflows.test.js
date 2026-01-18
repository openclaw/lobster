import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultRegistry } from '../src/commands/registry.js';

function streamOf(items) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test('workflows.list returns known workflows', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('workflows.list');

  const res = await cmd.run({
    input: streamOf([]),
    args: { _: [] },
    ctx: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, registry, mode: 'tool', render: { json() {}, lines() {} } },
  });

  const items = [];
  for await (const it of res.output) items.push(it);

  const names = items.map((x) => x.name).sort();
  assert.deepEqual(names, ['email.triage', 'github.pr.monitor', 'github.pr.monitor.notify']);
});
