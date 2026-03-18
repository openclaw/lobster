import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { runWorkflowFile } from '../src/workflows/file.js';
import { decodeResumeToken } from '../src/resume.js';

function makeCtx(
  env: Record<string, string>,
  overrides: Record<string, unknown> = {},
) {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env,
    mode: 'tool' as const,
    ...overrides,
  };
}

test('input step pauses with needs_input and resumes with structured response', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-'));
  const stateDir = path.join(tmpDir, 'state');
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
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                },
                required: ['decision'],
              },
            },
          },
          {
            id: 'publish',
            run: "node -e \"process.stdout.write(JSON.stringify({decision:process.env.DECISION,text:process.env.TEXT}))\"",
            env: {
              DECISION: '$review.response.decision',
              TEXT: '$review.subject.text',
            },
            when: '$review.response.decision == approve',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const first = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });

  assert.equal(first.status, 'needs_input');
  assert.equal(first.requiresInput?.prompt, 'Approve?');
  assert.deepEqual(first.requiresInput?.subject, { text: 'hello' });
  assert.ok(first.requiresInput?.resumeToken);

  const payload = decodeResumeToken(first.requiresInput?.resumeToken ?? '');
  assert.equal(payload.kind, 'workflow-file');

  const resumed = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
    resume: payload as any,
    response: { decision: 'approve' },
  });

  assert.equal(resumed.status, 'ok');
  assert.deepEqual(resumed.output, [{ decision: 'approve', text: 'hello' }]);
});

test('terminal input step emits submitted response as final output after resume', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-terminal-output-'));
  const stateDir = path.join(tmpDir, 'state');
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
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                },
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

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const first = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });
  assert.equal(first.status, 'needs_input');
  const payload = decodeResumeToken(first.requiresInput?.resumeToken ?? '');
  assert.equal(payload.kind, 'workflow-file');

  const resumed = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
    resume: payload as any,
    response: { decision: 'approve' },
  });

  assert.equal(resumed.status, 'ok');
  assert.deepEqual(resumed.output, [{ decision: 'approve' }]);
});

test('input resume rejects response that does not match schema', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-schema-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'review',
            input: {
              prompt: 'Pick',
              responseSchema: {
                type: 'object',
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                },
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

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const first = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });
  assert.equal(first.status, 'needs_input');
  const payload = decodeResumeToken(first.requiresInput?.resumeToken ?? '');
  assert.equal(payload.kind, 'workflow-file');

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: makeCtx(env),
        resume: payload as any,
        response: { decision: 'invalid' },
      }),
    /schema validation/i,
  );
});

test('input to input chaining derives subject from previous input response', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-chain-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'first',
            input: {
              prompt: 'First value?',
              responseSchema: { type: 'string' },
            },
          },
          {
            id: 'second',
            input: {
              prompt: 'Second value?',
              responseSchema: { type: 'string' },
            },
          },
          {
            id: 'done',
            run: "node -e \"process.stdout.write(JSON.stringify({subject:process.env.SUBJECT,response:process.env.RESPONSE}))\"",
            env: {
              SUBJECT: '$second.subject',
              RESPONSE: '$second.response',
            },
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;

  const first = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });
  assert.equal(first.status, 'needs_input');

  const firstPayload = decodeResumeToken(first.requiresInput?.resumeToken ?? '');
  assert.equal(firstPayload.kind, 'workflow-file');
  const second = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
    resume: firstPayload as any,
    response: 'alpha',
  });
  assert.equal(second.status, 'needs_input');
  assert.equal(second.requiresInput?.subject, 'alpha');

  const secondPayload = decodeResumeToken(second.requiresInput?.resumeToken ?? '');
  assert.equal(secondPayload.kind, 'workflow-file');
  const done = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
    resume: secondPayload as any,
    response: 'omega',
  });
  assert.equal(done.status, 'ok');
  assert.deepEqual(done.output, [{ subject: 'alpha', response: 'omega' }]);
});

