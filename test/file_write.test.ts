import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createDefaultRegistry } from '../src/commands/registry.js';

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

test('file.write single JSON object', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fwrite-'));
  const filePath = path.join(tmp, 'out.json');

  const cmd = createDefaultRegistry().get('file.write');
  await cmd.run({ input: streamOf([{ name: 'test' }]), args: { _: [filePath], format: 'json' }, ctx: makeCtx() });

  const content = readFileSync(filePath, 'utf8');
  assert.deepEqual(JSON.parse(content), { name: 'test' });
});

test('file.write multiple items as JSON array', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fwrite-'));
  const filePath = path.join(tmp, 'arr.json');

  const cmd = createDefaultRegistry().get('file.write');
  await cmd.run({ input: streamOf([{ a: 1 }, { a: 2 }]), args: { _: [filePath], format: 'json' }, ctx: makeCtx() });

  const content = readFileSync(filePath, 'utf8');
  assert.deepEqual(JSON.parse(content), [{ a: 1 }, { a: 2 }]);
});

test('file.write JSONL format', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fwrite-'));
  const filePath = path.join(tmp, 'out.jsonl');

  const cmd = createDefaultRegistry().get('file.write');
  await cmd.run({ input: streamOf([{ x: 1 }, { x: 2 }]), args: { _: [filePath], format: 'jsonl' }, ctx: makeCtx() });

  const content = readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { x: 1 });
  assert.deepEqual(JSON.parse(lines[1]), { x: 2 });
});

test('file.write text format', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fwrite-'));
  const filePath = path.join(tmp, 'out.txt');

  const cmd = createDefaultRegistry().get('file.write');
  await cmd.run({ input: streamOf(['hello', 'world']), args: { _: [filePath], format: 'text' }, ctx: makeCtx() });

  const content = readFileSync(filePath, 'utf8');
  assert.equal(content, 'hello\nworld\n');
});

test('file.write tee passthrough yields items downstream', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fwrite-'));
  const filePath = path.join(tmp, 'tee.json');
  const inputItems = [{ a: 1 }, { a: 2 }, { a: 3 }];

  const cmd = createDefaultRegistry().get('file.write');
  const res = await cmd.run({ input: streamOf(inputItems), args: { _: [filePath] }, ctx: makeCtx() });

  const yielded = await collect(res.output);
  assert.deepEqual(yielded, inputItems);
});

test('file.write --mkdir creates parent directories', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fwrite-'));
  const filePath = path.join(tmp, 'nested', 'deep', 'out.json');

  const cmd = createDefaultRegistry().get('file.write');
  await cmd.run({ input: streamOf([42]), args: { _: [filePath], mkdir: true }, ctx: makeCtx() });

  const content = readFileSync(filePath, 'utf8');
  assert.deepEqual(JSON.parse(content), 42);
});

test('file.write --mkdir false fails on missing parent', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fwrite-'));
  const filePath = path.join(tmp, 'nonexistent', 'out.json');

  const cmd = createDefaultRegistry().get('file.write');
  await assert.rejects(
    () => cmd.run({ input: streamOf([1]), args: { _: [filePath], mkdir: false }, ctx: makeCtx() }),
    (err: any) => err.code === 'ENOENT',
  );
});

test('file.write --path named arg works', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fwrite-'));
  const filePath = path.join(tmp, 'named.json');

  const cmd = createDefaultRegistry().get('file.write');
  await cmd.run({ input: streamOf([{ c: 3 }]), args: { _: [], path: filePath, format: 'json' }, ctx: makeCtx() });

  const content = readFileSync(filePath, 'utf8');
  assert.deepEqual(JSON.parse(content), { c: 3 });
});

test('file.write throws when no path provided', async () => {
  const cmd = createDefaultRegistry().get('file.write');
  await assert.rejects(
    () => cmd.run({ input: streamOf([1]), args: { _: [] }, ctx: makeCtx() }),
    (err: any) => err.message.includes('file.write requires a path'),
  );
});

test('file.write throws on unknown format', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fwrite-'));
  const filePath = path.join(tmp, 'out.xml');

  const cmd = createDefaultRegistry().get('file.write');
  await assert.rejects(
    () => cmd.run({ input: streamOf([1]), args: { _: [filePath], format: 'xml' }, ctx: makeCtx() }),
    (err: any) => err.message.includes("unknown format 'xml'"),
  );
});
