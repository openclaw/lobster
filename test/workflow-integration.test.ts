import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runWorkflowFile } from '../src/workflows/file.js';
import { decodeResumeToken } from '../src/resume.js';
import type { WorkflowResumePayload } from '../src/workflows/file.js';

async function makeTestEnv() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-integ-'));
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

function decodeWorkflowResumeToken(token: string): WorkflowResumePayload {
  const payload = decodeResumeToken(token);
  if (payload.kind !== 'workflow-file') {
    throw new Error(`Expected workflow resume token, got ${payload.kind}`);
  }
  return payload;
}

test('integration: sub-workflow in a flow loop — 3 iterations then done', async () => {
  const { dir, env } = await makeTestEnv();
  const countFile = path.join(dir, 'count.txt');
  await fsp.writeFile(countFile, '0', 'utf8');
  const envWithCount = { ...env, COUNT_FILE: countFile };

  // Child: reads count, increments, returns {done: true} when count >= 3
  await writeWorkflow(dir, 'child', {
    steps: [
      {
        id: 'step',
        command: `node -e "const fs=require('fs'),f=process.env.COUNT_FILE;const c=parseInt(fs.readFileSync(f,'utf8'))+1;fs.writeFileSync(f,String(c));process.stdout.write(JSON.stringify({count:c,done:c>=3}))"`,
      },
    ],
  });

  const parentPath = await writeWorkflow(dir, 'parent', {
    steps: [
      {
        id: 'loop',
        command: 'lobster.run --name child',
        max_iterations: 10,
        flow: [
          { when: '$loop.json.done == true', goto: 'finish' },
          { default: 'loop' },
        ],
      },
      {
        id: 'finish',
        command: 'node -e "process.stdout.write(JSON.stringify({all_done:true}))"',
      },
    ],
  });

  const result = await runWorkflowFile({ filePath: parentPath, ctx: { ...testCtx, env: envWithCount } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ all_done: true }]);
  assert.equal(parseInt(await fsp.readFile(countFile, 'utf8')), 3);
});

test('integration: three-level nesting — grandparent → parent → child', async () => {
  const { dir, env } = await makeTestEnv();

  await writeWorkflow(dir, 'child', {
    steps: [
      { id: 'out', command: "node -e \"process.stdout.write(JSON.stringify({level:'child'}))\"" },
    ],
  });

  await writeWorkflow(dir, 'parent', {
    steps: [
      { id: 'run-child', command: 'lobster.run --name child' },
      {
        id: 'wrap',
        command: "node -e \"process.stdout.write(JSON.stringify({level:'parent',child:true}))\"",
      },
    ],
  });

  const grandparentPath = await writeWorkflow(dir, 'grandparent', {
    steps: [
      { id: 'run-parent', command: 'lobster.run --name parent' },
      {
        id: 'final',
        command: "node -e \"process.stdout.write(JSON.stringify({level:'grandparent',done:true}))\"",
      },
    ],
  });

  const result = await runWorkflowFile({ filePath: grandparentPath, ctx: { ...testCtx, env } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ level: 'grandparent', done: true }]);
});