test('next loops back to input step and subject tracks latest executed step output', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-loop-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'draft',
            run: "node -e \"process.stdout.write(JSON.stringify({text:'v1'}))\"",
          },
          {
            id: 'review',
            input: {
              prompt: 'Approve or redraft?',
              responseSchema: {
                type: 'object',
                properties: {
                  decision: { type: 'string', enum: ['approve', 'redraft'] },
                },
                required: ['decision'],
              },
            },
          },
          {
            id: 'redraft',
            run: "node -e \"process.stdout.write(JSON.stringify({text:'v2'}))\"",
            when: '$review.response.decision == redraft',
            next: 'review',
            max_iterations: 3,
          },
          {
            id: 'publish',
            run: "node -e \"process.stdout.write(JSON.stringify({published:process.env.TEXT}))\"",
            env: {
              TEXT: '$review.subject.text',
            },
            when: '$review.response.decision == approve',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const first = await runWorkflowFile({ filePath, ctx: makeCtx(env) });
  assert.equal(first.status, 'needs_input');
  assert.deepEqual(first.requiresInput?.subject, { text: 'v1' });

  const firstToken = first.requiresInput?.resumeToken ?? '';
  const firstPayload = decodeResumeToken(firstToken);
  assert.equal(firstPayload.kind, 'workflow-file');
  const second = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
    resume: firstPayload as any,
    response: { decision: 'redraft' },
  });
  assert.equal(second.status, 'needs_input');
  assert.deepEqual(second.requiresInput?.subject, { text: 'v2' });

  const secondToken = second.requiresInput?.resumeToken ?? '';
  const secondPayload = decodeResumeToken(secondToken);
  assert.equal(secondPayload.kind, 'workflow-file');
  const done = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
    resume: secondPayload as any,
    response: { decision: 'approve' },
  });
  assert.equal(done.status, 'ok');
  assert.deepEqual(done.output, [{ published: 'v2' }]);
});

test('loop revisits preserve prior step output when later iteration skips the step', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-loop-skip-preserve-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'draft',
            run: "node -e \"process.stdout.write(JSON.stringify({text:'v1'}))\"",
          },
          {
            id: 'review',
            input: {
              prompt: 'Approve or redraft?',
              responseSchema: {
                type: 'object',
                properties: {
                  decision: { type: 'string', enum: ['approve', 'redraft'] },
                },
                required: ['decision'],
              },
            },
          },
          {
            id: 'redraft',
            run: "node -e \"process.stdout.write(JSON.stringify({text:'v2'}))\"",
            when: '$review.response.decision == redraft',
            next: 'review',
            max_iterations: 3,
          },
          {
            id: 'publish',
            run: "node -e \"process.stdout.write(JSON.stringify({picked:process.env.PICKED,decision:process.env.DECISION}))\"",
            env: {
              PICKED: '$redraft.json.text',
              DECISION: '$review.response.decision',
            },
            when: '$review.response.decision == approve',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;

  const first = await runWorkflowFile({ filePath, ctx: makeCtx(env) });
  assert.equal(first.status, 'needs_input');
  const firstPayload = decodeResumeToken(first.requiresInput?.resumeToken ?? '');
  assert.equal(firstPayload.kind, 'workflow-file');

  const second = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
    resume: firstPayload as any,
    response: { decision: 'redraft' },
  });
  assert.equal(second.status, 'needs_input');
  const secondPayload = decodeResumeToken(second.requiresInput?.resumeToken ?? '');
  assert.equal(secondPayload.kind, 'workflow-file');

  const done = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
    resume: secondPayload as any,
    response: { decision: 'approve' },
  });
  assert.equal(done.status, 'ok');
  assert.deepEqual(done.output, [{ picked: 'v2', decision: 'approve' }]);
});

test('retry and on_error jump mark step as failed and continue at target step', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-retry-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'flaky',
            run: "node -e \"process.stderr.write('boom'); process.exit(1)\"",
            retry: 1,
            retry_delay: '1ms',
            on_error: 'alert',
          },
          {
            id: 'never_runs',
            run: "node -e \"process.stdout.write(JSON.stringify({wrong:true}))\"",
          },
          {
            id: 'alert',
            run: "node -e \"process.stdout.write(JSON.stringify({failed:process.env.FAILED==='true',error:process.env.ERR}))\"",
            env: {
              FAILED: '$flaky.failed',
              ERR: '$flaky.error',
            },
            when: '$flaky.failed',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const result = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.output.length, 1);
  assert.equal((result.output[0] as any).failed, true);
  assert.match(String((result.output[0] as any).error), /boom|failed/i);
});

