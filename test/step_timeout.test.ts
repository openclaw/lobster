import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';

import { runWorkflowFile, loadWorkflowFile } from '../src/workflows/file.js';
import { createDefaultRegistry } from '../src/commands/registry.js';

async function runWorkflow(workflow: any, opts?: { signal?: AbortSignal; dryRun?: boolean }) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-timeout-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const stderr = new PassThrough();
  const chunks: string[] = [];
  stderr.on('data', (d: Buffer) => chunks.push(d.toString()));

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: 'tool',
      signal: opts?.signal,
      dryRun: opts?.dryRun,
    },
  });
  return { result, stderrOutput: chunks.join('') };
}

// --- Validation ---

test('timeout_ms validation rejects non-number', async () => {
  const workflow = {
    name: 'bad',
    steps: [{ id: 'x', command: 'echo hi', timeout_ms: 'fast' }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-timeout-'));
  const filePath = path.join(tmpDir, 'w.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /timeout_ms must be a finite positive number/);
});

test('timeout_ms validation rejects zero', async () => {
  const workflow = {
    name: 'bad',
    steps: [{ id: 'x', command: 'echo hi', timeout_ms: 0 }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-timeout-'));
  const filePath = path.join(tmpDir, 'w.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /timeout_ms must be a finite positive number/);
});

test('timeout_ms validation rejects Infinity', async () => {
  const workflow = {
    name: 'bad',
    steps: [{ id: 'x', command: 'echo hi', timeout_ms: Infinity }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-timeout-'));
  const filePath = path.join(tmpDir, 'w.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /timeout_ms must be a finite positive number/);
});

test('on_error validation rejects invalid values', async () => {
  const workflow = {
    name: 'bad',
    steps: [{ id: 'x', command: 'echo hi', on_error: 'retry' }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-timeout-'));
  const filePath = path.join(tmpDir, 'w.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /on_error must be/);
});

// --- Timeout behavior ---

test('step times out and throws with on_error: stop (default)', async () => {
  const workflow = {
    name: 'timeout-stop',
    steps: [
      { id: 'slow', command: 'node -e "setTimeout(()=>{},5000)"', timeout_ms: 100 },
    ],
  };
  await assert.rejects(
    runWorkflow(workflow).then((r) => r.result),
    /timed out after 100ms/,
  );
});

test('step times out with on_error: continue records error and proceeds', async () => {
  const workflow = {
    name: 'timeout-continue',
    steps: [
      { id: 'slow', command: 'node -e "setTimeout(()=>{},5000)"', timeout_ms: 100, on_error: 'continue' },
      { id: 'after', command: 'echo "ran"' },
    ],
  };
  const { result } = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, ['ran\n']);
});

test('timeout error message is accessible via condition', async () => {
  const workflow = {
    name: 'timeout-condition',
    steps: [
      { id: 'slow', command: 'node -e "setTimeout(()=>{},5000)"', timeout_ms: 100, on_error: 'continue' },
      {
        id: 'check',
        command: 'node -e "process.stdout.write(JSON.stringify({err: process.env.LOBSTER_ARG_ERR}))"',
        env: { LOBSTER_ARG_ERR: '$slow.error' },
        when: '$slow.error == true',
      },
    ],
  };
  const { result } = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  const output = result.output as any[];
  assert.equal(output[0].err, 'true');
});

test('step without timeout completes normally', async () => {
  const workflow = {
    name: 'no-timeout',
    steps: [
      { id: 'fast', command: 'echo "quick"' },
    ],
  };
  const { result } = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, ['quick\n']);
});

test('step completes before timeout succeeds normally', async () => {
  const workflow = {
    name: 'fast-enough',
    steps: [
      { id: 'fast', command: 'echo "done"', timeout_ms: 10000 },
    ],
  };
  const { result } = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, ['done\n']);
});

test('timeout with on_error: skip_rest stops remaining steps', async () => {
  const workflow = {
    name: 'timeout-skip',
    steps: [
      { id: 'good', command: 'node -e "process.stdout.write(JSON.stringify({kept:true}))"' },
      { id: 'slow', command: 'node -e "setTimeout(()=>{},5000)"', timeout_ms: 100, on_error: 'skip_rest' },
      { id: 'skipped', command: 'echo "should not run"' },
    ],
  };
  const { result } = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  // Output from last successful step (good), not the timed-out step
  const output = result.output as any[];
  assert.equal(output[0].kept, true);
});

test('external abort still propagates even with timeout set', async () => {
  const controller = new AbortController();
  controller.abort();

  const workflow = {
    name: 'abort-with-timeout',
    steps: [
      { id: 'slow', command: 'sleep 5', timeout_ms: 5000, on_error: 'continue' },
    ],
  };
  await assert.rejects(
    runWorkflow(workflow, { signal: controller.signal }).then((r) => r.result),
    (err: any) => err.name === 'AbortError' || err.code === 'ABORT_ERR',
  );
});

// --- Dry-run ---

test('dry-run renders timeout and on_error in step output', async () => {
  const workflow = {
    name: 'dry-run-timeout',
    steps: [
      { id: 'fetch', command: 'curl https://example.com', timeout_ms: 5000, on_error: 'continue' },
    ],
  };
  const { stderrOutput } = await runWorkflow(workflow, { dryRun: true });
  assert.ok(stderrOutput.includes('timeout: 5000ms'), 'should show timeout');
  assert.ok(stderrOutput.includes('on_error: continue'), 'should show on_error');
});
