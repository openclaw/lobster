import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createDefaultRegistry } from '../src/commands/registry.js';
import { runWorkflowFile, loadWorkflowFile } from '../src/workflows/file.js';

async function runWorkflow(workflow: any) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-parallel-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
  return runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: 'tool',
      registry: createDefaultRegistry(),
    },
  });
}

test('parallel wait=all runs all branches and merges results', async () => {
  const workflow = {
    name: 'test-parallel',
    steps: [
      {
        id: 'fetch',
        parallel: {
          wait: 'all',
          branches: [
            { id: 'a', command: 'node -e "process.stdout.write(JSON.stringify({src:\\"a\\"}))"' },
            { id: 'b', command: 'node -e "process.stdout.write(JSON.stringify({src:\\"b\\"}))"' },
            { id: 'c', command: 'node -e "process.stdout.write(JSON.stringify({src:\\"c\\"}))"' },
          ],
        },
      },
    ],
  };
  const result = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  const output = result.output as any[];
  assert.equal(output.length, 1);
  assert.equal(output[0].a.src, 'a');
  assert.equal(output[0].b.src, 'b');
  assert.equal(output[0].c.src, 'c');
});

test('parallel wait=any returns first completed branch', async () => {
  const workflow = {
    name: 'test-parallel-any',
    steps: [
      {
        id: 'race',
        parallel: {
          wait: 'any',
          branches: [
            // fast branch returns immediately
            { id: 'fast', command: 'node -e "process.stdout.write(JSON.stringify({winner:true}))"' },
            // slow branch sleeps 5s (should not be waited for)
            { id: 'slow', command: 'node -e "setTimeout(()=>process.stdout.write(JSON.stringify({winner:false})),5000)"' },
          ],
        },
      },
    ],
  };
  const result = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
});

test('parallel branch results are accessible in subsequent steps', async () => {
  const workflow = {
    name: 'test-parallel-refs',
    steps: [
      {
        id: 'fetch',
        parallel: {
          wait: 'all',
          branches: [
            { id: 'x', command: 'node -e "process.stdout.write(JSON.stringify({val:10}))"' },
            { id: 'y', command: 'node -e "process.stdout.write(JSON.stringify({val:20}))"' },
          ],
        },
      },
      {
        id: 'use_x',
        command: 'node -e "process.stdout.write(JSON.stringify({x_val:$x.json.val}))"',
      },
    ],
  };
  const result = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  const output = result.output as any[];
  assert.equal(output[0].x_val, 10);
});

test('parallel validation rejects empty branches', async () => {
  const workflow = {
    name: 'bad',
    steps: [{ id: 'p', parallel: { branches: [] } }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-par-'));
  const filePath = path.join(tmpDir, 'w.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /non-empty branches/);
});

test('parallel validation rejects duplicate branch ids', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'p',
      parallel: {
        branches: [
          { id: 'dup', command: 'echo a' },
          { id: 'dup', command: 'echo b' },
        ],
      },
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-par-'));
  const filePath = path.join(tmpDir, 'w.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /duplicate parallel branch id/);
});

test('parallel validation rejects branch without execution', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'p',
      parallel: {
        branches: [{ id: 'empty' }],
      },
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-par-'));
  const filePath = path.join(tmpDir, 'w.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /requires run, command, or pipeline/);
});

test('parallel wait=all propagates branch failure', async () => {
  const workflow = {
    name: 'fail-test',
    steps: [{
      id: 'p',
      parallel: {
        wait: 'all',
        branches: [
          { id: 'ok', command: 'echo ok' },
          { id: 'fail', command: 'node -e "process.exit(1)"' },
        ],
      },
    }],
  };
  await assert.rejects(runWorkflow(workflow), /Parallel branch failed/);
});