test('needs_input subject truncation is envelope-aware against tool output limit', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-envelope-limit-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'draft',
            run: "node -e \"process.stdout.write(JSON.stringify({text:'x'.repeat(30000)}))\"",
          },
          {
            id: 'review',
            input: {
              prompt: 'Approve?',
              responseSchema: {
                type: 'object',
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                },
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

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: stateDir,
    LOBSTER_MAX_TOOL_ENVELOPE_BYTES: '4096',
  } as Record<string, string>;

  const first = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });

  assert.equal(first.status, 'needs_input');
  assert.equal(typeof first.requiresInput?.subject, 'object');
  assert.equal((first.requiresInput?.subject as any)?.truncated, true);
});

test('needs_input persists sanitized subject in resume state', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-sanitized-subject-state-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'draft',
            run: "node -e \"process.stdout.write(JSON.stringify({text:'x'.repeat(30000)}))\"",
          },
          {
            id: 'review',
            input: {
              prompt: 'Approve?',
              responseSchema: {
                type: 'object',
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                },
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

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: stateDir,
    LOBSTER_MAX_TOOL_ENVELOPE_BYTES: '4096',
  } as Record<string, string>;
  const first = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });

  assert.equal(first.status, 'needs_input');
  assert.equal(typeof first.requiresInput?.subject, 'object');
  assert.equal((first.requiresInput?.subject as any)?.truncated, true);
  assert.ok(first.requiresInput?.resumeToken);

  const tokenPayload = decodeResumeToken(first.requiresInput?.resumeToken ?? '');
  assert.equal(tokenPayload.kind, 'workflow-file');
  const statePath = path.join(stateDir, `${(tokenPayload as any).stateKey}.json`);
  const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  assert.equal((state.inputSubject as any)?.truncated, true);
});

test('input step reads response from interactive TTY mode', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-interactive-'));
  const stateDir = path.join(tmpDir, 'state');
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
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                },
                required: ['decision'],
              },
            },
          },
          {
            id: 'publish',
            run: "node -e \"process.stdout.write(JSON.stringify({decision:process.env.DECISION,text:process.env.TEXT}))\"",
            env: {
              DECISION: '$review.response.decision',
              TEXT: '$review.subject.text',
            },
            when: '$review.response.decision == approve',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  setImmediate(() => {
    stdin.end('{"decision":"approve"}\n');
  });

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const result = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env, {
      stdin,
      stdout,
      stderr,
      mode: 'human',
    }),
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ decision: 'approve', text: 'hello' }]);
});

test('interactive input mode ignores tool envelope size limits', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-interactive-no-envelope-limit-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'review',
            input: {
              prompt: 'P'.repeat(20_000),
              responseSchema: {
                type: 'object',
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                },
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

  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  setImmediate(() => {
    stdin.end('{"decision":"approve"}\n');
  });

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: stateDir,
    LOBSTER_MAX_TOOL_ENVELOPE_BYTES: '1024',
  } as Record<string, string>;
  const result = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env, {
      stdin,
      stdout,
      stderr,
      mode: 'human',
    }),
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ decision: 'approve' }]);
});

test('terminal input step emits submitted response in interactive mode', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-terminal-interactive-output-'));
  const stateDir = path.join(tmpDir, 'state');
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
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                },
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

  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  setImmediate(() => {
    stdin.end('{"decision":"approve"}\n');
  });

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const result = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env, {
      stdin,
      stdout,
      stderr,
      mode: 'human',
    }),
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ decision: 'approve' }]);
});

