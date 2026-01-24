import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runPipeline } from '../src/runtime.js';
import { createDefaultRegistry } from '../src/commands/registry.js';
import { parsePipeline } from '../src/parser.js';

async function run(pipelineText: string, input: any[]) {
  const pipeline = parsePipeline(pipelineText);
  const registry = createDefaultRegistry();
  const res = await runPipeline({
    pipeline,
    registry,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: 'tool',
    input: (async function* () { for (const x of input) yield x; })(),
  });
  return res.items;
}

test('template renders fields and nested fields', async () => {
  const out = await run("template --text 'hi {{user.name}}'", [{ user: { name: 'v' } }]);
  assert.deepEqual(out, ['hi v']);
});

test('template renders missing fields as empty', async () => {
  const out = await run("template --text 'x={{nope}}'", [{ a: 1 }]);
  assert.deepEqual(out, ['x=']);
});

test('template supports {{.}} for whole item', async () => {
  const out = await run("template --text '{{.}}'", [{ a: 1 }]);
  assert.deepEqual(out, [JSON.stringify({ a: 1 })]);
});

test('template supports --file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-template-'));
  const file = path.join(dir, 'tpl.txt');
  await fs.writeFile(file, 'hey {{x}}', 'utf8');
  const out = await run(`template --file ${file}`, [{ x: 'ok' }]);
  assert.deepEqual(out, ['hey ok']);
});
