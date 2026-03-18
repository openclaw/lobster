import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resumeToolRequest, runToolRequest } from '../src/core/index.js';
import { encodeToken } from '../src/token.js';

function createDirectAdapter(resultText: string) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    adapter: {
      source: 'test',
      async invoke({ payload }: { payload: Record<string, unknown> }) {
        calls.push(payload);
        return {
          ok: true,
          result: {
            runId: 'adapter_1',
            model: 'test/model',
            prompt: payload.prompt,
            status: 'completed',
            output: {
              format: 'json',
              text: resultText,
              data: JSON.parse(resultText),
            },
          },
        };
      },
    },
  };
}

test('runToolRequest executes pipeline with injected llm adapter', async () => {
  const { adapter, calls } = createDirectAdapter('{"recommendation":"no jacket"}');
  const envelope = await runToolRequest({
    pipeline:
      'exec --json=true node -e "process.stdout.write(JSON.stringify({location:\'Phoenix\',temp_f:73.8}))" | llm.invoke --provider pi --prompt "Should I wear a jacket?" --disable-cache',
    ctx: {
      env: {
        ...process.env,
        LOBSTER_LLM_PROVIDER: 'pi',
        LOBSTER_LLM_MODEL: 'test/model',
      },
      llmAdapters: {
        pi: adapter,
      },
    },
  });

  assert.equal(envelope.ok, true);
  assert.equal(envelope.status, 'ok');
  assert.equal(envelope.output?.length, 1);
  assert.equal((envelope.output![0] as any).output.data.recommendation, 'no jacket');
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as any).model, 'test/model');
});

test('resumeToolRequest completes approval-gated workflow with injected llm adapter', async () => {
  const { adapter, calls } = createDirectAdapter('{"recommendation":"no","reason":"warm"}');
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-core-tool-runtime-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'fetch',
            run: 'node -e "process.stdout.write(JSON.stringify({location:\'Phoenix\',temp_f:73.8}))"',
          },
          {
            id: 'confirm',
            approval: 'Want jacket advice?',
            stdin: '$fetch.json',
          },
          {
            id: 'advice',
            pipeline: 'llm.invoke --provider pi --prompt "Return JSON." --disable-cache',
            stdin: '$fetch.json',
            when: '$confirm.approved',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, 'state'),
    LOBSTER_LLM_PROVIDER: 'pi',
    LOBSTER_LLM_MODEL: 'test/model',
  };

  const first = await runToolRequest({
    filePath,
    ctx: {
      cwd: tmpDir,
      env,
      llmAdapters: { pi: adapter },
    },
  });

  assert.equal(first.ok, true);
  assert.equal(first.status, 'needs_approval');
  assert.ok(first.requiresApproval?.resumeToken);

  const resumed = await resumeToolRequest({
    token: first.requiresApproval?.resumeToken ?? '',
    approved: true,
    ctx: {
      cwd: tmpDir,
      env,
      llmAdapters: { pi: adapter },
    },
  });

  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, 'ok');
  assert.equal((resumed.output![0] as any).output.data.reason, 'warm');
  assert.equal(calls.length, 1);
});

test('runToolRequest/resumeToolRequest handles needs_input workflow pauses', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-core-tool-runtime-input-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'draft',
            run: "node -e \"process.stdout.write(JSON.stringify({text:'hello'}))\"",
          },
          {
            id: 'review',
            input: {
              prompt: 'Approve?',
              responseSchema: {
                type: 'object',
                properties: { decision: { type: 'string', enum: ['approve', 'reject'] } },
                required: ['decision'],
              },
            },
          },
          {
            id: 'publish',
            run: "node -e \"process.stdout.write(JSON.stringify({text:process.env.TEXT}))\"",
            env: { TEXT: '$review.subject.text' },
            when: '$review.response.decision == approve',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, 'state'),
  };

  const first = await runToolRequest({
    filePath,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'needs_input');
  assert.ok(first.requiresInput?.resumeToken);
  assert.deepEqual(first.requiresInput?.subject, { text: 'hello' });

  const wrongCancel = await resumeToolRequest({
    token: first.requiresInput?.resumeToken ?? '',
    approved: false,
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(wrongCancel.ok, false);
  assert.equal(wrongCancel.error?.type, 'parse_error');
  assert.match(String(wrongCancel.error?.message), /response-json.*input requests/i);

  const resumed = await resumeToolRequest({
    token: first.requiresInput?.resumeToken ?? '',
    response: { decision: 'approve' },
    ctx: { cwd: tmpDir, env },
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, 'ok');
  assert.deepEqual(resumed.output, [{ text: 'hello' }]);
});

test('resumeToolRequest enforces pipeline pause type for approval/input resumes', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-core-tool-runtime-pipeline-guards-'));
  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, 'state'),
  };

  const approvalRun = await runToolRequest({
    pipeline: 'approve --prompt "ok?"',
    ctx: { env },
  });
  assert.equal(approvalRun.ok, true);
  assert.equal(approvalRun.status, 'needs_approval');
  assert.ok(approvalRun.requiresApproval?.resumeToken);

  const wrongApprovalResume = await resumeToolRequest({
    token: approvalRun.requiresApproval?.resumeToken ?? '',
    response: { decision: 'approve' },
    ctx: { env },
  });
  assert.equal(wrongApprovalResume.ok, false);
  assert.equal(wrongApprovalResume.error?.type, 'parse_error');
  assert.match(String(wrongApprovalResume.error?.message), /approval resumes require approved/i);

  const inputRun = await runToolRequest({
    pipeline: "ask --prompt 'Decision?' --schema '{\"type\":\"object\",\"properties\":{\"decision\":{\"type\":\"string\"}},\"required\":[\"decision\"]}'",
    ctx: { env },
  });
  assert.equal(inputRun.ok, true);
  assert.equal(inputRun.status, 'needs_input');
  assert.ok(inputRun.requiresInput?.resumeToken);

  const wrongInputResume = await resumeToolRequest({
    token: inputRun.requiresInput?.resumeToken ?? '',
    approved: true,
    ctx: { env },
  });
  assert.equal(wrongInputResume.ok, false);
  assert.equal(wrongInputResume.error?.type, 'parse_error');
  assert.match(String(wrongInputResume.error?.message), /input resumes require response/i);
});

