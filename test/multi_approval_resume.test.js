import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function runTool(pipeline) {
  const bin = path.join(process.cwd(), 'bin', 'lobster.js');
  const res = spawnSync('node', [bin, 'run', '--mode', 'tool', pipeline], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  return JSON.parse(res.stdout);
}

function resume(token, approve) {
  const bin = path.join(process.cwd(), 'bin', 'lobster.js');
  const res = spawnSync('node', [bin, 'resume', '--token', token, '--approve', approve ? 'yes' : 'no'], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0);
  return JSON.parse(res.stdout);
}

test('two approve gates can be resumed sequentially', () => {
  const pipeline = [
    "exec --json --shell \"printf '%s' '[{\\\"x\\\":1}]'\"",
    "approve --prompt 'first?'",
    "approve --prompt 'second?'",
    'pick x',
  ].join(' | ');

  const first = runTool(pipeline);
  assert.equal(first.status, 'needs_approval');
  assert.equal(first.requiresApproval.prompt, 'first?');

  const second = resume(first.requiresApproval.resumeToken, true);
  assert.equal(second.status, 'needs_approval');
  assert.equal(second.requiresApproval.prompt, 'second?');

  const done = resume(second.requiresApproval.resumeToken, true);
  assert.equal(done.status, 'ok');
  assert.deepEqual(done.output, [{ x: 1 }]);
});
