import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseLobsterRunCommand, resolveWorkflowByName } from '../src/workflows/file.js';

// parseLobsterRunCommand tests

test('parseLobsterRunCommand: parses --name', () => {
  const result = parseLobsterRunCommand('lobster.run --name my-workflow');
  assert.deepEqual(result, { name: 'my-workflow', file: undefined, argsJson: undefined });
});

test('parseLobsterRunCommand: parses --file and --args-json', () => {
  const result = parseLobsterRunCommand("lobster.run --file ./path.lobster --args-json '{\"a\":1}'");
  assert.deepEqual(result, { name: undefined, file: './path.lobster', argsJson: '{"a":1}' });
});

test('parseLobsterRunCommand: parses --name with --args-json', () => {
  const result = parseLobsterRunCommand("lobster.run --name child --args-json '{\"x\":42}'");
  assert.deepEqual(result, { name: 'child', file: undefined, argsJson: '{"x":42}' });
});

test('parseLobsterRunCommand: returns null for non-lobster commands', () => {
  assert.equal(parseLobsterRunCommand('exec --shell "echo hi"'), null);
  assert.equal(parseLobsterRunCommand('echo lobster.run'), null);
  assert.equal(parseLobsterRunCommand(''), null);
});

test('parseLobsterRunCommand: errors on both --name and --file', () => {
  assert.throws(() => parseLobsterRunCommand('lobster.run --name x --file y.lobster'));
});

test('parseLobsterRunCommand: errors on neither --name nor --file', () => {
  assert.throws(() => parseLobsterRunCommand("lobster.run --args-json '{\"a\":1}'"));
});

test('parseLobsterRunCommand: handles args-json without quotes', () => {
  const result = parseLobsterRunCommand('lobster.run --name child --args-json {"a":1}');
  assert.equal(result?.name, 'child');
  assert.equal(result?.argsJson, '{"a":1}');
});

// resolveWorkflowByName tests

test('resolveWorkflowByName: finds .lobster in parent dir', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-resolve-'));
  const wfFile = path.join(dir, 'my-workflow.lobster');
  await fsp.writeFile(wfFile, '{}', 'utf8');

  const parentFilePath = path.join(dir, 'parent.lobster');
  const result = await resolveWorkflowByName('my-workflow', parentFilePath, undefined, undefined);
  assert.equal(result, wfFile);
});

test('resolveWorkflowByName: finds .yaml extension', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-resolve-'));
  const wfFile = path.join(dir, 'my-workflow.yaml');
  await fsp.writeFile(wfFile, '{}', 'utf8');

  const parentFilePath = path.join(dir, 'parent.lobster');
  const result = await resolveWorkflowByName('my-workflow', parentFilePath, undefined, undefined);
  assert.equal(result, wfFile);
});

test('resolveWorkflowByName: falls back to LOBSTER_WORKFLOW_PATH', async () => {
  const parentDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-parent-'));
  const searchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-search-'));
  const wfFile = path.join(searchDir, 'my-workflow.lobster');
  await fsp.writeFile(wfFile, '{}', 'utf8');

  const parentFilePath = path.join(parentDir, 'parent.lobster');
  const result = await resolveWorkflowByName('my-workflow', parentFilePath, searchDir, undefined);
  assert.equal(result, wfFile);
});

test('resolveWorkflowByName: falls back to cwd', async () => {
  const parentDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-parent-'));
  const cwdDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-cwd-'));
  const wfFile = path.join(cwdDir, 'my-workflow.lobster');
  await fsp.writeFile(wfFile, '{}', 'utf8');

  const parentFilePath = path.join(parentDir, 'parent.lobster');
  const result = await resolveWorkflowByName('my-workflow', parentFilePath, undefined, cwdDir);
  assert.equal(result, wfFile);
});

test('resolveWorkflowByName: parent dir takes priority over LOBSTER_WORKFLOW_PATH', async () => {
  const parentDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-parent-'));
  const searchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-search-'));
  const wfInParent = path.join(parentDir, 'my-workflow.lobster');
  const wfInSearch = path.join(searchDir, 'my-workflow.lobster');
  await fsp.writeFile(wfInParent, '{}', 'utf8');
  await fsp.writeFile(wfInSearch, '{}', 'utf8');

  const parentFilePath = path.join(parentDir, 'parent.lobster');
  const result = await resolveWorkflowByName('my-workflow', parentFilePath, searchDir, undefined);
  assert.equal(result, wfInParent);
});

test('resolveWorkflowByName: throws when not found', async () => {
  await assert.rejects(
    resolveWorkflowByName('nonexistent', '/tmp/parent.lobster', undefined, undefined),
    /not found/i,
  );
});

test('resolveWorkflowByName: colon-separated LOBSTER_WORKFLOW_PATH', async () => {
  const dir1 = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-d1-'));
  const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-d2-'));
  const wfFile = path.join(dir2, 'my-workflow.lobster');
  await fsp.writeFile(wfFile, '{}', 'utf8');

  const parentFilePath = path.join(os.tmpdir(), 'parent.lobster');
  const result = await resolveWorkflowByName('my-workflow', parentFilePath, `${dir1}:${dir2}`, undefined);
  assert.equal(result, wfFile);
});