test('resumeToolRequest validates pipeline input response against ask schema', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-core-tool-runtime-pipeline-schema-'));
  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, 'state'),
  };

  const first = await runToolRequest({
    pipeline: "ask --prompt 'Value?' --schema '{\"type\":\"string\"}'",
    ctx: { env },
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'needs_input');
  assert.ok(first.requiresInput?.resumeToken);

  const bad = await resumeToolRequest({
    token: first.requiresInput?.resumeToken ?? '',
    response: { not: 'a string' },
    ctx: { env },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error?.type, 'parse_error');
  assert.match(String(bad.error?.message), /schema validation/i);

  const good = await resumeToolRequest({
    token: first.requiresInput?.resumeToken ?? '',
    response: 'hello',
    ctx: { env },
  });
  assert.equal(good.ok, true);
  assert.equal(good.status, 'ok');
  assert.deepEqual(good.output, ['hello']);
});

test('resumeToolRequest maps workflow input schema validation failures to parse_error', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-core-tool-runtime-workflow-schema-'));
  const filePath = path.join(tmpDir, 'workflow.lobster');
  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, 'state'),
  };

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'review',
            input: {
              prompt: 'Provide title',
              responseSchema: { type: 'string' },
            },
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const first = await runToolRequest({
    filePath,
    ctx: { env },
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'needs_input');
  assert.ok(first.requiresInput?.resumeToken);

  const bad = await resumeToolRequest({
    token: first.requiresInput?.resumeToken ?? '',
    response: { not: 'a string' },
    ctx: { env },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error?.type, 'parse_error');
  assert.match(String(bad.error?.message), /schema validation/i);
});

test('resumeToolRequest supports explicit cancel for input requests', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-core-tool-runtime-cancel-input-'));
  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, 'state'),
  };
  const filePath = path.join(tmpDir, 'workflow.lobster');

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'review',
            input: {
              prompt: 'Approve?',
              responseSchema: {
                type: 'object',
                properties: { decision: { type: 'string' } },
                required: ['decision'],
              },
            },
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const workflowFirst = await runToolRequest({
    filePath,
    ctx: { env },
  });
  assert.equal(workflowFirst.ok, true);
  assert.equal(workflowFirst.status, 'needs_input');
  assert.ok(workflowFirst.requiresInput?.resumeToken);

  const workflowCancelled = await resumeToolRequest({
    token: workflowFirst.requiresInput?.resumeToken ?? '',
    cancel: true,
    ctx: { env },
  });
  assert.equal(workflowCancelled.ok, true);
  assert.equal(workflowCancelled.status, 'cancelled');

  const pipelineFirst = await runToolRequest({
    pipeline: "ask --prompt 'Decision?' --schema '{\"type\":\"object\",\"properties\":{\"decision\":{\"type\":\"string\"}},\"required\":[\"decision\"]}'",
    ctx: { env },
  });
  assert.equal(pipelineFirst.ok, true);
  assert.equal(pipelineFirst.status, 'needs_input');
  assert.ok(pipelineFirst.requiresInput?.resumeToken);

  const pipelineCancelled = await resumeToolRequest({
    token: pipelineFirst.requiresInput?.resumeToken ?? '',
    cancel: true,
    ctx: { env },
  });
  assert.equal(pipelineCancelled.ok, true);
  assert.equal(pipelineCancelled.status, 'cancelled');
});

test('ask command fails fast on invalid --schema JSON', async () => {
  const envelope = await runToolRequest({
    pipeline: "ask --prompt 'Decision?' --schema '{'",
    ctx: { env: process.env },
  });

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.type, 'runtime_error');
  assert.match(String(envelope.error?.message), /ask --schema must be valid JSON/i);
});

test('resumeToolRequest legacy pipeline state without haltType requires approved flag', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-core-tool-runtime-legacy-'));
  const stateDir = path.join(tmpDir, 'state');
  const stateKey = 'pipeline_resume_legacy_core';
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(
    path.join(stateDir, `${stateKey}.json`),
    JSON.stringify(
      {
        pipeline: [],
        resumeAtIndex: 0,
        items: [{ a: 1 }],
        prompt: 'legacy',
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  const token = encodeToken({
    protocolVersion: 1,
    v: 1,
    kind: 'pipeline-resume',
    stateKey,
  });

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: stateDir,
  };

  const bad = await resumeToolRequest({
    token,
    response: { decision: 'approve' },
    ctx: { env },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error?.type, 'parse_error');
  assert.match(String(bad.error?.message), /legacy pipeline resumes require approved/i);

  const good = await resumeToolRequest({
    token,
    approved: true,
    ctx: { env },
  });
  assert.equal(good.ok, true);
  assert.equal(good.status, 'ok');
  assert.deepEqual(good.output, [{ a: 1 }]);
});
