import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrChangeSummary } from '../src/workflows/github_pr_monitor.js';

const build = buildPrChangeSummary as any;

test('buildPrChangeSummary reports all fields on first snapshot', () => {
  const after = {
    number: 1,
    title: 'A',
    url: 'u',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    updatedAt: 't1',
    baseRefName: 'main',
    headRefName: 'feat',
  };

  const res = build(null, after);
  assert.ok(res.changedFields.length > 0);
  assert.equal(res.changes.title.to, 'A');
});

test('buildPrChangeSummary only includes changed fields', () => {
  const before = {
    number: 1,
    title: 'A',
    url: 'u',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    updatedAt: 't1',
    baseRefName: 'main',
    headRefName: 'feat',
  };
  const after = { ...before, title: 'B', updatedAt: 't2' };

  const res = build(before, after);
  assert.deepEqual(res.changedFields.sort(), ['title', 'updatedAt'].sort());
  assert.equal(res.changes.title.from, 'A');
  assert.equal(res.changes.title.to, 'B');
});
