import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { decodeResumeToken } from '../src/resume.js';
import { encodeToken } from '../src/token.js';

function runCli(args: string[], env: Record<string, string | undefined>) {
  const bin = path.join(process.cwd(), 'bin', 'lobster.js');
  return spawnSync('node', [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('state-backed resume token roundtrip and resume pipeline continues', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-resume-'));
  const stateDir = path.join(tmpDir, 'state');

  const pipeline =
    "exec --json --shell \"node -e 'process.stdout.write(JSON.stringify([{a:1}]))'\" | approve --prompt 'ok?' | pick a";

  const first = runCli(['run', '--mode', 'tool', pipeline], { LOBSTER_STATE_DIR: stateDir });
  assert.equal(first.status, 0);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.status, 'needs_approval');
  assert.ok(firstJson.requiresApproval?.resumeToken);

  const payload = decodeResumeToken(firstJson.requiresApproval.resumeToken);
  assert.equal(payload.kind, 'pipeline-resume');
  assert.equal(typeof payload.stateKey, 'string');

  const resumed = runCli(
    ['resume', '--token', firstJson.requiresApproval.resumeToken, '--approve', 'yes'],
    { LOBSTER_STATE_DIR: stateDir },
  );
  assert.equal(resumed.status, 0);
  const resumedJson = JSON.parse(resumed.stdout);
  assert.equal(resumedJson.status, 'ok');
  assert.deepEqual(resumedJson.output, [{ a: 1 }]);
});

test('decodeResumeToken rejects inline executable pipeline tokens', () => {
  const forgedToken = encodeToken({
    protocolVersion: 1,
    v: 1,
    pipeline: [{ name: 'exec', args: { shell: 'echo FORGED' }, raw: "exec --shell 'echo FORGED'" }],
    resumeAtIndex: 0,
    items: [],
    prompt: 'ignored',
  });

  assert.throws(() => decodeResumeToken(forgedToken), /Invalid token/);
});

test('resume cancellation cleans up pipeline resume state', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-resume-cancel-'));
  const stateDir = path.join(tmpDir, 'state');

  const pipeline =
    "exec --json --shell \"node -e 'process.stdout.write(JSON.stringify([{a:1}]))'\" | approve --prompt 'ok?' | pick a";

  const first = runCli(['run', '--mode', 'tool', pipeline], { LOBSTER_STATE_DIR: stateDir });
  assert.equal(first.status, 0);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.status, 'needs_approval');

  const cancelled = runCli(
    ['resume', '--token', firstJson.requiresApproval.resumeToken, '--approve', 'no'],
    { LOBSTER_STATE_DIR: stateDir },
  );
  assert.equal(cancelled.status, 0);
  const cancelledJson = JSON.parse(cancelled.stdout);
  assert.equal(cancelledJson.status, 'cancelled');

  const files = await fsp.readdir(stateDir);
  const pipelineResumeFiles = files.filter((name) => name.startsWith('pipeline_resume_'));
  assert.deepEqual(pipelineResumeFiles, []);
});

test('cli resume accepts --response-json for input requests', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-resume-input-'));
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

  const first = runCli(['run', '--mode', 'tool', filePath], { LOBSTER_STATE_DIR: stateDir });
  assert.equal(first.status, 0);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.status, 'needs_input');
  assert.ok(firstJson.requiresInput?.resumeToken);

  const resumed = runCli(
    ['resume', '--token', firstJson.requiresInput.resumeToken, '--response-json', '{"decision":"approve"}'],
    { LOBSTER_STATE_DIR: stateDir },
  );
  assert.equal(resumed.status, 0);
  const resumedJson = JSON.parse(resumed.stdout);
  assert.equal(resumedJson.status, 'ok');
  assert.deepEqual(resumedJson.output, [{ text: 'hello' }]);
});

test('resume rejects invalid --response-json with stable parse error', () => {
  const resumed = runCli(
    ['resume', '--token', 'invalid-token', '--response-json', '{'],
    {},
  );
  assert.equal(resumed.status, 2);
  const resumedJson = JSON.parse(resumed.stdout);
  assert.equal(resumedJson.ok, false);
  assert.equal(resumedJson.error?.type, 'parse_error');
  assert.equal(resumedJson.error?.message, 'resume --response-json must be valid JSON');
});

