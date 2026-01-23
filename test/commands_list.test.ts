import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultRegistry } from '../src/commands/registry.js';

function streamOf(items) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test('commands.list returns command inventory including stdlib + workflows', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('commands.list');
  assert.ok(cmd, 'commands.list should be registered');

  const res = await cmd.run({
    input: streamOf([]),
    args: { _: [] },
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
  for await (const it of res.output) items.push(it);

  const names = items.map((x) => x.name).sort();

  // A couple representative commands we always expect.
  assert.ok(names.includes('exec'));
  assert.ok(names.includes('json'));
  assert.ok(names.includes('workflows.list'));
  assert.ok(names.includes('commands.list'));

  const self = items.find((x) => x.name === 'commands.list');
  assert.ok(self);
  assert.equal(typeof self.description, 'string');
  assert.ok(self.description.length > 0);
  // Schema should be present for commands that declare it.
  assert.ok(self.argsSchema);
});
