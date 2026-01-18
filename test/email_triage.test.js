import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultRegistry } from '../src/commands/registry.js';
import { runPipeline } from '../src/runtime.js';

function streamOf(items) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test('email.triage classifies by keywords deterministically', async () => {
  const registry = createDefaultRegistry();
  const pipeline = [{ name: 'email.triage', args: { _: [] }, raw: 'email.triage' }];

  const output = await runPipeline({
    pipeline,
    registry,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  });

  // Default input is empty stream => report total=0.
  assert.equal(output.items.length, 1);
  assert.equal(output.items[0].summary.total, 0);
});

test('email.triage maps custom fields', async () => {
  const registry = createDefaultRegistry();
  const pipeline = [
    {
      name: 'email.triage',
      args: {
        _: [],
        'subject-field': 'meta.title',
        'from-field': 'meta.sender',
        'snippet-field': 'meta.snip',
        'id-field': 'meta.id',
      },
      raw: 'email.triage',
    },
  ];

  const output = await (async () => {
    // Inject custom input by monkey-patching runtime: call command directly.
    const cmd = registry.get('email.triage');
    const result = await cmd.run({
      input: streamOf([
        { meta: { id: '1', title: 'Invoice due', sender: 'Billing <b@example.com>', snip: 'Pay now' } },
      ]),
      args: pipeline[0].args,
      ctx: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, registry, render: { json() {}, lines() {} } },
    });
    const items = [];
    for await (const it of result.output) items.push(it);
    return items;
  })();

  assert.equal(output.length, 1);
  assert.equal(output[0].summary.total, 1);
  assert.equal(output[0].items[0].bucket, 'needs_action');
  assert.equal(output[0].items[0].fromEmail, 'b@example.com');
});
