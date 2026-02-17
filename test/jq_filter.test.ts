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

test('jq.filter identity . passes items through', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq.filter');
  const res = await cmd.run({ input: streamOf([{ a: 1 }, { b: 2 }]), args: { _: ['.'] }, ctx: makeCtx() });
  const items = await collect(res.output);
  assert.deepEqual(items, [{ a: 1 }, { b: 2 }]);
});

test('jq.filter extracts field with .name', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq.filter');
  const res = await cmd.run({
    input: streamOf([{ name: 'alice' }, { name: 'bob' }]),
    args: { _: ['.name'] },
    ctx: makeCtx(),
  });
  const items = await collect(res.output);
  assert.deepEqual(items, ['alice', 'bob']);
});

test('jq.filter navigates nested path .a.b', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq.filter');
  const res = await cmd.run({
    input: streamOf([{ a: { b: 42 } }]),
    args: { _: ['.a.b'] },
    ctx: makeCtx(),
  });
  const items = await collect(res.output);
  assert.deepEqual(items, [42]);
});

test('jq.filter array output .[].x flattens results', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq.filter');
  const res = await cmd.run({
    input: streamOf([{ items: [{ x: 1 }, { x: 2 }] }]),
    args: { _: ['.items[].x'] },
    ctx: makeCtx(),
  });
  const items = await collect(res.output);
  assert.deepEqual(items, [1, 2]);
});

test('jq.filter processes multiple items independently', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq.filter');
  const res = await cmd.run({
    input: streamOf([{ v: 10 }, { v: 20 }, { v: 30 }]),
    args: { _: ['.v'] },
    ctx: makeCtx(),
  });
  const items = await collect(res.output);
  assert.deepEqual(items, [10, 20, 30]);
});

test('jq.filter propagates error on invalid expression', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq.filter');
  await assert.rejects(
    () => cmd.run({ input: streamOf([{ a: 1 }]), args: { _: ['invalid!!!'] }, ctx: makeCtx() }),
    (err: any) => err.message.includes('jq.filter failed'),
  );
});

test('jq.filter --expr named arg works', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq.filter');
  const res = await cmd.run({
    input: streamOf([{ a: 1 }]),
    args: { _: [], expr: '.a' },
    ctx: makeCtx(),
  });
  const items = await collect(res.output);
  assert.deepEqual(items, [1]);
});

test('jq.filter throws when no expression provided', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq.filter');
  await assert.rejects(
    () => cmd.run({ input: streamOf([{ a: 1 }]), args: { _: [] }, ctx: makeCtx() }),
    (err: any) => err.message.includes('jq.filter requires an expression'),
  );
});

test('jq.filter --raw yields plain strings', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq.filter');
  const res = await cmd.run({
    input: streamOf([{ name: 'alice' }, { name: 'bob' }]),
    args: { _: ['.name'], raw: true },
    ctx: makeCtx(),
  });
  const items = await collect(res.output);
  assert.deepEqual(items, ['alice', 'bob']);
  // Without --raw, .name yields JSON strings (quoted); with --raw, they are plain unquoted strings.
  // Both resolve to the same JS string here because JSON.parse('"alice"') === 'alice'.
  // The real difference is visible with values containing special chars or when downstream
  // consumers expect non-JSON text.
  for (const item of items) {
    assert.equal(typeof item, 'string', `expected plain string, got ${typeof item}`);
  }
});

test('jq.filter --raw multiline yields each line as separate item', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq.filter');
  // Use keys[] to produce multiple raw output lines from a single object
  const res = await cmd.run({
    input: streamOf([{ x: 1, y: 2, z: 3 }]),
    args: { _: ['keys[]'], raw: true },
    ctx: makeCtx(),
  });
  const items = await collect(res.output);
  assert.deepEqual(items, ['x', 'y', 'z']);
  // Verify these are plain strings, not JSON-quoted
  for (const item of items) {
    assert.ok(!item.startsWith('"'), `expected unquoted string, got ${item}`);
  }
});

test('jq.filter with zero input items yields empty output', { skip: !JQ_AVAILABLE && 'jq not available on Windows' }, async () => {
  const cmd = createDefaultRegistry().get('jq.filter');
  const res = await cmd.run({
    input: streamOf([]),
    args: { _: ['.'] },
    ctx: makeCtx(),
  });
  const items = await collect(res.output);
  assert.deepEqual(items, []);
});

test('jq.filter spawn error yields descriptive message', async () => {
  // Set PATH to empty so jq binary can't be found, triggering spawn ENOENT
  const cmd = createDefaultRegistry().get('jq.filter');
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = '';
    await assert.rejects(
      () => cmd.run({
        input: streamOf([{ a: 1 }]),
        args: { _: ['.'] },
        ctx: makeCtx(),
      }),
      (err: any) => err.message.includes('jq.filter'),
    );
  } finally {
    process.env.PATH = savedPath;
  }
});
