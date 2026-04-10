import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';

import { runWorkflowFile, loadWorkflowFile } from '../src/workflows/file.js';
import { withRetry, resolveRetryConfig } from '../src/core/retry.js';

// --- Retry utility unit tests ---

test('resolveRetryConfig fills defaults', () => {
  const config = resolveRetryConfig(undefined);
  assert.equal(config.max, 1);
  assert.equal(config.backoff, 'fixed');
  assert.equal(config.delay_ms, 1000);
  assert.equal(config.max_delay_ms, 30000);
  assert.equal(config.jitter, false);
});

test('resolveRetryConfig preserves provided values', () => {
  const config = resolveRetryConfig({ max: 5, backoff: 'exponential', jitter: true });
  assert.equal(config.max, 5);
  assert.equal(config.backoff, 'exponential');
  assert.equal(config.jitter, true);
  assert.equal(config.delay_ms, 1000); // default
});

test('withRetry succeeds on first try', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => { calls++; return 'ok'; },
    resolveRetryConfig({ max: 3 }),
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries and succeeds', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    },
    resolveRetryConfig({ max: 3, delay_ms: 10 }),
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry throws after max exhausted', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => { calls++; throw new Error('always fails'); },
      resolveRetryConfig({ max: 2, delay_ms: 10 }),
    ),
    /always fails/,
  );
  assert.equal(calls, 2);
});

test('withRetry never retries abort errors', async () => {
  let calls = 0;
  const abortErr = new DOMException('aborted', 'AbortError');
  await assert.rejects(
    withRetry(
      async () => { calls++; throw abortErr; },
      resolveRetryConfig({ max: 3, delay_ms: 10 }),
    ),
    (err: any) => err.name === 'AbortError',
  );
  assert.equal(calls, 1);
});

test('withRetry calls onRetry callback', async () => {
  const retries: number[] = [];
  let calls = 0;
  await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'ok';
    },
    resolveRetryConfig({ max: 3, delay_ms: 10 }),
    { onRetry: (attempt) => retries.push(attempt) },
  );
  assert.deepEqual(retries, [1, 2]);
});

// --- Validation tests ---

async function loadWorkflow(workflow: any) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-retry-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  return loadWorkflowFile(filePath);
}

test('retry validation rejects non-object', async () => {
  await assert.rejects(
    loadWorkflow({ name: 'bad', steps: [{ id: 'x', command: 'echo', retry: 'yes' }] }),
    /retry must be an object/,
  );
});

test('retry validation rejects non-integer max', async () => {
  await assert.rejects(
    loadWorkflow({ name: 'bad', steps: [{ id: 'x', command: 'echo', retry: { max: 1.5 } }] }),
    /retry.max must be a positive integer/,
  );
});

test('retry validation rejects max < 1', async () => {
  await assert.rejects(
    loadWorkflow({ name: 'bad', steps: [{ id: 'x', command: 'echo', retry: { max: 0 } }] }),
    /retry.max must be a positive integer/,
  );
});

test('retry validation rejects invalid backoff', async () => {
  await assert.rejects(
    loadWorkflow({ name: 'bad', steps: [{ id: 'x', command: 'echo', retry: { backoff: 'linear' } }] }),
    /retry.backoff must be "fixed" or "exponential"/,
  );
});

test('retry validation rejects negative delay_ms', async () => {
  await assert.rejects(
    loadWorkflow({ name: 'bad', steps: [{ id: 'x', command: 'echo', retry: { delay_ms: -1 } }] }),
    /retry.delay_ms must be a finite non-negative number/,
  );
});

test('retry validation rejects non-boolean jitter', async () => {
  await assert.rejects(
    loadWorkflow({ name: 'bad', steps: [{ id: 'x', command: 'echo', retry: { jitter: 'yes' } }] }),
    /retry.jitter must be a boolean/,
  );
});

test('retry validation accepts valid config', async () => {
  const wf = await loadWorkflow({
    name: 'ok',
    steps: [{ id: 'x', command: 'echo', retry: { max: 3, backoff: 'exponential', delay_ms: 500, jitter: true } }],
  });
  assert.ok(wf.steps[0].retry);
});

// --- Integration tests ---

async function runWorkflow(workflow: any) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-retry-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const stderrChunks: string[] = [];
  const stderr = new PassThrough();
  stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()));

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: 'tool',
    },
  });
  return { result, stderrOutput: stderrChunks.join('') };
}

test('step retries and succeeds after transient failure', async () => {
  // Script that fails twice then succeeds on third run using a counter file
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-retry-'));
  const counterFile = path.join(tmpDir, 'counter');
  await fsp.writeFile(counterFile, '0', 'utf8');

  const workflow = {
    name: 'retry-succeed',
    steps: [{
      id: 'flaky',
      command: `node -e "const fs=require('fs');const c=Number(fs.readFileSync('${counterFile}','utf8'))+1;fs.writeFileSync('${counterFile}',String(c));if(c<3){process.exit(1);}process.stdout.write(JSON.stringify({attempt:c}))"`,
      retry: { max: 3, delay_ms: 50 },
    }],
  };
  const { result, stderrOutput } = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  const output = result.output as any[];
  assert.equal(output[0].attempt, 3);
  assert.ok(stderrOutput.includes('[RETRY]'), 'should log retry attempts');
});

test('step exhausts retries and throws', async () => {
  const workflow = {
    name: 'retry-exhaust',
    steps: [{
      id: 'fail',
      command: 'node -e "process.exit(1)"',
      retry: { max: 2, delay_ms: 50 },
    }],
  };
  await assert.rejects(
    runWorkflow(workflow).then((r) => r.result),
    /workflow command failed/,
  );
});

test('step without retry fails immediately (no retry)', async () => {
  const workflow = {
    name: 'no-retry',
    steps: [{ id: 'fail', command: 'node -e "process.exit(1)"' }],
  };
  await assert.rejects(
    runWorkflow(workflow).then((r) => r.result),
    /workflow command failed/,
  );
});

test('dry-run renders retry config', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-retry-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  const workflow = {
    name: 'dry-run-retry',
    steps: [{ id: 'fetch', command: 'curl https://example.com', retry: { max: 3, backoff: 'exponential', delay_ms: 1000 } }],
  };
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const stderrChunks: string[] = [];
  const stderr = new PassThrough();
  stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()));

  await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: 'tool',
      dryRun: true,
    },
  });

  const output = stderrChunks.join('');
  assert.ok(output.includes('retry:'), 'should show retry config');
  assert.ok(output.includes('3 attempts'), 'should show max attempts');
  assert.ok(output.includes('exponential'), 'should show backoff type');
});
