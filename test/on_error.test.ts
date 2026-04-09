import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runWorkflowFile, loadWorkflowFile } from '../src/workflows/file.js';

async function runWorkflow(workflow: any) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-onerror-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  return runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: 'tool',
    },
  });
}

test('on_error: stop (default) propagates error', async () => {
  const workflow = {
    name: 'stop-test',
    steps: [
      { id: 'fail', command: 'node -e "process.exit(1)"' },
      { id: 'after', command: 'echo "should not run"' },
    ],
  };
  await assert.rejects(runWorkflow(workflow), /workflow command failed/);
});

test('on_error: stop explicit also propagates', async () => {
  const workflow = {
    name: 'stop-explicit',
    steps: [
      { id: 'fail', command: 'node -e "process.exit(1)"', on_error: 'stop' },
      { id: 'after', command: 'echo "should not run"' },
    ],
  };
  await assert.rejects(runWorkflow(workflow), /workflow command failed/);
});

test('on_error: continue records error and proceeds', async () => {
  const workflow = {
    name: 'continue-test',
    steps: [
      { id: 'fail', command: 'node -e "process.exit(1)"', on_error: 'continue' },
      { id: 'after', command: 'echo "ran"' },
    ],
  };
  const result = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, ['ran\n']);
});

test('on_error: continue sets error fields on step result', async () => {
  const workflow = {
    name: 'error-fields',
    steps: [
      { id: 'fail', command: 'node -e "process.exit(1)"', on_error: 'continue' },
      {
        id: 'check',
        command: 'node -e "process.stdout.write(JSON.stringify({saw_error: process.env.LOBSTER_ARG_ERR}))"',
        env: { LOBSTER_ARG_ERR: '$fail.error' },
      },
    ],
  };
  const result = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  const output = result.output as any[];
  assert.equal(output[0].saw_error, 'true');
});

test('on_error: skip_rest records error and stops remaining steps', async () => {
  const workflow = {
    name: 'skip-rest-test',
    steps: [
      { id: 'ok', command: 'echo "first"' },
      { id: 'fail', command: 'node -e "process.exit(1)"', on_error: 'skip_rest' },
      { id: 'skipped', command: 'echo "should not run"' },
    ],
  };
  const result = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  // Output comes from the last step that ran, which is 'fail' (with error fields)
  // The 'skipped' step never executes
});

test('on_error: continue allows condition-based branching on error', async () => {
  const workflow = {
    name: 'branch-on-error',
    steps: [
      { id: 'risky', command: 'node -e "process.exit(1)"', on_error: 'continue' },
      { id: 'on_success', command: 'echo "success path"', when: '$risky.error != true' },
      { id: 'on_failure', command: 'echo "failure path"', when: '$risky.error == true' },
    ],
  };
  const result = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, ['failure path\n']);
});

test('on_error validation rejects invalid values', async () => {
  const workflow = {
    name: 'bad',
    steps: [{ id: 'x', command: 'echo hi', on_error: 'invalid' }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-onerror-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /on_error must be/);
});

test('multiple steps with on_error: continue collects all errors', async () => {
  const workflow = {
    name: 'multi-error',
    steps: [
      { id: 'a', command: 'node -e "process.exit(1)"', on_error: 'continue' },
      { id: 'b', command: 'node -e "process.exit(1)"', on_error: 'continue' },
      {
        id: 'report',
        command: 'node -e "process.stdout.write(JSON.stringify({a_err:process.env.A_ERR,b_err:process.env.B_ERR}))"',
        env: { A_ERR: '$a.error', B_ERR: '$b.error' },
      },
    ],
  };
  const result = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  const output = result.output as any[];
  assert.equal(output[0].a_err, 'true');
  assert.equal(output[0].b_err, 'true');
});
