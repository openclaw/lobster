import { test, expect } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseLobsterRunCommand, resolveWorkflowByName } from '../src/workflows/file.js';

// parseLobsterRunCommand tests

test('parseLobsterRunCommand: parses --name', () => {
  const result = parseLobsterRunCommand('lobster.run --name my-workflow');
  expect(result).toEqual({ name: 'my-workflow', file: undefined, argsJson: undefined });
});

test('parseLobsterRunCommand: parses --file and --args-json', () => {
  const result = parseLobsterRunCommand('lobster.run --file ./path.lobster --args-json \'{"a":1}\'');
  expect(result).toEqual({ name: undefined, file: './path.lobster', argsJson: '{"a":1}' });
});

test('parseLobsterRunCommand: parses --name with --args-json', () => {
  const result = parseLobsterRunCommand('lobster.run --name child --args-json \'{"x":42}\'');
  expect(result).toEqual({ name: 'child', file: undefined, argsJson: '{"x":42}' });
});

test('parseLobsterRunCommand: returns null for non-lobster commands', () => {
  expect(parseLobsterRunCommand('exec --shell "echo hi"')).toBe(null);
  expect(parseLobsterRunCommand('echo lobster.run')).toBe(null);
  expect(parseLobsterRunCommand('')).toBe(null);
});

test('parseLobsterRunCommand: errors on both --name and --file', () => {
  expect(() => parseLobsterRunCommand('lobster.run --name x --file y.lobster')).toThrow();
});

test('parseLobsterRunCommand: errors on neither --name nor --file', () => {
  expect(() => parseLobsterRunCommand('lobster.run --args-json \'{"a":1}\'')).toThrow();
});

test('parseLobsterRunCommand: handles args-json with double quotes', () => {
  const result = parseLobsterRunCommand('lobster.run --name child --args-json {"a":1}');
  expect(result?.name).toBe('child');
  expect(result?.argsJson).toBe('{"a":1}');
});

// resolveWorkflowByName tests

test('resolveWorkflowByName: finds .lobster in parent dir', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-resolve-'));
  const wfFile = path.join(dir, 'my-workflow.lobster');
  await fsp.writeFile(wfFile, '{}', 'utf8');

  const parentFilePath = path.join(dir, 'parent.lobster');
  const result = await resolveWorkflowByName('my-workflow', parentFilePath, undefined, undefined);
  expect(result).toBe(wfFile);
});

test('resolveWorkflowByName: finds .yaml extension', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-resolve-'));
  const wfFile = path.join(dir, 'my-workflow.yaml');
  await fsp.writeFile(wfFile, '{}', 'utf8');

  const parentFilePath = path.join(dir, 'parent.lobster');
  const result = await resolveWorkflowByName('my-workflow', parentFilePath, undefined, undefined);
  expect(result).toBe(wfFile);
});

test('resolveWorkflowByName: falls back to LOBSTER_WORKFLOW_PATH', async () => {
  const parentDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-parent-'));
  const searchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-search-'));
  const wfFile = path.join(searchDir, 'my-workflow.lobster');
  await fsp.writeFile(wfFile, '{}', 'utf8');

  const parentFilePath = path.join(parentDir, 'parent.lobster');
  const result = await resolveWorkflowByName('my-workflow', parentFilePath, searchDir, undefined);
  expect(result).toBe(wfFile);
});

test('resolveWorkflowByName: falls back to cwd', async () => {
  const parentDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-parent-'));
  const cwdDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-cwd-'));
  const wfFile = path.join(cwdDir, 'my-workflow.lobster');
  await fsp.writeFile(wfFile, '{}', 'utf8');

  const parentFilePath = path.join(parentDir, 'parent.lobster');
  const result = await resolveWorkflowByName('my-workflow', parentFilePath, undefined, cwdDir);
  expect(result).toBe(wfFile);
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
  expect(result).toBe(wfInParent);
});

test('resolveWorkflowByName: throws when not found', async () => {
  await expect(
    resolveWorkflowByName('nonexistent', '/tmp/parent.lobster', undefined, undefined),
  ).rejects.toThrow(/not found/i);
});

test('resolveWorkflowByName: colon-separated LOBSTER_WORKFLOW_PATH', async () => {
  const dir1 = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-d1-'));
  const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-d2-'));
  const wfFile = path.join(dir2, 'my-workflow.lobster');
  await fsp.writeFile(wfFile, '{}', 'utf8');

  const parentFilePath = path.join(os.tmpdir(), 'parent.lobster');
  const result = await resolveWorkflowByName('my-workflow', parentFilePath, `${dir1}:${dir2}`, undefined);
  expect(result).toBe(wfFile);
});
