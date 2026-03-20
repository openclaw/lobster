import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCondition } from '../src/workflows/file.js';
import type { WorkflowStepResult } from '../src/workflows/file.js';

// Deep property access — truthiness
test('evaluateCondition: deep property access truthiness', () => {
  const results: Record<string, WorkflowStepResult> = {
    check: { id: 'check', stdout: '', json: { nested: { flag: true } } },
  };
  assert.equal(evaluateCondition('$check.json.nested.flag', results), true);
});

test('evaluateCondition: deep property missing returns falsy', () => {
  const results: Record<string, WorkflowStepResult> = {
    check: { id: 'check', stdout: '', json: { nested: {} } },
  };
  assert.equal(evaluateCondition('$check.json.nested.missing', results), false);
});

// Comparison operators
test('evaluateCondition: string equality', () => {
  const results: Record<string, WorkflowStepResult> = {
    step: { id: 'step', stdout: '', json: { status: 'ready' } },
  };
  assert.equal(evaluateCondition('$step.json.status == "ready"', results), true);
  assert.equal(evaluateCondition('$step.json.status == "pending"', results), false);
});

test('evaluateCondition: numeric comparison', () => {
  const results: Record<string, WorkflowStepResult> = {
    step: { id: 'step', stdout: '', json: { count: 5 } },
  };
  assert.equal(evaluateCondition('$step.json.count > 0', results), true);
  assert.equal(evaluateCondition('$step.json.count < 3', results), false);
  assert.equal(evaluateCondition('$step.json.count >= 5', results), true);
  assert.equal(evaluateCondition('$step.json.count <= 4', results), false);
  assert.equal(evaluateCondition('$step.json.count != 5', results), false);
});

test('evaluateCondition: boolean comparison', () => {
  const results: Record<string, WorkflowStepResult> = {
    step: { id: 'step', stdout: '', json: { done: true } },
  };
  assert.equal(evaluateCondition('$step.json.done == true', results), true);
  assert.equal(evaluateCondition('$step.json.done == false', results), false);
});

test('evaluateCondition: null comparison', () => {
  const results: Record<string, WorkflowStepResult> = {
    step: { id: 'step', stdout: '', json: { val: null } },
  };
  assert.equal(evaluateCondition('$step.json.val == null', results), true);
});

// Backward compat
test('evaluateCondition: existing patterns still work', () => {
  const results: Record<string, WorkflowStepResult> = {
    step: { id: 'step', stdout: '', json: undefined, approved: true, skipped: false },
  };
  assert.equal(evaluateCondition('$step.approved', results), true);
  assert.equal(evaluateCondition('$step.skipped', results), false);
  assert.equal(evaluateCondition(true, results), true);
  assert.equal(evaluateCondition(undefined, results), true);
});

test('evaluateCondition: false literal', () => {
  assert.equal(evaluateCondition(false, {}), false);
  assert.equal(evaluateCondition('false', {}), false);
});

test('evaluateCondition: step not in results returns falsy for bare ref', () => {
  assert.equal(evaluateCondition('$missing.json.field', {}), false);
});

test('evaluateCondition: null json field returns falsy', () => {
  const results: Record<string, WorkflowStepResult> = {
    step: { id: 'step', stdout: '', json: { flag: null } },
  };
  assert.equal(evaluateCondition('$step.json.flag', results), false);
});

test('evaluateCondition: inequality', () => {
  const results: Record<string, WorkflowStepResult> = {
    step: { id: 'step', stdout: '', json: { status: 'ready' } },
  };
  assert.equal(evaluateCondition('$step.json.status != "other"', results), true);
  assert.equal(evaluateCondition('$step.json.status != "ready"', results), false);
});