test('integration: nested halt inside a loop with resume', async () => {
  const { dir, env } = await makeTestEnv();
  const countFile = path.join(dir, 'count.txt');
  await fsp.writeFile(countFile, '0', 'utf8');
  const envWithCount = { ...env, COUNT_FILE: countFile };

  // Child requires approval on each call
  await writeWorkflow(dir, 'approvable-child', {
    steps: [
      {
        id: 'gate',
        command: `node -e "const fs=require('fs'),f=process.env.COUNT_FILE;const c=parseInt(fs.readFileSync(f,'utf8'))+1;fs.writeFileSync(f,String(c));process.stdout.write(JSON.stringify({requiresApproval:{prompt:'Approve iteration '+c+'?',items:[]},count:c}))"`,
        approval: 'required',
      },
      {
        id: 'result',
        command: `node -e "const fs=require('fs'),f=process.env.COUNT_FILE;const c=parseInt(fs.readFileSync(f,'utf8'));process.stdout.write(JSON.stringify({done:c>=2}))"`,
        condition: '$gate.approved',
      },
    ],
  });

  const parentPath = await writeWorkflow(dir, 'parent', {
    steps: [
      {
        id: 'loop',
        command: 'lobster.run --name approvable-child',
        max_iterations: 5,
        flow: [
          { when: '$loop.json.done == true', goto: 'finish' },
          { default: 'loop' },
        ],
      },
      {
        id: 'finish',
        command: 'node -e "process.stdout.write(JSON.stringify({completed:true}))"',
      },
    ],
  });

  // First run — halts at child's approval gate
  const first = await runWorkflowFile({ filePath: parentPath, ctx: { ...testCtx, env: envWithCount } });
  assert.equal(first.status, 'needs_approval');
  assert.ok(first.requiresApproval?.prompt?.includes('Approve iteration 1'));

  const payload1 = decodeWorkflowResumeToken(first.requiresApproval?.resumeToken ?? '');
  // Resume iteration 1 — child completes (done: false), flow loops back, child halts again
  const second = await runWorkflowFile({
    filePath: parentPath,
    ctx: { ...testCtx, env: envWithCount },
    resume: payload1,
    approved: true,
  });
  assert.equal(second.status, 'needs_approval');
  assert.ok(second.requiresApproval?.prompt?.includes('Approve iteration 2'));

  const payload2 = decodeWorkflowResumeToken(second.requiresApproval?.resumeToken ?? '');
  // Resume iteration 2 — child completes (done: true), flow goes to finish
  const third = await runWorkflowFile({
    filePath: parentPath,
    ctx: { ...testCtx, env: envWithCount },
    resume: payload2,
    approved: true,
  });
  assert.equal(third.status, 'ok');
  assert.deepEqual(third.output, [{ completed: true }]);
});

test('integration: flow routes to correct branch based on condition', async () => {
  const { dir, env } = await makeTestEnv();

  // score=85: >= 90 is false → default to grade-normal.
  // Each branch flows to 'done' (when: false) so lastStepId stays on the grade step.
  const parentPath = await writeWorkflow(dir, 'flow-cond', {
    steps: [
      {
        id: 'check',
        command: 'node -e "process.stdout.write(JSON.stringify({score:85}))"',
        flow: [
          { when: '$check.json.score >= 90', goto: 'grade-high' },
          { default: 'grade-normal' },
        ],
      },
      { id: 'grade-high', command: "node -e \"process.stdout.write(JSON.stringify({grade:'A'}))\"", flow: [{ default: 'done' }] },
      { id: 'grade-normal', command: "node -e \"process.stdout.write(JSON.stringify({grade:'B'}))\"", flow: [{ default: 'done' }] },
      { id: 'done', when: false, command: 'echo noop' },
    ],
  });

  const result = await runWorkflowFile({ filePath: parentPath, ctx: { ...testCtx, env } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ grade: 'B' }]);
});

test('integration: flow + approval + lobster.run combined', async () => {
  const { dir, env } = await makeTestEnv();

  await writeWorkflow(dir, 'analyzer', {
    steps: [
      { id: 'analyze', command: 'node -e "process.stdout.write(JSON.stringify({confidence:0.95}))"' },
    ],
  });

  // Both branches flow to 'done' (when: false sentinel) so lastStepId stays on the branch step
  const parentPath = await writeWorkflow(dir, 'combined', {
    steps: [
      {
        id: 'run',
        command: 'lobster.run --name analyzer',
        approval: 'required',
        flow: [
          { when: '$run.json.confidence > 0.9', goto: 'auto-approve' },
          { default: 'manual-review' },
        ],
      },
      { id: 'auto-approve', command: "node -e \"process.stdout.write(JSON.stringify({path:'auto'}))\"", flow: [{ default: 'done' }] },
      { id: 'manual-review', command: "node -e \"process.stdout.write(JSON.stringify({path:'manual'}))\"", flow: [{ default: 'done' }] },
      { id: 'done', when: false, command: 'echo noop' },
    ],
  });

  // First run — child runs, then approval gate halts
  const first = await runWorkflowFile({ filePath: parentPath, ctx: { ...testCtx, env } });
  assert.equal(first.status, 'needs_approval');

  const payload = decodeWorkflowResumeToken(first.requiresApproval?.resumeToken ?? '');
  // Resume with approval — flow evaluates $run.json.confidence > 0.9 → true → auto-approve
  const second = await runWorkflowFile({
    filePath: parentPath,
    ctx: { ...testCtx, env },
    resume: payload,
    approved: true,
  });
  assert.equal(second.status, 'ok');
  assert.deepEqual(second.output, [{ path: 'auto' }]);
});
