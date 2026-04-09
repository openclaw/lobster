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

test('for_each validation rejects approval on the for_each step itself', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'loop',
      for_each: '$x.json',
      approval: true,
      steps: [{ id: 'x', command: 'echo hi' }],
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /for_each steps cannot define approval/);
});

test('for_each validation rejects sub-steps without execution', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'loop',
      for_each: '$x.json',
      steps: [{ id: 'empty_sub' }],
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /requires run, command, or pipeline/);
});

test('for_each validation rejects input on the for_each step', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'loop',
      for_each: '$x.json',
      input: { prompt: 'test?', responseSchema: { type: 'object' } },
      steps: [{ id: 'x', command: 'echo hi' }],
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /for_each steps cannot define input/);
});

test('for_each validation rejects run/command/pipeline alongside for_each', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'loop',
      for_each: '$x.json',
      run: 'echo ignored',
      steps: [{ id: 'x', command: 'echo hi' }],
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /for_each cannot also define run, command, or pipeline/);
});

test('for_each validation rejects sub-steps with multiple executors', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'loop',
      for_each: '$x.json',
      steps: [{ id: 'multi', run: 'echo a', pipeline: 'json' }],
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /can only define one of run, command, or pipeline/);
});

test('for_each validation rejects non-string command in sub-steps', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'loop',
      for_each: '$x.json',
      steps: [{ id: 'bad_type', command: 123 }],
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /command must be a string/);
});

test('for_each validation rejects non-integer batch_size', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'loop',
      for_each: '$x.json',
      batch_size: 1.5,
      steps: [{ id: 'x', command: 'echo hi' }],
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /batch_size must be a positive integer/);
});

test('for_each validation rejects Infinity batch_size', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'loop',
      for_each: '$x.json',
      batch_size: Infinity,
      steps: [{ id: 'x', command: 'echo hi' }],
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /batch_size must be a positive integer/);
});

test('for_each validation rejects NaN pause_ms', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'loop',
      for_each: '$x.json',
      pause_ms: NaN,
      steps: [{ id: 'x', command: 'echo hi' }],
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /pause_ms must be a finite non-negative number/);
});

test('for_each propagates step-level env to sub-steps', async () => {
  const workflow = {
    name: 'env-test',
    steps: [
      {
        id: 'data',
        command: 'node -e "process.stdout.write(JSON.stringify([1,2]))"',
      },
      {
        id: 'loop',
        for_each: '$data.json',
        env: { MY_FLAG: 'from_loop' },
        steps: [
          {
            id: 'check',
            command: 'node -e "process.stdout.write(JSON.stringify({flag: process.env.MY_FLAG}))"',
          },
        ],
      },
    ],
  };
  const result = await runWorkflow(workflow);
  assert.equal(result.status, 'ok');
  const output = result.output as any[];
  assert.equal(output.length, 2);
  assert.equal(output[0].check.flag, 'from_loop');
  assert.equal(output[1].check.flag, 'from_loop');
});

test('for_each validation rejects duplicate sub-step ids', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'loop',
      for_each: '$x.json',
      steps: [
        { id: 'dup', command: 'echo a' },
        { id: 'dup', command: 'echo b' },
      ],
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /duplicate for_each sub-step id: dup/);
});

test('for_each validation rejects sub-step id shadowing item_var', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'loop',
      for_each: '$x.json',
      steps: [{ id: 'item', command: 'echo hi' }],
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /conflicts with loop variable/);
});

test('for_each validation rejects item_var equal to index_var', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'loop',
      for_each: '$x.json',
      item_var: 'x',
      index_var: 'x',
      steps: [{ id: 'a', command: 'echo hi' }],
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /item_var and index_var cannot be the same/);
});

test('for_each dry-run shows loop structure', async () => {
  const workflow = {
    name: 'dry-run-foreach',
    steps: [
      { id: 'data', command: 'echo "[1,2]"' },
      {
        id: 'loop',
        for_each: '$data.json',
        batch_size: 2,
        steps: [
          { id: 'process', command: 'echo hi' },
          { id: 'analyze', pipeline: 'json' },
        ],
      },
    ],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const { PassThrough } = await import('node:stream');
  const { createDefaultRegistry } = await import('../src/commands/registry.js');
  const chunks: string[] = [];
  const stderr = new PassThrough();
  stderr.on('data', (d: Buffer) => chunks.push(d.toString()));

  await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: 'tool',
      registry: createDefaultRegistry(),
      dryRun: true,
    },
  });

  const output = chunks.join('');
  assert.ok(output.includes('[for_each]'), 'should show [for_each] tag');
  assert.ok(output.includes('sub-steps: 2'), 'should show sub-step count');
  assert.ok(output.includes('batch_size: 2'), 'should show batch_size');
  assert.ok(output.includes('process'), 'should list sub-steps');
});

test('for_each validation rejects stdin on the for_each step', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'loop',
      for_each: '$x.json',
      stdin: '$other.stdout',
      steps: [{ id: 'a', command: 'echo hi' }],
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /for_each steps cannot define stdin/);
});

test('for_each validation rejects whitespace-only run', async () => {
  const workflow = {
    name: 'bad',
    steps: [{
      id: 'loop',
      for_each: '$x.json',
      steps: [{ id: 'blank', run: '   ' }],
    }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-foreach-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow), 'utf8');
  await assert.rejects(loadWorkflowFile(filePath), /requires run, command, or pipeline/);
});
