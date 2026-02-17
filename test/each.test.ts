import test from 'node:test';
import assert from 'node:assert/strict';

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

// -- Parser tests --

test('parsePipeline parses each { ... } as single stage with _body', () => {
  const p = parsePipeline('each { head --n 1 }');
  assert.equal(p.length, 1);
  assert.equal(p[0].name, 'each');
  assert.ok(Array.isArray(p[0].args._body));
  assert.equal(p[0].args._body.length, 1);
  assert.equal(p[0].args._body[0].name, 'head');
  assert.equal(p[0].args._body[0].args.n, '1');
  assert.equal(p[0].args._bodyRaw, 'head --n 1');
});

test('parsePipeline parses multi-stage sub-pipeline in braces', () => {
  const p = parsePipeline('each { map --unwrap x | head --n 1 }');
  assert.equal(p.length, 1);
  assert.equal(p[0].args._body.length, 2);
  assert.equal(p[0].args._body[0].name, 'map');
  assert.equal(p[0].args._body[1].name, 'head');
});

test('parsePipeline handles each in a larger pipeline', () => {
  const p = parsePipeline('head --n 5 | each { template --text "hi" } | json');
  assert.equal(p.length, 3);
  assert.equal(p[0].name, 'head');
  assert.equal(p[1].name, 'each');
  assert.ok(Array.isArray(p[1].args._body));
  assert.equal(p[2].name, 'json');
});

test('braces inside quoted strings do not trigger body parsing', () => {
  const p = parsePipeline("template --text 'hello {world}'");
  assert.equal(p.length, 1);
  assert.equal(p[0].name, 'template');
  assert.equal(p[0].args.text, 'hello {world}');
  assert.equal(p[0].args._body, undefined);
});

test('bare closing brace without matching open is treated as literal', () => {
  const p = parsePipeline('exec echo }');
  assert.equal(p.length, 1);
  assert.equal(p[0].name, 'exec');
  assert.deepEqual(p[0].args._, ['echo', '}']);
});

test('unclosed brace throws', () => {
  assert.throws(() => parsePipeline('each { foo'), /Unclosed brace/);
});

test('empty body throws', () => {
  assert.throws(() => parsePipeline('each { }'), /Empty body in \{ \} block/);
});

test('nested braces parse correctly', () => {
  const p = parsePipeline('each { each { head --n 1 } }');
  assert.equal(p.length, 1);
  assert.equal(p[0].name, 'each');
  const inner = p[0].args._body;
  assert.equal(inner.length, 1);
  assert.equal(inner[0].name, 'each');
  assert.equal(inner[0].args._body.length, 1);
  assert.equal(inner[0].args._body[0].name, 'head');
});

// -- Functional tests --

test('each passes each item through a single-command sub-pipeline', async () => {
  const out = await run('each { map --wrap item }', ['a', 'b', 'c']);
  assert.deepEqual(out, [{ item: 'a' }, { item: 'b' }, { item: 'c' }]);
});

test('each runs multi-stage sub-pipeline', async () => {
  const out = await run('each { map --wrap x | map --unwrap x }', [1, 2, 3]);
  assert.deepEqual(out, [1, 2, 3]);
});

test('each interpolates {{.field}} in sub-pipeline args', async () => {
  const out = await run(
    'each { template --text "hello {{.name}}" }',
    [{ name: 'alice' }, { name: 'bob' }],
  );
  assert.deepEqual(out, ['hello alice', 'hello bob']);
});

test('each interpolates {{.nested.path}}', async () => {
  const out = await run(
    'each { template --text "{{.user.name}}" }',
    [{ user: { name: 'deep' } }],
  );
  assert.deepEqual(out, ['deep']);
});

test('each interpolates {{.}} for whole item', async () => {
  const out = await run(
    'each { template --text "val={{.}}" }',
    [42, 'hi'],
  );
  assert.deepEqual(out, ['val=42', 'val=hi']);
});

test('missing {{.field}} renders as empty string', async () => {
  const out = await run(
    'each { template --text "x={{.nope}}" }',
    [{ a: 1 }],
  );
  assert.deepEqual(out, ['x=']);
});

test('each with empty input yields nothing', async () => {
  const out = await run('each { map --wrap x }', []);
  assert.deepEqual(out, []);
});

test('error in sub-pipeline propagates (fail-fast)', async () => {
  await assert.rejects(
    () => run('each { nonexistent_command }', [1]),
    /Unknown command: nonexistent_command/,
  );
});

test('nested each works', async () => {
  const input = [{ name: 'alice' }, { name: 'bob' }];
  // Redundant nesting but validates parser handles nested braces
  // and runtime handles nested each invocations
  const out = await run(
    'each { each { template --text "hi {{.name}}" } }',
    input,
  );
  assert.deepEqual(out, ['hi alice', 'hi bob']);
});

test('each without body throws at runtime', async () => {
  await assert.rejects(
    () => run('each', [1, 2]),
    /each requires a \{ sub-pipeline \} body/,
  );
});

test('each does not traverse prototype properties', async () => {
  const out = await run(
    'each { template --text "x={{.constructor}}" }',
    [{ name: 'test' }],
  );
  assert.deepEqual(out, ['x=']);
});

test('each yields multiple items per input when sub-pipeline fans out', async () => {
  const out = await run(
    "each { exec --json --shell 'echo \"[1,2]\"' }",
    ['x', 'y'],
  );
  assert.deepEqual(out, [1, 2, 1, 2]);
});

test('deeply nested braces throw recursion depth error', () => {
  const deep = 'each { '.repeat(60) + 'head --n 1' + ' }'.repeat(60);
  assert.throws(() => parsePipeline(deep), /maximum depth/);
});