test('pipeline needs_input tokens reject --approve and remain resumable with --response-json', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-resume-pipeline-needs-input-'));
  const stateDir = path.join(tmpDir, 'state');
  const pipeline =
    "ask --prompt 'Decision?' --schema '{\"type\":\"object\",\"properties\":{\"decision\":{\"type\":\"string\"}},\"required\":[\"decision\"]}' | pick decision";

  const first = runCli(['run', '--mode', 'tool', pipeline], { LOBSTER_STATE_DIR: stateDir });
  assert.equal(first.status, 0);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.status, 'needs_input');

  const bad = runCli(
    ['resume', '--token', firstJson.requiresInput.resumeToken, '--approve', 'yes'],
    { LOBSTER_STATE_DIR: stateDir },
  );
  assert.equal(bad.status, 2);
  const badJson = JSON.parse(bad.stdout);
  assert.equal(badJson.ok, false);
  assert.match(String(badJson.error?.message), /require --response-json/i);

  const good = runCli(
    ['resume', '--token', firstJson.requiresInput.resumeToken, '--response-json', '{"decision":"approve"}'],
    { LOBSTER_STATE_DIR: stateDir },
  );
  assert.equal(good.status, 0);
  const goodJson = JSON.parse(good.stdout);
  assert.equal(goodJson.status, 'ok');
  assert.deepEqual(goodJson.output, [{ decision: 'approve' }]);
});

test('pipeline needs_approval tokens reject --response-json and remain resumable with --approve', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-resume-pipeline-needs-approval-'));
  const stateDir = path.join(tmpDir, 'state');
  const pipeline =
    "exec --json --shell \"node -e 'process.stdout.write(JSON.stringify([{a:1}]))'\" | approve --prompt 'ok?' | pick a";

  const first = runCli(['run', '--mode', 'tool', pipeline], { LOBSTER_STATE_DIR: stateDir });
  assert.equal(first.status, 0);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.status, 'needs_approval');

  const bad = runCli(
    ['resume', '--token', firstJson.requiresApproval.resumeToken, '--response-json', '{"decision":"approve"}'],
    { LOBSTER_STATE_DIR: stateDir },
  );
  assert.equal(bad.status, 2);
  const badJson = JSON.parse(bad.stdout);
  assert.equal(badJson.ok, false);
  assert.match(String(badJson.error?.message), /require --approve/i);

  const good = runCli(
    ['resume', '--token', firstJson.requiresApproval.resumeToken, '--approve', 'yes'],
    { LOBSTER_STATE_DIR: stateDir },
  );
  assert.equal(good.status, 0);
  const goodJson = JSON.parse(good.stdout);
  assert.equal(goodJson.status, 'ok');
});

test('workflow input schemas can accept primitive responses', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-resume-input-primitive-'));
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
            env: { TEXT: '$review.response' },
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const first = runCli(['run', '--mode', 'tool', filePath], { LOBSTER_STATE_DIR: stateDir });
  assert.equal(first.status, 0);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.status, 'needs_input');

  const resumed = runCli(
    ['resume', '--token', firstJson.requiresInput.resumeToken, '--response-json', '"hello world"'],
    { LOBSTER_STATE_DIR: stateDir },
  );
  assert.equal(resumed.status, 0);
  const resumedJson = JSON.parse(resumed.stdout);
  assert.equal(resumedJson.status, 'ok');
  assert.deepEqual(resumedJson.output, [{ text: 'hello world' }]);
});

test('legacy pipeline resume state without haltType requires --approve', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-resume-legacy-pipeline-'));
  const stateDir = path.join(tmpDir, 'state');
  const stateKey = 'pipeline_resume_legacy_test';
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

  const bad = runCli(
    ['resume', '--token', token, '--response-json', '{"decision":"approve"}'],
    { LOBSTER_STATE_DIR: stateDir },
  );
  assert.equal(bad.status, 2);
  const badJson = JSON.parse(bad.stdout);
  assert.equal(badJson.ok, false);
  assert.match(String(badJson.error?.message), /legacy pipeline resumes require --approve/i);

  const good = runCli(
    ['resume', '--token', token, '--approve', 'yes'],
    { LOBSTER_STATE_DIR: stateDir },
  );
  assert.equal(good.status, 0);
  const goodJson = JSON.parse(good.stdout);
  assert.equal(goodJson.ok, true);
  assert.equal(goodJson.status, 'ok');
  assert.deepEqual(goodJson.output, [{ a: 1 }]);
});
