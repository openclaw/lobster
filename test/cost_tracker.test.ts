import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CostTracker } from '../src/core/cost_tracker.js';
import { createDefaultRegistry } from '../src/commands/registry.js';
import { runWorkflowFile } from '../src/workflows/file.js';

// --- CostTracker unit tests ---

test('CostTracker records usage and calculates cost', () => {
  const tracker = new CostTracker();
  tracker.recordUsage('step1', 'gpt-4o', { inputTokens: 1000, outputTokens: 500 });
  const summary = tracker.getSummary();
  assert.equal(summary.totalInputTokens, 1000);
  assert.equal(summary.totalOutputTokens, 500);
  // gpt-4o: 1000 * 2.50/1M + 500 * 10.00/1M = 0.0025 + 0.005 = 0.0075
  assert.equal(summary.estimatedCostUsd, 0.0075);
  assert.equal(summary.byStep.length, 1);
  assert.equal(summary.byStep[0].stepId, 'step1');
});

test('CostTracker accumulates across steps', () => {
  const tracker = new CostTracker();
  tracker.recordUsage('a', 'gpt-4o', { inputTokens: 1000, outputTokens: 0 });
  tracker.recordUsage('b', 'gpt-4o', { inputTokens: 1000, outputTokens: 0 });
  const summary = tracker.getSummary();
  assert.equal(summary.totalInputTokens, 2000);
  assert.equal(summary.byStep.length, 2);
});

test('CostTracker handles unknown model with zero cost', () => {
  const tracker = new CostTracker();
  tracker.recordUsage('step1', 'unknown-model', { inputTokens: 1000, outputTokens: 500 });
  const summary = tracker.getSummary();
  assert.equal(summary.estimatedCostUsd, 0);
  assert.equal(summary.totalInputTokens, 1000);
});

test('CostTracker supports custom pricing', () => {
  const tracker = new CostTracker({ 'my-model': { input: 5.0, output: 15.0 } });
  tracker.recordUsage('step1', 'my-model', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  const summary = tracker.getSummary();
  assert.equal(summary.estimatedCostUsd, 20.0);
});

test('CostTracker checkLimit throws on stop', () => {
  const tracker = new CostTracker();
  tracker.recordUsage('step1', 'gpt-4o', { inputTokens: 10_000_000, outputTokens: 10_000_000 });
  assert.throws(
    () => tracker.checkLimit({ max_usd: 0.01, action: 'stop' }),
    /Cost limit exceeded/,
  );
});

test('CostTracker checkLimit does not throw on warn', () => {
  const tracker = new CostTracker();
  tracker.recordUsage('step1', 'gpt-4o', { inputTokens: 10_000_000, outputTokens: 10_000_000 });
  // Should not throw
  tracker.checkLimit({ max_usd: 0.01, action: 'warn' });
});

test('CostTracker hasUsage returns false when empty', () => {
  const tracker = new CostTracker();
  assert.equal(tracker.hasUsage(), false);
});

test('CostTracker hasUsage returns true after recording', () => {
  const tracker = new CostTracker();
  tracker.recordUsage('step1', null, { inputTokens: 100 });
  assert.equal(tracker.hasUsage(), true);
});

test('CostTracker handles OpenAI-style field names', () => {
  const tracker = new CostTracker();
  tracker.recordUsage('step1', 'gpt-4o', { prompt_tokens: 1000, completion_tokens: 500 });
  const summary = tracker.getSummary();
  assert.equal(summary.totalInputTokens, 1000);
  assert.equal(summary.totalOutputTokens, 500);
});

test('CostTracker parsePricingFromEnv', () => {
  const pricing = CostTracker.parsePricingFromEnv({
    LOBSTER_LLM_PRICING_JSON: '{"custom":{"input":1,"output":2}}',
  });
  assert.deepEqual(pricing, { custom: { input: 1, output: 2 } });
});

test('CostTracker parsePricingFromEnv returns undefined for missing env', () => {
  assert.equal(CostTracker.parsePricingFromEnv({}), undefined);
});

// --- Integration: cost metadata in workflow results ---

test('workflow result includes _meta.cost when LLM usage is present', async () => {
  // Simulate a workflow where a step produces output with usage data
  // We use a shell command that outputs JSON with usage field
  const workflow = {
    name: 'cost-test',
    steps: [
      {
        id: 'llm_step',
        command: `node -e "process.stdout.write(JSON.stringify({model:'gpt-4o',output:{text:'hi'},usage:{inputTokens:100,outputTokens:50}}))"`,
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-cost-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: 'tool',
    },
  });

  assert.equal(result.status, 'ok');
  assert.ok(result._meta?.cost);
  assert.equal(result._meta!.cost!.totalInputTokens, 100);
  assert.equal(result._meta!.cost!.totalOutputTokens, 50);
  assert.equal(result._meta!.cost!.byStep.length, 1);
  assert.equal(result._meta!.cost!.byStep[0].model, 'gpt-4o');
});

test('workflow result omits _meta.cost when no LLM usage', async () => {
  const workflow = {
    name: 'no-cost-test',
    steps: [
      { id: 'plain', command: 'echo "hello"' },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-cost-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: 'tool',
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result._meta, undefined);
});