test('input step accepts primitive JSON response when schema allows it', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-primitive-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'review',
            input: {
              prompt: 'Provide title',
              responseSchema: {
                type: 'string',
              },
            },
          },
          {
            id: 'publish',
            run: "node -e \"process.stdout.write(JSON.stringify({text:process.env.TEXT}))\"",
            env: {
              TEXT: '$review.response',
            },
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const first = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });
  assert.equal(first.status, 'needs_input');
  const payload = decodeResumeToken(first.requiresInput?.resumeToken ?? '');
  assert.equal(payload.kind, 'workflow-file');

  const resumed = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
    resume: payload as any,
    response: 'hello world',
  });
  assert.equal(resumed.status, 'ok');
  assert.deepEqual(resumed.output, [{ text: 'hello world' }]);
});

test('input resume requires response payload', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-missing-response-'));
  const stateDir = path.join(tmpDir, 'state');
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
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                },
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

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const first = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });
  assert.equal(first.status, 'needs_input');
  const payload = decodeResumeToken(first.requiresInput?.resumeToken ?? '');
  assert.equal(payload.kind, 'workflow-file');

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: makeCtx(env),
        resume: payload as any,
      }),
    /requires --response-json/i,
  );
});

test('input resume rejects approved flag and supports explicit cancel', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-approve-reject-'));
  const stateDir = path.join(tmpDir, 'state');
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
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                },
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

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const first = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });
  assert.equal(first.status, 'needs_input');
  const payload = decodeResumeToken(first.requiresInput?.resumeToken ?? '');
  assert.equal(payload.kind, 'workflow-file');
  assert.ok(payload.stateKey);

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: makeCtx(env),
        resume: payload as any,
        approved: true,
      }),
    /requires --response-json/i,
  );

  const cancelled = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
    resume: payload as any,
    cancel: true,
  });
  assert.equal(cancelled.status, 'cancelled');
  const files = await fsp.readdir(stateDir);
  const resumeStateFiles = files.filter((name) => name.startsWith('workflow_resume_'));
  assert.deepEqual(resumeStateFiles, []);
});

test('input cancel succeeds even when workflow file is missing', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-cancel-missing-file-'));
  const stateDir = path.join(tmpDir, 'state');
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
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                },
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

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const first = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });
  assert.equal(first.status, 'needs_input');
  const payload = decodeResumeToken(first.requiresInput?.resumeToken ?? '');
  assert.equal(payload.kind, 'workflow-file');
  assert.ok(payload.stateKey);

  await fsp.rm(filePath);

  const cancelled = await runWorkflowFile({
    ctx: makeCtx(env),
    resume: payload as any,
    cancel: true,
  });
  assert.equal(cancelled.status, 'cancelled');
  const files = await fsp.readdir(stateDir);
  const resumeStateFiles = files.filter((name) => name.startsWith('workflow_resume_'));
  assert.deepEqual(resumeStateFiles, []);
});

test('workflow resume rejects invalid iterationCounts in stored state', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-invalid-iteration-counts-'));
  const stateDir = path.join(tmpDir, 'state');
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
                properties: {
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                },
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

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const first = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });
  assert.equal(first.status, 'needs_input');
  const payload = decodeResumeToken(first.requiresInput?.resumeToken ?? '');
  assert.equal(payload.kind, 'workflow-file');
  const stateKey = (payload as any).stateKey;
  assert.equal(typeof stateKey, 'string');

  const statePath = path.join(stateDir, `${stateKey}.json`);
  const parsed = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  parsed.iterationCounts = 'invalid';
  await fsp.writeFile(statePath, JSON.stringify(parsed, null, 2), 'utf8');

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: makeCtx(env),
        resume: payload as any,
        response: { decision: 'approve' },
      }),
    /Invalid workflow resume state/i,
  );
});

test('needs_input fails when envelope exceeds max bytes even after subject truncation', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-envelope-hard-limit-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'review',
            input: {
              prompt: 'x'.repeat(20_000),
              responseSchema: {
                type: 'object',
                properties: {
                  decision: { type: 'string' },
                },
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

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: stateDir,
    LOBSTER_MAX_TOOL_ENVELOPE_BYTES: '1024',
  } as Record<string, string>;

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: makeCtx(env),
      }),
    /needs_input envelope exceeds/i,
  );
});

