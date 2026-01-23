import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultRegistry } from '../src/commands/registry.js';

function streamOf(items) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test('exec --stdin jsonl feeds pipeline input to subprocess', async () => {
  const registry = createDefaultRegistry();
  const cmd = registry.get('exec');

  const nodeScript = [
    "let d='';",
    "process.stdin.on('data',c=>d+=c);",
    "process.stdin.on('end',()=>{",
    "  const lines=d.trim().split('\\n').filter(Boolean);",
    "  console.log(JSON.stringify(lines));",
    "});",
  ].join('');

  const result = await cmd.run({
    input: streamOf([{ a: 1 }, { a: 2 }]),
    args: {
      _: ['node', '-e', nodeScript],
      stdin: 'jsonl',
      json: true,
    },
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
  for await (const item of result.output) items.push(item);
  assert.deepEqual(items, ['{"a":1}', '{"a":2}']);
});
