import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { listRuns, getRunDetail, cancelRun } from '../src/query.js';
import { decodeResumeToken } from '../src/resume.js';

function makeEnv(stateDir) {
  return { ...process.env, LOBSTER_STATE_DIR: stateDir };
}

async function writeResumeState(stateDir, id, state) {
  await fsp.writeFile(
    path.join(stateDir, `workflow_resume_${id}.json`),
    JSON.stringify(state, null, 2),
    'utf8'
  );
}

function makeValidState(overrides = {}) {
  return {
    filePath: '/tmp/test.lobster',
    resumeAtIndex: 3,
    steps: {
      collect: { id: 'collect', stdout: 'data', json: [1, 2] },
      approve: { id: 'approve', json: { prompt: 'Send drafts?' } },
    },
    args: { query: 'newer_than:1d' },
    approvalStepId: 'approve',
    createdAt: '2026-03-05T21:00:00.000Z',
    ...overrides,
  };
}

test('listRuns returns empty array for empty dir', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-query-'));
  const runs = await listRuns(makeEnv(tmp));
  assert.deepEqual(runs, []);
});

test('listRuns returns empty array for nonexistent dir', async () => {
  const runs = await listRuns(makeEnv('/tmp/lobster-nonexistent-' + Date.now()));
  assert.deepEqual(runs, []);
});

test('listRuns finds halted runs sorted newest first', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-query-'));
  await writeResumeState(tmp, 'aaa-111', makeValidState({ createdAt: '2026-03-04T10:00:00.000Z' }));
  await writeResumeState(tmp, 'bbb-222', makeValidState({ createdAt: '2026-03-05T10:00:00.000Z' }));

  const runs = await listRuns(makeEnv(tmp));
  assert.equal(runs.length, 2);
  assert.equal(runs[0].id, 'bbb-222');
  assert.equal(runs[1].id, 'aaa-111');
});

test('listRuns skips non-resume files', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-query-'));
  await fsp.writeFile(path.join(tmp, 'pr_state.json'), '{}', 'utf8');
  await writeResumeState(tmp, 'ccc-333', makeValidState());

  const runs = await listRuns(makeEnv(tmp));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, 'ccc-333');
});

test('listRuns skips corrupt JSON', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-query-'));
  await fsp.writeFile(path.join(tmp, 'workflow_resume_bad.json'), '{not valid json', 'utf8');
  await writeResumeState(tmp, 'good-444', makeValidState());

  const runs = await listRuns(makeEnv(tmp));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, 'good-444');
});

test('getRunDetail returns full detail for valid id', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-query-'));
  await writeResumeState(tmp, 'ddd-555', makeValidState());

  const detail = await getRunDetail('ddd-555', makeEnv(tmp));
  assert.ok(detail);
  assert.equal(detail.id, 'ddd-555');
  assert.equal(detail.status, 'halted');
  assert.equal(detail.workflowName, 'test');
  assert.ok(detail.steps);
  assert.ok(detail.steps.collect);
  assert.ok(detail.args);
});

test('getRunDetail returns null for nonexistent id', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-query-'));
  const detail = await getRunDetail('nonexistent', makeEnv(tmp));
  assert.equal(detail, null);
});

test('getRunDetail includes resumeToken', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-query-'));
  await writeResumeState(tmp, 'eee-666', makeValidState());

  const detail = await getRunDetail('eee-666', makeEnv(tmp));
  assert.ok(detail);
  assert.ok(typeof detail.resumeToken === 'string');
  assert.ok(detail.resumeToken.length > 0);
  assert.deepEqual(decodeResumeToken(detail.resumeToken), {
    protocolVersion: 1,
    v: 1,
    kind: 'workflow-file',
    stateKey: 'workflow_resume_eee-666',
  });
});

test('getRunDetail extracts approval prompt', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-query-'));
  await writeResumeState(tmp, 'fff-777', makeValidState());

  const detail = await getRunDetail('fff-777', makeEnv(tmp));
  assert.ok(detail);
  assert.equal(detail.approvalPrompt, 'Send drafts?');
});

test('cancelRun deletes file and returns true', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-query-'));
  await writeResumeState(tmp, 'ggg-888', makeValidState());

  const result = await cancelRun('ggg-888', makeEnv(tmp));
  assert.equal(result, true);

  // Verify file is gone
  const files = await fsp.readdir(tmp);
  assert.equal(files.filter((f) => f.includes('ggg-888')).length, 0);
});

test('cancelRun returns false for missing file', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobster-query-'));
  const result = await cancelRun('nonexistent', makeEnv(tmp));
  assert.equal(result, false);
});