test('next loops fail fast when max_iterations is exceeded', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-loop-max-iterations-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'loop',
            run: "node -e \"process.stdout.write('{}')\"",
            next: 'loop',
            max_iterations: 2,
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: makeCtx(env),
      }),
    /exceeded max_iterations/i,
  );
});

test('on_error backward jumps fail fast when max_iterations is exceeded', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-on-error-backward-loop-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'start',
            run: "node -e \"process.stdout.write('{}')\"",
            next: 'flaky',
          },
          {
            id: 'flaky',
            run: "node -e \"process.stderr.write('boom'); process.exit(1)\"",
            max_iterations: 2,
            on_error: 'start',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: makeCtx(env),
      }),
    /step flaky exceeded max_iterations/i,
  );
});

test('loop revisit skip preserves data outputs but clears stale failure flags', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-loop-skip-clear-failure-'));
  const stateDir = path.join(tmpDir, 'state');
  const markerPath = path.join(tmpDir, 'toggle.marker');
  const filePath = path.join(tmpDir, 'workflow.lobster');

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        env: {
          MARKER: markerPath,
        },
        steps: [
          {
            id: 'toggle',
            run: "node -e \"const fs=require('node:fs');const p=process.env.MARKER;const first=!fs.existsSync(p);if(first)fs.writeFileSync(p,'1');process.stdout.write(JSON.stringify({go:first}));\"",
          },
          {
            id: 'flaky',
            run: "node -e \"process.stderr.write('boom'); process.exit(1)\"",
            when: '$toggle.json.go == true',
            on_error: 'toggle',
            max_iterations: 3,
          },
          {
            id: 'report',
            run: "node -e \"process.stdout.write(JSON.stringify({failed:process.env.FAILED==='true',error:process.env.ERROR||''}))\"",
            env: {
              FAILED: '$flaky.failed',
              ERROR: '$flaky.error',
            },
            when: '$flaky.failed',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const result = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ go: false }]);
});

test('workflow parser rejects invalid next declarations', async () => {
  const cases = [
    {
      name: 'next target missing',
      workflow: {
        steps: [
          {
            id: 'a',
            run: "node -e \"process.stdout.write('{}')\"",
            next: 'missing',
          },
        ],
      },
      pattern: /next target not found/i,
    },
    {
      name: 'next target empty',
      workflow: {
        steps: [
          {
            id: 'a',
            run: "node -e \"process.stdout.write('{}')\"",
            next: '   ',
          },
        ],
      },
      pattern: /next cannot be empty/i,
    },
    {
      name: 'next target explicit empty string',
      workflow: {
        steps: [
          {
            id: 'a',
            run: "node -e \"process.stdout.write('{}')\"",
            next: '',
          },
        ],
      },
      pattern: /next cannot be empty/i,
    },
    {
      name: 'next on input step',
      workflow: {
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
            next: 'review',
          },
        ],
      },
      pattern: /cannot use next with approval\/input steps/i,
    },
  ] as const;

  for (const tc of cases) {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `lobster-workflow-next-guard-${tc.name.replace(/\s+/g, '-')}-`));
    const stateDir = path.join(tmpDir, 'state');
    const filePath = path.join(tmpDir, 'workflow.lobster');
    await fsp.writeFile(filePath, JSON.stringify(tc.workflow, null, 2), 'utf8');

    const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
    await assert.rejects(
      () =>
        runWorkflowFile({
          filePath,
          ctx: makeCtx(env),
        }),
      tc.pattern,
    );
  }
});

test('workflow parser rejects input steps without prompt', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-missing-prompt-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'review',
            input: {
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

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: makeCtx(env),
      }),
    /input\.prompt must be a string/i,
  );
});

test('workflow parser rejects invalid input response schemas before pausing', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-invalid-schema-'));
  const stateDir = path.join(tmpDir, 'state');
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
                type: 'wat',
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

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: makeCtx(env),
      }),
    /input\.responseSchema is invalid/i,
  );
});

test('workflow parser accepts repeated responseSchema $id across runs', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-input-shared-id-'));
  const stateDir = path.join(tmpDir, 'state');
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
                $id: 'urn:lobster:test:input-schema',
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

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const first = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });
  assert.equal(first.status, 'needs_input');

  const second = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });
  assert.equal(second.status, 'needs_input');
});

