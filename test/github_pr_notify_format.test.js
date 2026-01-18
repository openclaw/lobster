import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrChangeSummary } from '../src/workflows/github_pr_monitor.js';

function formatLikeWorkflow({ repo, pr, after, before }) {
  const summary = buildPrChangeSummary(before, after);
  const fields = summary.changedFields.length ? ` (${summary.changedFields.join(', ')})` : '';
  const title = after?.title ? `: ${after.title}` : '';
  const url = after?.url ? ` ${after.url}` : '';
  return `PR updated: ${repo}#${pr}${title}${fields}.${url}`.replace(/\s+/g, ' ').trim();
}

test('notify message includes repo/pr and changed fields', () => {
  const before = { number: 1, title: 'A', url: 'u', state: 'OPEN', updatedAt: 't1' };
  const after = { ...before, title: 'B', updatedAt: 't2' };

  const msg = formatLikeWorkflow({ repo: 'o/r', pr: 1, before, after });
  assert.ok(msg.includes('o/r#1'));
  assert.ok(msg.includes('title'));
  assert.ok(msg.includes('updatedAt'));
});
