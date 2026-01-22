import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('tool mode outputs protocolVersion', () => {
  const bin = path.join(process.cwd(), 'bin', 'lobster.js');
  const res = spawnSync('node', [bin, 'run', '--mode', 'tool', "exec --json --shell 'echo [1]'"], {
    encoding: 'utf8',
  });

  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.protocolVersion, 1);
  assert.equal(out.ok, true);
});
