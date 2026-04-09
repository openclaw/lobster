import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runWorkflowFile, loadWorkflowFile } from '../src/workflows/file.js';

async function setupWorkflows(files: Record<string, any>) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-compose-'));
  const stateDir = path.join(tmpDir, 'state');

  const paths: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(tmpDir, name);
    await fsp.writeFile(filePath, JSON.stringify(content, null, 2), 'utf8');
    paths[name] = filePath;
  }

  return { tmpDir, stateDir, paths };
}

async function runWorkflow(filePath: string, stateDir: string, args?: Record<string, unknown>) {
  return runWorkflowFile({
    filePath,
    args,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: 'tool',
    },
  });
}

test('workflow step calls sub-workflow and gets output', async () => {
  const { stateDir, paths } = await setupWorkflows({
    'child.lobster': {
      name: 'child',
      steps: [
        { id: 'greet', command: 'node -e "process.stdout.write(JSON.stringify({msg:\\"hello from child\\"}))"' },
      ],
    },
    'parent.lobster': {
      name: 'parent',
      steps: [
        { id: 'sub', workflow: 'child.lobster' },
        {
          id: 'use',
          command: 'node -e "process.stdout.write(JSON.stringify({got: process.env.LOBSTER_ARG_MSG}))"',
          env: { LOBSTER_ARG_MSG: '$sub.json.msg' },
        },
      ],
    },
  });

  const result = await runWorkflow(paths['parent.lobster'], stateDir);
  assert.equal(result.status, 'ok');
  const output = result.output as any[];
  assert.equal(output[0].got, 'hello from child');
});

test('workflow step passes args to sub-workflow', async () => {
  const { stateDir, paths } = await setupWorkflows({
    'child.lobster': {
      name: 'child',
      args: { name: { default: 'world' } },
      steps: [
        {
          id: 'greet',
          command: 'node -e "process.stdout.write(JSON.stringify({greeting: \'hi \' + process.env.LOBSTER_ARG_NAME}))"',
        },
      ],
    },
    'parent.lobster': {
      name: 'parent',
      steps: [
        {
          id: 'sub',
          workflow: 'child.lobster',
          workflow_args: { name: 'lobster' },
        },
      ],
    },
  });

  const result = await runWorkflow(paths['parent.lobster'], stateDir);
  assert.equal(result.status, 'ok');
  const output = result.output as any[];
  assert.equal(output[0].greeting, 'hi lobster');
});

test('workflow step args can reference parent step results', async () => {
  const { stateDir, paths } = await setupWorkflows({
    'child.lobster': {
      name: 'child',
      args: { val: { default: '0' } },
      steps: [
        {
          id: 'echo',
          command: 'node -e "process.stdout.write(JSON.stringify({val: process.env.LOBSTER_ARG_VAL}))"',
        },
      ],
    },
    'parent.lobster': {
      name: 'parent',
      steps: [
        { id: 'data', command: 'node -e "process.stdout.write(JSON.stringify({num: 42}))"' },
        {
          id: 'sub',
          workflow: 'child.lobster',
          workflow_args: { val: '$data.json.num' },
        },
      ],
    },
  });

  const result = await runWorkflow(paths['parent.lobster'], stateDir);
  assert.equal(result.status, 'ok');
  const output = result.output as any[];
  assert.equal(output[0].val, '42');
});

test('workflow step with sub-workflow that fails propagates error', async () => {
  const { stateDir, paths } = await setupWorkflows({
    'bad-child.lobster': {
      name: 'bad-child',
      steps: [
        { id: 'fail', command: 'node -e "process.exit(1)"' },
      ],
    },
    'parent.lobster': {
      name: 'parent',
      steps: [
        { id: 'sub', workflow: 'bad-child.lobster' },
      ],
    },
  });

  await assert.rejects(runWorkflow(paths['parent.lobster'], stateDir), /workflow command failed/);
});

test('workflow validation rejects workflow combined with run', async () => {
  const workflow = {
    name: 'bad',
    steps: [{ id: 'x', workflow: 'child.lobster', run: 'echo hi' }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-compose-'));
  const filePath = path.join(tmpDir, 'w.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /can only define one of/);
});

test('workflow validation rejects workflow combined with pipeline', async () => {
  const workflow = {
    name: 'bad',
    steps: [{ id: 'x', workflow: 'child.lobster', pipeline: 'json' }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-compose-'));
  const filePath = path.join(tmpDir, 'w.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /can only define one of/);
});

test('sub-workflow string output is raw in stdout, not JSON-quoted', async () => {
  const { stateDir, paths } = await setupWorkflows({
    'child.lobster': {
      name: 'child',
      steps: [
        { id: 'out', command: 'echo "plain text"' },
      ],
    },
    'parent.lobster': {
      name: 'parent',
      steps: [
        { id: 'sub', workflow: 'child.lobster' },
        {
          id: 'check',
          command: 'node -e "process.stdout.write(JSON.stringify({got: process.env.LOBSTER_ARG_VAL}))"',
          env: { LOBSTER_ARG_VAL: '$sub.stdout' },
        },
      ],
    },
  });

  const result = await runWorkflow(paths['parent.lobster'], stateDir);
  assert.equal(result.status, 'ok');
  const output = result.output as any[];
  // Should be raw "plain text\n", not '"plain text\n"'
  assert.equal(output[0].got, 'plain text\n');
});

test('dry-run shows workflow steps instead of no-op', async () => {
  const { stateDir, paths } = await setupWorkflows({
    'child.lobster': {
      name: 'child',
      steps: [{ id: 'out', command: 'echo hi' }],
    },
    'parent.lobster': {
      name: 'parent',
      steps: [
        { id: 'sub', workflow: 'child.lobster', workflow_args: { key: 'val' } },
      ],
    },
  });

  const chunks: string[] = [];
  const stderr = new (await import('node:stream')).PassThrough();
  stderr.on('data', (d: Buffer) => chunks.push(d.toString()));

  const { runWorkflowFile: rwf } = await import('../src/workflows/file.js');
  await rwf({
    filePath: paths['parent.lobster'],
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: 'tool',
      dryRun: true,
    },
  });

  const dryRunOutput = chunks.join('');
  assert.ok(dryRunOutput.includes('[workflow]'), 'should show [workflow] tag');
  assert.ok(dryRunOutput.includes('child.lobster'), 'should show workflow path');
  assert.ok(dryRunOutput.includes('args: key'), 'should show workflow_args keys');
});

test('chained workflow composition', async () => {
  const { stateDir, paths } = await setupWorkflows({
    'leaf.lobster': {
      name: 'leaf',
      steps: [
        { id: 'out', command: 'node -e "process.stdout.write(JSON.stringify({leaf: true}))"' },
      ],
    },
    'middle.lobster': {
      name: 'middle',
      steps: [
        { id: 'call_leaf', workflow: 'leaf.lobster' },
        {
          id: 'wrap',
          command: 'node -e "process.stdout.write(JSON.stringify({middle: true, leaf_result: $call_leaf.json.leaf}))"',
        },
      ],
    },
    'top.lobster': {
      name: 'top',
      steps: [
        { id: 'call_middle', workflow: 'middle.lobster' },
      ],
    },
  });

  const result = await runWorkflow(paths['top.lobster'], stateDir);
  assert.equal(result.status, 'ok');
  const output = result.output as any[];
  assert.equal(output[0].middle, true);
  assert.equal(output[0].leaf_result, true);
});