test('workflow parser rejects non-string retry_delay with validation error', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-retry-delay-type-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'step1',
            run: "node -e \"process.stdout.write('ok')\"",
            retry: 1,
            retry_delay: 100,
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: makeCtx(env),
      }),
    /retry_delay must be a duration like 1s or 500ms/i,
  );
});

test('condition parser supports &&, ||, !, !=, and quoted string literals', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-conditions-'));
  const stateDir = path.join(tmpDir, 'state');
  const markerPath = path.join(tmpDir, 'markers.txt');
  const filePath = path.join(tmpDir, 'workflow.lobster');

  const append = (label: string) =>
    `node -e "require('node:fs').appendFileSync(process.env.OUT,'${label}\\\\n')"`;
  const readMarkers =
    "node -e \"const fs=require('node:fs');const p=process.env.OUT;const t=fs.existsSync(p)?fs.readFileSync(p,'utf8').trim():'';process.stdout.write(JSON.stringify(t?t.split('\\\\n'):[]));\"";

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        env: {
          OUT: markerPath,
        },
        steps: [
          {
            id: 'seed',
            run: "node -e \"process.stdout.write(JSON.stringify({target:'prod',note:'not ready yet',ok:true}))\"",
          },
          {
            id: 'allow',
            run: "node -e \"process.stdout.write(JSON.stringify({ok:true}))\"",
          },
          {
            id: 'and_step',
            run: append('and'),
            when: '$seed.json.target == prod && $allow.json.ok == true',
          },
          {
            id: 'or_step',
            run: append('or'),
            when: '$seed.json.target == staging || $allow.json.ok == true',
          },
          {
            id: 'neq_step',
            run: append('neq'),
            when: '$seed.json.target != staging',
          },
          {
            id: 'quoted_step',
            run: append('quoted'),
            when: '$seed.json.note == "not ready yet"',
          },
          {
            id: 'skip',
            run: append('skip'),
            when: '$seed.json.target == staging',
          },
          {
            id: 'not_step',
            run: append('not'),
            when: '!$skip.failed',
          },
          {
            id: 'read',
            run: readMarkers,
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const result = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, ['and', 'or', 'neq', 'quoted', 'not']);
});

test('condition parser supports more than two operands for && and ||', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-conditions-nary-'));
  const stateDir = path.join(tmpDir, 'state');
  const markerPath = path.join(tmpDir, 'markers.txt');
  const filePath = path.join(tmpDir, 'workflow.lobster');

  const append = (label: string) =>
    `node -e "require('node:fs').appendFileSync(process.env.OUT,'${label}\\\\n')"`;
  const readMarkers =
    "node -e \"const fs=require('node:fs');const p=process.env.OUT;const t=fs.existsSync(p)?fs.readFileSync(p,'utf8').trim():'';process.stdout.write(JSON.stringify(t?t.split('\\\\n'):[]));\"";

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        env: {
          OUT: markerPath,
        },
        steps: [
          {
            id: 'seed',
            run: "node -e \"process.stdout.write(JSON.stringify({target:'prod',ok:true}))\"",
          },
          {
            id: 'allow',
            run: "node -e \"process.stdout.write(JSON.stringify({ok:true}))\"",
          },
          {
            id: 'and_nary',
            run: append('and_nary'),
            when: '$seed.json.target == prod && $allow.json.ok == true && $seed.json.ok == true',
          },
          {
            id: 'or_nary',
            run: append('or_nary'),
            when: '$seed.json.target == staging || $allow.json.ok == true || $seed.json.ok == true',
          },
          {
            id: 'read',
            run: readMarkers,
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const result = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, ['and_nary', 'or_nary']);
});

test('resolveStepRefs does not leak raw placeholders for missing fields', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-template-missing-refs-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'seed',
            run: "node -e \"process.stdout.write(JSON.stringify({ok:true}))\"",
          },
          {
            id: 'render',
            run: "node -e \"process.stdout.write(JSON.stringify({approved:process.env.APPROVED,missing:process.env.MISSING,unknown:process.env.UNKNOWN}))\"",
            env: {
              APPROVED: '$seed.approved',
              MISSING: 'prefix-$seed.nope-suffix',
              UNKNOWN: '$missing.stdout',
            },
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const result = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ approved: 'false', missing: 'prefix--suffix', unknown: '' }]);
});

