import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, truncateSync } from 'node:fs';
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

test('file.read JSON array yields elements', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fread-'));
  const filePath = path.join(tmp, 'data.json');
  writeFileSync(filePath, JSON.stringify([{ a: 1 }, { a: 2 }]));

  const cmd = createDefaultRegistry().get('file.read');
  const res = await cmd.run({ input: streamOf([]), args: { _: [filePath], format: 'json' }, ctx: makeCtx() });
  const items = await collect(res.output);
  assert.deepEqual(items, [{ a: 1 }, { a: 2 }]);
});

test('file.read JSON object yields single item', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fread-'));
  const filePath = path.join(tmp, 'obj.json');
  writeFileSync(filePath, JSON.stringify({ a: 1 }));

  const cmd = createDefaultRegistry().get('file.read');
  const res = await cmd.run({ input: streamOf([]), args: { _: [filePath], format: 'json' }, ctx: makeCtx() });
  const items = await collect(res.output);
  assert.deepEqual(items, [{ a: 1 }]);
});

test('file.read JSONL yields parsed lines', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fread-'));
  const filePath = path.join(tmp, 'data.jsonl');
  writeFileSync(filePath, '{"x":1}\n{"x":2}\n{"x":3}\n');

  const cmd = createDefaultRegistry().get('file.read');
  const res = await cmd.run({ input: streamOf([]), args: { _: [filePath], format: 'jsonl' }, ctx: makeCtx() });
  const items = await collect(res.output);
  assert.deepEqual(items, [{ x: 1 }, { x: 2 }, { x: 3 }]);
});

test('file.read text yields entire content as single string', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fread-'));
  const filePath = path.join(tmp, 'readme.txt');
  writeFileSync(filePath, 'hello world\nline two\n');

  const cmd = createDefaultRegistry().get('file.read');
  const res = await cmd.run({ input: streamOf([]), args: { _: [filePath], format: 'text' }, ctx: makeCtx() });
  const items = await collect(res.output);
  assert.equal(items.length, 1);
  assert.equal(items[0], 'hello world\nline two\n');
});

test('file.read auto-detects JSON array', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fread-'));
  const filePath = path.join(tmp, 'auto.json');
  writeFileSync(filePath, JSON.stringify([10, 20, 30]));

  const cmd = createDefaultRegistry().get('file.read');
  const res = await cmd.run({ input: streamOf([]), args: { _: [filePath] }, ctx: makeCtx() });
  const items = await collect(res.output);
  assert.deepEqual(items, [10, 20, 30]);
});

test('file.read auto-detects JSONL', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fread-'));
  const filePath = path.join(tmp, 'auto.jsonl');
  writeFileSync(filePath, '{"k":"a"}\n{"k":"b"}\n');

  const cmd = createDefaultRegistry().get('file.read');
  const res = await cmd.run({ input: streamOf([]), args: { _: [filePath] }, ctx: makeCtx() });
  const items = await collect(res.output);
  assert.deepEqual(items, [{ k: 'a' }, { k: 'b' }]);
});

test('file.read auto-detects plain text', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fread-'));
  const filePath = path.join(tmp, 'plain.txt');
  writeFileSync(filePath, 'not json at all\njust text\n');

  const cmd = createDefaultRegistry().get('file.read');
  const res = await cmd.run({ input: streamOf([]), args: { _: [filePath] }, ctx: makeCtx() });
  const items = await collect(res.output);
  assert.equal(items.length, 1);
  assert.equal(items[0], 'not json at all\njust text\n');
});

test('file.read throws on missing file', async () => {
  const cmd = createDefaultRegistry().get('file.read');
  await assert.rejects(
    () => cmd.run({ input: streamOf([]), args: { _: [path.join(os.tmpdir(), 'nonexistent-lobster-' + Date.now() + '.json')] }, ctx: makeCtx() }),
    (err: any) => err.code === 'ENOENT',
  );
});

test('file.read --path named arg works', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fread-'));
  const filePath = path.join(tmp, 'named.json');
  writeFileSync(filePath, JSON.stringify({ b: 2 }));

  const cmd = createDefaultRegistry().get('file.read');
  const res = await cmd.run({ input: streamOf([]), args: { _: [], path: filePath, format: 'json' }, ctx: makeCtx() });
  const items = await collect(res.output);
  assert.deepEqual(items, [{ b: 2 }]);
});

test('file.read throws when no path provided', async () => {
  const cmd = createDefaultRegistry().get('file.read');
  await assert.rejects(
    () => cmd.run({ input: streamOf([]), args: { _: [] }, ctx: makeCtx() }),
    (err: any) => err.message.includes('file.read requires a path'),
  );
});

test('file.read throws on unknown format', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fread-'));
  const filePath = path.join(tmp, 'data.json');
  writeFileSync(filePath, '{}');

  const cmd = createDefaultRegistry().get('file.read');
  await assert.rejects(
    () => cmd.run({ input: streamOf([]), args: { _: [filePath], format: 'xml' }, ctx: makeCtx() }),
    (err: any) => err.message.includes("unknown format 'xml'"),
  );
});

test('file.read --format json throws on invalid JSON content', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fread-'));
  const filePath = path.join(tmp, 'bad.json');
  writeFileSync(filePath, 'this is not json');

  const cmd = createDefaultRegistry().get('file.read');
  await assert.rejects(
    () => cmd.run({ input: streamOf([]), args: { _: [filePath], format: 'json' }, ctx: makeCtx() }),
  );
});

test('file.read throws when file exceeds MAX_FILE_SIZE', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fread-'));
  const filePath = path.join(tmp, 'huge.json');
  writeFileSync(filePath, '');
  // Create a sparse file that reports > 50 MB without writing actual data
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  truncateSync(filePath, MAX_FILE_SIZE + 1);

  const cmd = createDefaultRegistry().get('file.read');
  await assert.rejects(
    () => cmd.run({ input: streamOf([]), args: { _: [filePath] }, ctx: makeCtx() }),
    (err: any) => err.message.includes('file exceeds maximum size'),
  );
});

test('file.read --format jsonl throws on invalid line', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fread-'));
  const filePath = path.join(tmp, 'bad.jsonl');
  writeFileSync(filePath, '{"valid":true}\nnot valid json\n{"also":true}\n');

  const cmd = createDefaultRegistry().get('file.read');
  await assert.rejects(
    () => cmd.run({ input: streamOf([]), args: { _: [filePath], format: 'jsonl' }, ctx: makeCtx() }),
  );
});

test('file.read auto-detects JSON object (not array) as single item', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-fread-'));
  const filePath = path.join(tmp, 'auto-obj.json');
  writeFileSync(filePath, JSON.stringify({ key: 'value', nested: { a: 1 } }));

  const cmd = createDefaultRegistry().get('file.read');
  const res = await cmd.run({ input: streamOf([]), args: { _: [filePath] }, ctx: makeCtx() });
  const items = await collect(res.output);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { key: 'value', nested: { a: 1 } });
});
