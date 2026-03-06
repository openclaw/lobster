import { test, expect } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runWorkflowFile } from '../src/workflows/file.js';
import { decodeResumeToken } from '../src/resume.js';

async function makeTestEnv() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-sw-'));
  const stateDir = path.join(dir, 'state');
  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
  return { dir, env };
}

const testCtx = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  mode: 'tool' as const,
};

async function writeWorkflow(dir: string, name: string, content: object): Promise<string> {
  const filePath = path.join(dir, `${name}.lobster`);
  await fsp.writeFile(filePath, JSON.stringify(content), 'utf8');
  return filePath;
}

test('lobster.run: basic child execution with args', async () => {
  const { dir, env } = await makeTestEnv();

  await writeWorkflow(dir, 'child', {
    args: { x: { default: 0 } },
    steps: [
      {
        id: 'result',
        command: 'node -e "process.stdout.write(JSON.stringify({value: parseInt(process.env.X||0)}))"',
        env: { X: '${x}' },
      },
    ],
  });

  const parentPath = await writeWorkflow(dir, 'parent', {
    steps: [
      {
        id: 'run-child',
        command: `lobster.run --name child --args-json '{"x": 42}'`,
      },
    ],
  });

  const result = await runWorkflowFile({ filePath: parentPath, ctx: { ...testCtx, env } });
  expect(result.status).toBe('ok');
  expect(result.output).toEqual([{ value: 42 }]);
});

test('lobster.run: child output as parent step result — single item unwrapped', async () => {
  const { dir, env } = await makeTestEnv();

  await writeWorkflow(dir, 'child', {
    steps: [
      {
        id: 'out',
        command: 'node -e "process.stdout.write(JSON.stringify({done:true}))"',
      },
    ],
  });

  const parentPath = await writeWorkflow(dir, 'parent', {
    steps: [
      { id: 'run', command: 'lobster.run --name child' },
    ],
  });

  const result = await runWorkflowFile({ filePath: parentPath, ctx: { ...testCtx, env } });
  expect(result.status).toBe('ok');
  expect(result.output).toEqual([{ done: true }]);
});

test('lobster.run: child halt bubbles to parent', async () => {
  const { dir, env } = await makeTestEnv();

  await writeWorkflow(dir, 'child', {
    steps: [
      {
        id: 'approve',
        command: 'node -e "process.stdout.write(JSON.stringify({requiresApproval:{prompt:\'Approve child?\',items:[]}}))"',
        approval: 'required',
      },
      {
        id: 'after',
        command: 'node -e "process.stdout.write(JSON.stringify({done:true}))"',
        condition: '$approve.approved',
      },
    ],
  });

  const parentPath = await writeWorkflow(dir, 'parent', {
    steps: [
      { id: 'run', command: 'lobster.run --name child' },
      { id: 'done', command: 'node -e "process.stdout.write(JSON.stringify({parent:true}))"' },
    ],
  });

  const result = await runWorkflowFile({ filePath: parentPath, ctx: { ...testCtx, env } });
  expect(result.status).toBe('needs_approval');
  expect(result.requiresApproval?.prompt).toBe('Approve child?');
  expect(result.requiresApproval?.resumeToken).toBeTruthy();
});

test('lobster.run: resume after child halt', async () => {
  const { dir, env } = await makeTestEnv();

  await writeWorkflow(dir, 'child', {
    steps: [
      {
        id: 'approve',
        command: 'node -e "process.stdout.write(JSON.stringify({requiresApproval:{prompt:\'Approve?\',items:[]}}))"',
        approval: 'required',
      },
      {
        id: 'result',
        command: 'node -e "process.stdout.write(JSON.stringify({childDone:true}))"',
        condition: '$approve.approved',
      },
    ],
  });

  const parentPath = await writeWorkflow(dir, 'parent', {
    steps: [
      { id: 'run', command: 'lobster.run --name child' },
      { id: 'finish', command: 'node -e "process.stdout.write(JSON.stringify({parentDone:true}))"' },
    ],
  });

  const first = await runWorkflowFile({ filePath: parentPath, ctx: { ...testCtx, env } });
  expect(first.status).toBe('needs_approval');

  const payload = decodeResumeToken(first.requiresApproval?.resumeToken ?? '');
  const second = await runWorkflowFile({
    filePath: parentPath,
    ctx: { ...testCtx, env },
    resume: payload,
    approved: true,
  });

  expect(second.status).toBe('ok');
  expect(second.output).toEqual([{ parentDone: true }]);
});

test('lobster.run: --file flag with explicit path', async () => {
  const { dir, env } = await makeTestEnv();

  const childPath = await writeWorkflow(dir, 'explicit-child', {
    steps: [
      { id: 'out', command: 'node -e "process.stdout.write(JSON.stringify({explicit:true}))"' },
    ],
  });

  const parentPath = await writeWorkflow(dir, 'parent-file', {
    steps: [
      { id: 'run', command: `lobster.run --file ${childPath}` },
    ],
  });

  const result = await runWorkflowFile({ filePath: parentPath, ctx: { ...testCtx, env } });
  expect(result.status).toBe('ok');
  expect(result.output).toEqual([{ explicit: true }]);
});

test('lobster.run: depth limit', async () => {
  const { dir, env } = await makeTestEnv();

  // A workflow that calls itself recursively
  const selfPath = path.join(dir, 'self.lobster');
  await fsp.writeFile(selfPath, JSON.stringify({
    steps: [
      { id: 'recurse', command: `lobster.run --file ${selfPath}` },
    ],
  }), 'utf8');

  await expect(
    runWorkflowFile({ filePath: selfPath, ctx: { ...testCtx, env } }),
  ).rejects.toThrow(/depth exceeded|nesting depth/i);
});

test('lobster.run: env inheritance — child sees parent env', async () => {
  const { dir, env } = await makeTestEnv();

  await writeWorkflow(dir, 'child', {
    steps: [
      {
        id: 'out',
        command: 'node -e "process.stdout.write(JSON.stringify({val:process.env.PARENT_VAR}))"',
      },
    ],
  });

  const parentPath = await writeWorkflow(dir, 'parent', {
    steps: [
      { id: 'run', command: 'lobster.run --name child', env: { PARENT_VAR: 'hello' } },
    ],
  });

  const result = await runWorkflowFile({ filePath: parentPath, ctx: { ...testCtx, env } });
  expect(result.status).toBe('ok');
  expect(result.output).toEqual([{ val: 'hello' }]);
});

test('lobster.run: child env overrides parent env', async () => {
  const { dir, env } = await makeTestEnv();

  await writeWorkflow(dir, 'child', {
    env: { MY_VAR: 'from-child-workflow' },
    steps: [
      {
        id: 'out',
        command: 'node -e "process.stdout.write(JSON.stringify({val:process.env.MY_VAR}))"',
      },
    ],
  });

  const parentPath = await writeWorkflow(dir, 'parent', {
    steps: [
      { id: 'run', command: 'lobster.run --name child', env: { MY_VAR: 'from-parent-step' } },
    ],
  });

  const result = await runWorkflowFile({ filePath: parentPath, ctx: { ...testCtx, env } });
  expect(result.status).toBe('ok');
  expect(result.output).toEqual([{ val: 'from-child-workflow' }]);
});
