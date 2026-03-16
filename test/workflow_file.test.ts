import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

import { createDefaultRegistry } from '../src/commands/registry.js';
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

  const stateFiles = await fsp.readdir(stateDir);
  const resumeStateFiles = stateFiles.filter((name) => name.startsWith('workflow_resume_'));
  assert.deepEqual(resumeStateFiles, []);
});

test('workflow resume cancellation cleans up resume state', async () => {
  const workflow = {
    steps: [
      {
        id: 'approve_step',
        command: "node -e \"process.stdout.write(JSON.stringify({requiresApproval:{prompt:'Proceed?', items:[{id:1}]}}))\"",
        approval: 'required',
      },
      {
        id: 'finish',
        command: "node -e \"process.stdout.write(JSON.stringify({done:true}))\"",
        condition: '$approve_step.approved',
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-cancel-'));
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

  const payload = decodeResumeToken(first.requiresApproval?.resumeToken ?? '');
  assert.equal(payload.kind, 'workflow-file');
  assert.ok(payload.stateKey);

  await fsp.access(path.join(stateDir, `${payload.stateKey}.json`));

  const cancelled = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: 'tool',
    },
    resume: payload,
    approved: false,
  });

  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.output, []);
  const files = await fsp.readdir(stateDir);
  const resumeStateFiles = files.filter((name) => name.startsWith('workflow_resume_'));
  assert.deepEqual(resumeStateFiles, []);
});

test('workflow files can mix shell steps, approval-only steps, and pipeline llm steps', async () => {
  const registry = createDefaultRegistry();
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/invoke') {
      res.writeHead(404);
      res.end('nope');
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            runId: 'http_1',
            model: parsed.model || 'test-model',
            prompt: parsed.prompt,
            output: {
              format: 'json',
              text: '{"recommendation":"no","reason":"warm"}',
              data: { recommendation: 'no', reason: 'warm' },
            },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const workflow = {
    name: 'mixed-workflow',
    steps: [
      {
        id: 'fetch',
        run: "node -e \"process.stdout.write(JSON.stringify({location:'Phoenix',temp_f:73.8,humidity_pct:13,wind_mph:3.4}))\"",
      },
      {
        id: 'confirm',
        approval: 'Want jacket advice from the LLM?',
        stdin: '$fetch.json',
      },
      {
        id: 'advice',
        pipeline: 'llm.invoke --provider http --prompt "Given this weather data, should I wear a jacket? Return JSON." --disable-cache',
        stdin: '$fetch.json',
        when: '$confirm.approved',
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-mixed-'));
  const stateDir = path.join(tmpDir, 'state');
  const cacheDir = path.join(tmpDir, 'cache');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: stateDir,
    LOBSTER_CACHE_DIR: cacheDir,
    LOBSTER_LLM_ADAPTER_URL: `http://127.0.0.1:${port}`,
  };

  try {
    const first = await runWorkflowFile({
      filePath,
      ctx: {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env,
        mode: 'tool',
        registry,
      },
    });

    assert.equal(first.status, 'needs_approval');
    assert.equal(first.requiresApproval?.prompt, 'Want jacket advice from the LLM?');
    assert.match(first.requiresApproval?.preview ?? '', /Phoenix/);
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
        registry,
      },
      resume: payload,
      approved: true,
    });

    assert.equal(resumed.status, 'ok');
    assert.equal(resumed.output.length, 1);
    assert.equal((resumed.output[0] as any).kind, 'llm.invoke');
    assert.equal((resumed.output[0] as any).output.data.recommendation, 'no');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].artifacts[0].location, 'Phoenix');
  } finally {
    await closeServer(server);
  }
});

test('workflow pipeline steps respect cwd and feed later shell steps via stdout refs', async () => {
  const registry = createDefaultRegistry();
  const workflow = {
    cwd: '${TARGET_DIR}',
    steps: [
      {
        id: 'pwd',
        pipeline: 'exec pwd',
      },
      {
        id: 'capture',
        run: "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({pwd:d.trim()}));});\"",
        stdin: '$pwd.stdout',
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-pipeline-cwd-'));
  const targetDir = path.join(tmpDir, 'nested');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const result = await runWorkflowFile({
    filePath,
    args: { TARGET_DIR: targetDir },
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: path.join(tmpDir, 'state') },
      mode: 'tool',
      registry,
    },
  });

  assert.equal(result.status, 'ok');
  const resolvedTargetDir = await fsp.realpath(targetDir);
  assert.deepEqual(result.output, [{ pwd: resolvedTargetDir }]);
});

async function closeServer(server: http.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
