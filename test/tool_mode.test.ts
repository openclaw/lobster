import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { parsePipeline } from '../src/parser.js';
import { createDefaultRegistry } from '../src/commands/registry.js';
import { runPipeline } from '../src/runtime.js';

function streamOf(items) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test('approve halts pipeline in tool mode', async () => {
  const registry = createDefaultRegistry();
  const pipeline = parsePipeline(
    "exec --json --shell \"node -e 'process.stdout.write(JSON.stringify([{a:1}]))'\" | approve --prompt 'send?' | exec --shell 'exit 1'"
  );

  const output = await runPipeline({
    pipeline,
    registry,
    input: [],
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: 'tool',
  });

  assert.equal(output.halted, true);
  assert.equal(output.items.length, 1);
  assert.equal(output.items[0].type, 'approval_request');
  assert.equal(output.items[0].items.length, 1);
  assert.deepEqual(output.items[0].items[0], { a: 1 });
});

test('approve passes through in human interactive mode only (emit required otherwise)', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('approve');

  const result = await cmd.run({
    input: streamOf([{ x: 1 }]),
    args: { _: [], emit: true, prompt: 'ok?' },
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      registry,
      mode: 'human',
      render: { json() {}, lines() {} },
    },
  });

  const items = [];
  for await (const it of result.output) items.push(it);
  assert.equal(result.halt, true);
  assert.equal(items[0].type, 'approval_request');
});

test('ask validates interactive reply against string schema', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('ask');
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  setImmediate(() => {
    stdin.end('approve\n');
  });

  const result = await cmd.run({
    input: streamOf([]),
    args: {
      _: [],
      prompt: 'Decision?',
      schema: '{"type":"string","enum":["approve","reject"]}',
    },
    ctx: {
      stdin,
      stdout,
      stderr: process.stderr,
      env: process.env,
      registry,
      mode: 'human',
      render: { json() {}, lines() {} },
    },
  });

  const items = [];
  for await (const it of result.output) items.push(it);
  assert.deepEqual(items, ['approve']);
});

test('ask rejects invalid interactive reply when schema does not match', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('ask');
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  setImmediate(() => {
    stdin.end('maybe\n');
  });

  await assert.rejects(
    () =>
      cmd.run({
        input: streamOf([]),
        args: {
          _: [],
          prompt: 'Decision?',
          schema: '{"type":"string","enum":["approve","reject"]}',
        },
        ctx: {
          stdin,
          stdout,
          stderr: process.stderr,
          env: process.env,
          registry,
          mode: 'human',
          render: { json() {}, lines() {} },
        },
      }),
    /schema validation/i,
  );
});

test('ask reports invalid interactive schema with a stable error', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('ask');
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  setImmediate(() => {
    stdin.end('approve\n');
  });

  await assert.rejects(
    () =>
      cmd.run({
        input: streamOf([]),
        args: {
          _: [],
          prompt: 'Decision?',
          schema: '{"type":"wat"}',
        },
        ctx: {
          stdin,
          stdout,
          stderr: process.stderr,
          env: process.env,
          registry,
          mode: 'human',
          render: { json() {}, lines() {} },
        },
      }),
    /schema is invalid/i,
  );
});

test('ask keeps freeform decision UX in interactive mode for default schema', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('ask');
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  setImmediate(() => {
    stdin.end('approve\n');
  });

  const result = await cmd.run({
    input: streamOf([]),
    args: {
      _: [],
      prompt: 'Decision?',
    },
    ctx: {
      stdin,
      stdout,
      stderr: process.stderr,
      env: process.env,
      registry,
      mode: 'human',
      render: { json() {}, lines() {} },
    },
  });

  const items = [];
  for await (const it of result.output) items.push(it);
  assert.deepEqual(items, [{ decision: 'approve' }]);
});

test('ask treats quoted interactive strings like decisions for default schema', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('ask');
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  setImmediate(() => {
    stdin.end('"approve"\n');
  });

  const result = await cmd.run({
    input: streamOf([]),
    args: {
      _: [],
      prompt: 'Decision?',
    },
    ctx: {
      stdin,
      stdout,
      stderr: process.stderr,
      env: process.env,
      registry,
      mode: 'human',
      render: { json() {}, lines() {} },
    },
  });

  const items = [];
  for await (const it of result.output) items.push(it);
  assert.deepEqual(items, [{ decision: 'approve' }]);
});
