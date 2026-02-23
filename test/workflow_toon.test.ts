import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadWorkflowFile } from '../src/workflows/file.js';
import { runWorkflowFile } from '../src/workflows/file.js';
import { encode as encodeToon } from '@toon-format/toon';

test('loadWorkflowFile parses .toon workflow files', async () => {
  const workflow = {
    name: 'toon-test',
    steps: [
      {
        id: 'hello',
        command: "node -e \"process.stdout.write(JSON.stringify({msg:'hello from toon'}))\"",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-toon-'));
  const filePath = path.join(tmpDir, 'workflow.toon');
  await fsp.writeFile(filePath, encodeToon(workflow), 'utf8');

  const loaded = await loadWorkflowFile(filePath);
  assert.equal(loaded.name, 'toon-test');
  assert.equal(loaded.steps.length, 1);
  assert.equal(loaded.steps[0].id, 'hello');
});

test('runWorkflowFile executes a .toon workflow', async () => {
  const workflow = {
    name: 'toon-run',
    steps: [
      {
        id: 'greet',
        command: "node -e \"process.stdout.write(JSON.stringify({greeting:'hallo'}))\"",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-toon-run-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.toon');
  await fsp.writeFile(filePath, encodeToon(workflow), 'utf8');

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: 'tool',
    },
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ greeting: 'hallo' }]);
});
