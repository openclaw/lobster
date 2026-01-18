import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('doctor returns tool-mode ok with version', () => {
  const bin = path.join(process.cwd(), 'bin', 'lobster.js');
  const res = spawnSync('node', [bin, 'doctor'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.protocolVersion, 1);
  assert.equal(out.status, 'ok');
  assert.equal(out.output[0].toolMode, true);
  assert.ok(typeof out.output[0].version === 'string');
});
