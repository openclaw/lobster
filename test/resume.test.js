import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultRegistry } from '../src/commands/registry.js';
import { parsePipeline } from '../src/parser.js';
import { runPipeline } from '../src/runtime.js';
import { encodeToken, decodeToken } from '../src/token.js';

function streamOf(items) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test('resume token roundtrip and resume pipeline continues', async () => {
  const registry = createDefaultRegistry();

  const pipeline = parsePipeline(
    "exec --json --shell \"node -e 'process.stdout.write(JSON.stringify([{a:1}]))'\" | approve --prompt 'ok?' | pick a"
  );

  const first = await runPipeline({
    pipeline,
    registry,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: 'tool',
  });

  assert.equal(first.halted, true);
  assert.equal(first.items[0].type, 'approval_request');

  const token = encodeToken({
    v: 1,
    pipeline,
    resumeAtIndex: (first.haltedAt?.index ?? -1) + 1,
    items: first.items[0].items,
    prompt: first.items[0].prompt,
  });

  const decoded = decodeToken(token);
  assert.equal(decoded.v, 1);
  assert.equal(decoded.items.length, 1);

  const remaining = decoded.pipeline.slice(decoded.resumeAtIndex);
  const resumed = await runPipeline({
    pipeline: remaining,
    registry,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: 'tool',
    input: streamOf(decoded.items),
  });

  assert.equal(resumed.halted, false);
  assert.deepEqual(resumed.items, [{ a: 1 }]);
});
