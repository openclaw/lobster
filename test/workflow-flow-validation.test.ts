import { test, expect } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadWorkflowFile } from '../src/workflows/file.js';

async function writeTmpWorkflow(name: string, content: object): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-flow-test-'));
  const file = path.join(dir, `${name}.lobster`);
  await fsp.writeFile(file, JSON.stringify(content), 'utf8');
  return file;
}

test('loadWorkflowFile: validates flow goto targets exist', async () => {
  const file = await writeTmpWorkflow('bad-goto', {
    steps: [
      { id: 'a', command: 'echo hi', flow: [{ when: '$a.json.x == true', goto: 'nonexistent' }] },
      { id: 'b', command: 'echo bye' },
    ],
  });
  await expect(loadWorkflowFile(file)).rejects.toThrow(/goto target.*nonexistent/i);
});

test('loadWorkflowFile: validates default goto target exists', async () => {
  const file = await writeTmpWorkflow('bad-default-target', {
    steps: [
      { id: 'a', command: 'echo hi', flow: [{ default: 'nonexistent' }] },
    ],
  });
  await expect(loadWorkflowFile(file)).rejects.toThrow(/goto target.*nonexistent/i);
});

test('loadWorkflowFile: validates default is last rule', async () => {
  const file = await writeTmpWorkflow('bad-default-order', {
    steps: [
      {
        id: 'a',
        command: 'echo hi',
        flow: [
          { default: 'b' },
          { when: '$a.json.x == true', goto: 'b' },
        ],
      },
      { id: 'b', command: 'echo bye' },
    ],
  });
  await expect(loadWorkflowFile(file)).rejects.toThrow(/default.*last/i);
});

test('loadWorkflowFile: accepts valid flow rules', async () => {
  const file = await writeTmpWorkflow('good-flow', {
    steps: [
      {
        id: 'a',
        command: 'echo hi',
        flow: [
          { when: '$a.json.done == true', goto: 'b' },
          { default: 'a' },
        ],
      },
      { id: 'b', command: 'echo bye' },
    ],
  });
  const wf = await loadWorkflowFile(file);
  expect(wf.steps[0].flow).toHaveLength(2);
});

test('loadWorkflowFile: validates max_iterations is positive integer', async () => {
  const file = await writeTmpWorkflow('bad-max-iter', {
    steps: [
      { id: 'a', command: 'echo hi', max_iterations: 0 },
    ],
  });
  await expect(loadWorkflowFile(file)).rejects.toThrow(/max_iterations/i);
});

test('loadWorkflowFile: validates max_iterations is integer not float', async () => {
  const file = await writeTmpWorkflow('bad-max-iter-float', {
    steps: [
      { id: 'a', command: 'echo hi', max_iterations: 1.5 },
    ],
  });
  await expect(loadWorkflowFile(file)).rejects.toThrow(/max_iterations/i);
});

test('loadWorkflowFile: accepts valid max_iterations', async () => {
  const file = await writeTmpWorkflow('good-max-iter', {
    steps: [
      { id: 'a', command: 'echo hi', max_iterations: 5 },
    ],
  });
  const wf = await loadWorkflowFile(file);
  expect(wf.steps[0].max_iterations).toBe(5);
});

test('loadWorkflowFile: flow must be array', async () => {
  const file = await writeTmpWorkflow('bad-flow-type', {
    steps: [
      { id: 'a', command: 'echo hi', flow: 'not-an-array' },
    ],
  });
  await expect(loadWorkflowFile(file)).rejects.toThrow(/flow must be an array/i);
});

test('loadWorkflowFile: flow rule must be valid shape', async () => {
  const file = await writeTmpWorkflow('bad-flow-rule', {
    steps: [
      { id: 'a', command: 'echo hi', flow: [{ invalid: 'rule' }] },
    ],
  });
  await expect(loadWorkflowFile(file)).rejects.toThrow(/invalid flow rule/i);
});
