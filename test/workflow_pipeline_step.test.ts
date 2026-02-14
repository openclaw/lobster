import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadWorkflowFile, runWorkflowFile } from '../src/workflows/file.js';
import { createDefaultRegistry } from '../src/commands/registry.js';
import { decodeResumeToken } from '../src/resume.js';

function makeCtx({ registry = undefined, mode = 'tool' as const } = {}) {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: { ...process.env },
    mode,
    registry,
  };
}

async function writeTmpWorkflow(workflow: unknown) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-wf-pipeline-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');
  return { filePath, stateDir };
}

// Helper: produce JSON via node -e inside exec --shell, avoiding shell quoting issues.
// The outer double quotes are stripped by the pipeline tokenizer; the inner single quotes
// protect the JS expression from the shell.
function execJson(jsExpr: string) {
  return `exec --json --shell "node -e '${jsExpr}'"`;
}

test('pipeline step: basic single command via registry', async () => {
  const registry = createDefaultRegistry();
  const workflow = {
    steps: [
      {
        id: 'fetch',
        pipeline: execJson('process.stdout.write(JSON.stringify([{val:42}]))'),
      },
    ],
  };

  const { filePath, stateDir } = await writeTmpWorkflow(workflow);
  const ctx = makeCtx({ registry });
  ctx.env.LOBSTER_STATE_DIR = stateDir;

  const result = await runWorkflowFile({ filePath, ctx });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ val: 42 }]);
});

test('pipeline step: pipe chaining with where filter', async () => {
  const registry = createDefaultRegistry();
  const workflow = {
    steps: [
      {
        id: 'filtered',
        pipeline: execJson('process.stdout.write(JSON.stringify([{a:1},{a:2},{a:3}]))') + ' | where a>=2',
      },
    ],
  };

  const { filePath, stateDir } = await writeTmpWorkflow(workflow);
  const ctx = makeCtx({ registry });
  ctx.env.LOBSTER_STATE_DIR = stateDir;

  const result = await runWorkflowFile({ filePath, ctx });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ a: 2 }, { a: 3 }]);
});

test('pipeline step: cross-step reference from command to pipeline output', async () => {
  const registry = createDefaultRegistry();
  const workflow = {
    steps: [
      {
        id: 'source',
        pipeline: execJson('process.stdout.write(JSON.stringify({key:42}))'),
      },
      {
        id: 'echo_it',
        command: "node -e \"process.stdout.write(JSON.stringify({got: $source.json}))\"",
      },
    ],
  };

  const { filePath, stateDir } = await writeTmpWorkflow(workflow);
  const ctx = makeCtx({ registry });
  ctx.env.LOBSTER_STATE_DIR = stateDir;

  const result = await runWorkflowFile({ filePath, ctx });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ got: { key: 42 } }]);
});

test('pipeline step: stdin piping from command to pipeline', async () => {
  const registry = createDefaultRegistry();
  const workflow = {
    steps: [
      {
        id: 'produce',
        command: "node -e \"process.stdout.write(JSON.stringify([{x:1},{x:2},{x:3}]))\"",
      },
      {
        id: 'filter',
        pipeline: 'where x>1',
        stdin: '$produce.stdout',
      },
    ],
  };

  const { filePath, stateDir } = await writeTmpWorkflow(workflow);
  const ctx = makeCtx({ registry });
  ctx.env.LOBSTER_STATE_DIR = stateDir;

  const result = await runWorkflowFile({ filePath, ctx });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ x: 2 }, { x: 3 }]);
});

test('pipeline step: validation rejects both command and pipeline', async () => {
  const workflow = {
    steps: [
      {
        id: 'bad',
        command: 'echo hello',
        pipeline: 'exec --json "echo 1"',
      },
    ],
  };

  const { filePath } = await writeTmpWorkflow(workflow);
  await assert.rejects(
    () => loadWorkflowFile(filePath),
    { message: 'Workflow step "bad" has both "command" and "pipeline" -- use exactly one' },
  );
});

test('pipeline step: validation rejects neither command nor pipeline', async () => {
  const workflow = {
    steps: [
      {
        id: 'empty',
      },
    ],
  };

  const { filePath } = await writeTmpWorkflow(workflow);
  await assert.rejects(
    () => loadWorkflowFile(filePath),
    { message: 'Workflow step "empty" requires either a "command" or "pipeline" field' },
  );
});

test('pipeline step: step-level cwd on pipeline step throws', async () => {
  const registry = createDefaultRegistry();
  const workflow = {
    steps: [
      {
        id: 'bad_cwd',
        pipeline: execJson('process.stdout.write(JSON.stringify([1]))'),
        cwd: '/tmp',
      },
    ],
  };

  const { filePath, stateDir } = await writeTmpWorkflow(workflow);
  const ctx = makeCtx({ registry });
  ctx.env.LOBSTER_STATE_DIR = stateDir;

  await assert.rejects(
    () => runWorkflowFile({ filePath, ctx }),
    { message: 'Workflow step "bad_cwd": "cwd" is not supported for pipeline steps' },
  );
});

test('pipeline step: workflow-level cwd on pipeline step throws', async () => {
  const registry = createDefaultRegistry();
  const workflow = {
    cwd: '/tmp',
    steps: [
      {
        id: 'inherits_cwd',
        pipeline: execJson('process.stdout.write(JSON.stringify([1]))'),
      },
    ],
  };

  const { filePath, stateDir } = await writeTmpWorkflow(workflow);
  const ctx = makeCtx({ registry });
  ctx.env.LOBSTER_STATE_DIR = stateDir;

  await assert.rejects(
    () => runWorkflowFile({ filePath, ctx }),
    { message: 'Workflow step "inherits_cwd": "cwd" is not supported for pipeline steps' },
  );
});

test('pipeline step: missing registry throws clear error', async () => {
  const workflow = {
    steps: [
      {
        id: 'needs_registry',
        pipeline: execJson('process.stdout.write(JSON.stringify([1]))'),
      },
    ],
  };

  const { filePath, stateDir } = await writeTmpWorkflow(workflow);
  const ctx = makeCtx(); // no registry
  ctx.env.LOBSTER_STATE_DIR = stateDir;

  await assert.rejects(
    () => runWorkflowFile({ filePath, ctx }),
    { message: 'pipeline step requires a registry in the run context' },
  );
});

test('pipeline step: approval triggers halt and resume', async () => {
  const registry = createDefaultRegistry();
  const workflow = {
    steps: [
      {
        id: 'data',
        pipeline: execJson('process.stdout.write(JSON.stringify([{item:1}]))'),
        approval: 'required',
      },
      {
        id: 'after',
        command: "node -e \"process.stdout.write(JSON.stringify({done:true}))\"",
        condition: '$data.approved',
      },
    ],
  };

  const { filePath, stateDir } = await writeTmpWorkflow(workflow);
  const ctx = makeCtx({ registry });
  ctx.env.LOBSTER_STATE_DIR = stateDir;

  // First run: should halt for approval.
  const first = await runWorkflowFile({ filePath, ctx });

  assert.equal(first.status, 'needs_approval');
  assert.ok(first.requiresApproval?.resumeToken);

  // Resume with approval.
  const payload = decodeResumeToken(first.requiresApproval!.resumeToken!);
  assert.equal(payload.kind, 'workflow-file');

  const resumed = await runWorkflowFile({
    filePath,
    ctx: { ...ctx, env: { ...ctx.env, LOBSTER_STATE_DIR: stateDir } },
    resume: payload,
    approved: true,
  });

  assert.equal(resumed.status, 'ok');
  assert.deepEqual(resumed.output, [{ done: true }]);
});
