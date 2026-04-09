import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createDefaultRegistry } from '../src/commands/registry.js';
import { runWorkflowFile, loadWorkflowFile } from '../src/workflows/file.js';

async function runWorkflow(workflow: any, args?: Record<string, unknown>) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
  const result = await runWorkflowFile({
    filePath,
    args,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: 'tool',
      registry: createDefaultRegistry(),
    },
  });
  return result;
}

test('for_each iterates over items and collects results', async () => {
  const workflow = {
    name: 'test-foreach',
    steps: [
      {
        id: 'data',
        command: 'node -e "process.stdout.write(JSON.stringify([{name:\\"a\\"},{name:\\"b\\"}]))"',
      },
      {
        id: 'process',
        for_each: '$data.json',
        steps: [
          {
            id: 'transform',
            command: 'node -e "process.stdout.write(JSON.stringify({upper: process.env.LOBSTER_ARG_ITEM_NAME}))"',
            env: { LOBSTER_ARG_ITEM_NAME: '$item.json.name' },
          },
        ],
      },
    ],
  };
  const result = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  assert.ok(Array.isArray(result.output));
  // Output is the for_each collected results array
  const output = result.output as any[];
  assert.equal(output.length, 2);
  assert.equal(output[0].index, 0);
  assert.equal(output[1].index, 1);
});

test('for_each with shell command per item', async () => {
  const workflow = {
    name: 'test-foreach-shell',
    steps: [
      {
        id: 'items',
        command: 'node -e "process.stdout.write(JSON.stringify([1,2,3]))"',
      },
      {
        id: 'doubled',
        for_each: '$items.json',
        item_var: 'num',
        steps: [
          {
            id: 'double',
            command: 'node -e "const n=$num.json;process.stdout.write(JSON.stringify({result:n*2}))"',
          },
        ],
      },
    ],
  };
  const result = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  const output = result.output as any[];
  assert.equal(output.length, 3);
  assert.equal(output[0].double.result, 2);
  assert.equal(output[1].double.result, 4);
  assert.equal(output[2].double.result, 6);
});

test('for_each validation rejects empty steps', async () => {
  const workflow = {
    name: 'bad',
    steps: [{ id: 'loop', for_each: '$x.json', steps: [] }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /for_each requires a non-empty steps/);
});

test('for_each validation rejects approval in sub-steps', async () => {
  const workflow = {
    name: 'bad',
    steps: [
      {
        id: 'loop',
        for_each: '$x.json',
        steps: [{ id: 'bad_step', approval: true, command: 'echo hi' }],
      },
    ],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /cannot contain approval or input/);
});

test('for_each with custom item_var and index_var', async () => {
  const workflow = {
    name: 'custom-vars',
    steps: [
      {
        id: 'data',
        command: 'node -e "process.stdout.write(JSON.stringify([\\"x\\",\\"y\\"]))"',
      },
      {
        id: 'loop',
        for_each: '$data.json',
        item_var: 'letter',
        index_var: 'idx',
        steps: [
          {
            id: 'echo',
            command: 'node -e "process.stdout.write(JSON.stringify({letter:process.env.LOBSTER_ARG_LETTER, idx:process.env.LOBSTER_ARG_IDX}))"',
            env: { LOBSTER_ARG_LETTER: '$letter.json', LOBSTER_ARG_IDX: '$idx.json' },
          },
        ],
      },
    ],
  };
  const result = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  const output = result.output as any[];
  assert.equal(output.length, 2);
  assert.equal(output[0].letter, 'x');
  assert.equal(output[1].letter, 'y');
});

test('for_each throws on non-array input', async () => {
  const workflow = {
    name: 'bad-input',
    steps: [
      {
        id: 'data',
        command: 'node -e "process.stdout.write(JSON.stringify({not:\\"array\\"}))"',
      },
      {
        id: 'loop',
        for_each: '$data.json',
        steps: [{ id: 'x', command: 'echo hi' }],
      },
    ],
  };
  await assert.rejects(runWorkflow(workflow), /expected array/);
});