test('condition parser handles quoted literals ending with backslash before &&', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-conditions-backslash-quote-'));
  const stateDir = path.join(tmpDir, 'state');
  const markerPath = path.join(tmpDir, 'markers.txt');
  const filePath = path.join(tmpDir, 'workflow.lobster');

  const append = (label: string) =>
    `node -e "require('node:fs').appendFileSync(process.env.OUT,'${label}\\\\n')"`;
  const readMarkers =
    "node -e \"const fs=require('node:fs');const p=process.env.OUT;const t=fs.existsSync(p)?fs.readFileSync(p,'utf8').trim():'';process.stdout.write(JSON.stringify(t?t.split('\\\\n'):[]));\"";

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        env: {
          OUT: markerPath,
        },
        steps: [
          {
            id: 'seed',
            run: "node -e \"process.stdout.write(JSON.stringify({path:'C:\\\\\\\\temp\\\\\\\\',ok:true}))\"",
          },
          {
            id: 'allow',
            run: "node -e \"process.stdout.write(JSON.stringify({ok:true}))\"",
          },
          {
            id: 'gated',
            run: append('gated'),
            when: '$seed.json.path == "C:\\\\temp\\\\" && $allow.json.ok == true',
          },
          {
            id: 'read',
            run: readMarkers,
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const result = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, ['gated']);
});

test('condition parser rejects mixed && and || in one expression', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-conditions-mixed-op-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'seed',
            run: "node -e \"process.stdout.write(JSON.stringify({target:'prod',ok:true}))\"",
          },
          {
            id: 'allow',
            run: "node -e \"process.stdout.write(JSON.stringify({ok:true}))\"",
          },
          {
            id: 'bad',
            run: "node -e \"process.stdout.write('{}')\"",
            when: '$seed.json.target == prod && $allow.json.ok == true || $seed.json.ok == true',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: makeCtx(env),
      }),
    /Unsupported condition/i,
  );
});

test('on_error skip continues workflow and exposes failed/error fields', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-on-error-skip-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'flaky',
            run: "node -e \"process.stderr.write('boom'); process.exit(1)\"",
            on_error: 'skip',
          },
          {
            id: 'report',
            run: "node -e \"process.stdout.write(JSON.stringify({failed:process.env.FAILED==='true',error:process.env.ERR}))\"",
            env: {
              FAILED: '$flaky.failed',
              ERR: '$flaky.error',
            },
            when: '$flaky.failed',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  const result = await runWorkflowFile({
    filePath,
    ctx: makeCtx(env),
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, [{ failed: true, error: 'workflow command failed (1): boom' }]);
});

test('default on_error fail preserves failure behavior', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-on-error-fail-default-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'flaky',
            run: "node -e \"process.stderr.write('boom'); process.exit(1)\"",
          },
          {
            id: 'never_runs',
            run: "node -e \"process.stdout.write(JSON.stringify({ok:true}))\"",
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: makeCtx(env),
      }),
    /boom/i,
  );
});

test('retry delay wait is abortable via workflow signal', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-retry-abort-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'flaky',
            run: "node -e \"process.stderr.write('boom'); process.exit(1)\"",
            retry: 5,
            retry_delay: '50ms',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const abort = new AbortController();
  setTimeout(() => abort.abort(), 10);

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: makeCtx(env, {
          signal: abort.signal,
        }),
      }),
    /Workflow aborted/i,
  );
});

test('workflow abort signal stops execution before first retry attempt', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-retry-pre-abort-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: 'pipeline_step',
            pipeline: 'json',
            stdin: {
              ok: true,
            },
            retry: 2,
            retry_delay: '10ms',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const abort = new AbortController();
  abort.abort();

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir } as Record<string, string>;
  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: makeCtx(env, {
          signal: abort.signal,
        }),
      }),
    /Workflow aborted/i,
  );
});
