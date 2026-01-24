import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runWorkflowFile } from '../src/workflows/file.js';
import { decodeResumeToken } from '../src/resume.js';

test('workflow file runs with approval and resume', async () => {
  const workflow = {
    name: 'sample',
    steps: [
      {
        id: 'collect',
        command: "node -e \"process.stdout.write(JSON.stringify([{value:1}]))\"",
      },
      {
        id: 'mutate',
        command: "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const items=JSON.parse(d);items[0].value=2;process.stdout.write(JSON.stringify(items));});\"",
        stdin: '$collect.stdout',
      },
      {
        id: 'approve_step',
        command: "node -e \"process.stdout.write(JSON.stringify({requiresApproval:{prompt:'Proceed?', items:[{id:1}]}}))\"",
        approval: 'required',
      },
      {
        id: 'finish',
        command: "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const items=JSON.parse(d);process.stdout.write(JSON.stringify({done:true,value:items[0].value}));});\"",
        stdin: '$mutate.stdout',
        condition: '$approve_step.approved',
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };

  const first = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: 'tool',
    },
  });

  assert.equal(first.status, 'needs_approval');
  assert.equal(first.requiresApproval?.prompt, 'Proceed?');
  assert.ok(first.requiresApproval?.resumeToken);

  const payload = decodeResumeToken(first.requiresApproval?.resumeToken ?? '');
  assert.equal(payload.kind, 'workflow-file');

  const resumed = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: 'tool',
    },
    resume: payload,
    approved: true,
  });

  assert.equal(resumed.status, 'ok');
  assert.deepEqual(resumed.output, [{ done: true, value: 2 }]);
});
