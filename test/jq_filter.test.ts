import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultRegistry } from '../src/commands/registry.js';

const JQ_AVAILABLE = process.platform !== 'win32';

function streamOf(items) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

function makeCtx() {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    registry: createDefaultRegistry(),
    mode: 'tool',
    render: { json() {}, lines() {} },
  };
}

async function collect(output) {
  const items = [];
  for await (const item of output) items.push(item);
  return items;
}

test('jq-filter identity . passes items through', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq-filter');
  const res = await cmd.run({ input: streamOf([{ a: 1 }, { b: 2 }]), args: { _: ['.'] }, ctx: makeCtx() });
  const items = await collect(res.output);
  assert.deepEqual(items, [{ a: 1 }, { b: 2 }]);
});

test('jq-filter extracts field with .name', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq-filter');
  const res = await cmd.run({
    input: streamOf([{ name: 'alice' }, { name: 'bob' }]),
    args: { _: ['.name'] },
    ctx: makeCtx(),
  });
  const items = await collect(res.output);
  assert.deepEqual(items, ['alice', 'bob']);
});

test('jq-filter navigates nested path .a.b', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq-filter');
  const res = await cmd.run({
    input: streamOf([{ a: { b: 42 } }]),
    args: { _: ['.a.b'] },
    ctx: makeCtx(),
  });
  const items = await collect(res.output);
  assert.deepEqual(items, [42]);
});

test('jq-filter array output .[].x flattens results', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq-filter');
  const res = await cmd.run({
    input: streamOf([{ items: [{ x: 1 }, { x: 2 }] }]),
    args: { _: ['.items[].x'] },
    ctx: makeCtx(),
  });
  const items = await collect(res.output);
  assert.deepEqual(items, [1, 2]);
});

test('jq-filter processes multiple items independently', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq-filter');
  const res = await cmd.run({
    input: streamOf([{ v: 10 }, { v: 20 }, { v: 30 }]),
    args: { _: ['.v'] },
    ctx: makeCtx(),
  });
  const items = await collect(res.output);
  assert.deepEqual(items, [10, 20, 30]);
});

test('jq-filter propagates error on invalid expression', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq-filter');
  await assert.rejects(
    () => cmd.run({ input: streamOf([{ a: 1 }]), args: { _: ['invalid!!!'] }, ctx: makeCtx() }),
    (err: any) => err.message.includes('jq-filter failed'),
  );
});

test('jq-filter --expr named arg works', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq-filter');
  const res = await cmd.run({
    input: streamOf([{ a: 1 }]),
    args: { _: [], expr: '.a' },
    ctx: makeCtx(),
  });
  const items = await collect(res.output);
  assert.deepEqual(items, [1]);
});

test('jq-filter throws when no expression provided', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq-filter');
  await assert.rejects(
    () => cmd.run({ input: streamOf([{ a: 1 }]), args: { _: [] }, ctx: makeCtx() }),
    (err: any) => err.message.includes('jq-filter requires an expression'),
  );
});
