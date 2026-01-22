/**
 * GitHub PR Monitor Recipe - Track PR changes over time
 *
 * @example
 * import { prMonitor, prMonitorNotify } from 'lobster/recipes/github';
 *
 * // Full PR state with diff
 * const result = await prMonitor({ repo: 'owner/repo', pr: 123 }).run();
 *
 * // Compact notification when changed
 * const notify = await prMonitorNotify({ repo: 'owner/repo', pr: 123 }).run();
 */

import { Lobster } from '../../sdk/index.js';
import { diffLast } from '../../sdk/primitives/diff.js';
import { ghPrView } from './stages/pr-view.js';

/**
 * Pick a subset of PR fields for comparison
 * @param {Object} snapshot
 * @returns {Object|null}
 */
function pickSubset(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    number: snapshot.number,
    title: snapshot.title,
    url: snapshot.url,
    state: snapshot.state,
    isDraft: snapshot.isDraft,
    mergeable: snapshot.mergeable,
    reviewDecision: snapshot.reviewDecision,
    updatedAt: snapshot.updatedAt,
    baseRefName: snapshot.baseRefName,
    headRefName: snapshot.headRefName,
  };
}

/**
 * Build a summary of what changed between two snapshots
 * @param {Object|null} before
 * @param {Object} after
 * @returns {{ changedFields: string[], changes: Object }}
 */
function buildChangeSummary(before, after) {
  const a = pickSubset(after);
  const b = pickSubset(before);

  if (!a) return { changedFields: [], changes: {} };
  if (!b) {
    return {
      changedFields: Object.keys(a),
      changes: Object.fromEntries(Object.keys(a).map((k) => [k, { from: null, to: a[k] }])),
    };
  }

  const changes = {};
  for (const key of Object.keys(a)) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      changes[key] = { from: b[key], to: a[key] };
    }
  }

  return {
    changedFields: Object.keys(changes),
    changes,
  };
}

/**
 * Format a human-readable change message
 * @param {Object} options
 * @returns {string}
 */
function formatChangeMessage({ repo, pr, changedFields, prInfo }) {
  const fields = changedFields.length ? ` (${changedFields.join(', ')})` : '';
  const title = prInfo?.title ? `: ${prInfo.title}` : '';
  const url = prInfo?.url ? ` ${prInfo.url}` : '';
  return `PR updated: ${repo}#${pr}${title}${fields}.${url}`.replace(/\s+/g, ' ').trim();
}

/**
 * Create a PR monitor workflow
 *
 * @param {Object} options
 * @param {string} options.repo - Repository in owner/repo format
 * @param {number} options.pr - PR number
 * @param {string} [options.key] - State key override
 * @param {boolean} [options.changesOnly=false] - Only output when changed
 * @param {boolean} [options.summaryOnly=false] - Return compact summary
 * @returns {Lobster}
 */
export function prMonitor(options) {
  const { repo, pr, changesOnly = false, summaryOnly = false } = options;
  const key = options.key ?? `github.pr:${repo}#${pr}`;

  if (!repo) throw new Error('prMonitor requires repo');
  if (!pr) throw new Error('prMonitor requires pr');

  const workflow = new Lobster()
    .pipe(ghPrView({ repo, pr }))
    .pipe(diffLast(key))
    .pipe((results) => {
      const diffResult = results[0];
      const current = diffResult.after;
      const before = diffResult.before;
      const changed = diffResult.changed;

      // If changesOnly and no change, suppress output
      if (changesOnly && !changed) {
        return [{
          kind: 'github.pr.monitor',
          repo,
          pr: Number(pr),
          key,
          changed: false,
          suppressed: true,
        }];
      }

      const summary = buildChangeSummary(before, current);

      if (summaryOnly) {
        return [{
          kind: 'github.pr.monitor',
          repo,
          pr: Number(pr),
          key,
          changed,
          summary,
          prInfo: {
            number: current.number,
            title: current.title,
            url: current.url,
            state: current.state,
            updatedAt: current.updatedAt,
          },
        }];
      }

      return [{
        kind: 'github.pr.monitor',
        repo,
        pr: Number(pr),
        key,
        changed,
        summary,
        prSnapshot: current,
      }];
    })
    .meta({
      name: 'github.pr.monitor',
      description: 'Monitor PR state and detect changes',
      requires: ['gh'],
      args: {
        repo: { type: 'string', required: true, description: 'Repository (owner/repo)' },
        pr: { type: 'number', required: true, description: 'PR number' },
        key: { type: 'string', description: 'State key override' },
        changesOnly: { type: 'boolean', default: false, description: 'Only output when changed' },
        summaryOnly: { type: 'boolean', default: false, description: 'Return compact summary' },
      },
    });

  return workflow;
}

// Attach metadata
prMonitor.meta = {
  name: 'github.pr.monitor',
  description: 'Monitor PR state and detect changes',
  requires: ['gh'],
  args: {
    repo: { type: 'string', required: true },
    pr: { type: 'number', required: true },
    key: { type: 'string' },
    changesOnly: { type: 'boolean', default: false },
    summaryOnly: { type: 'boolean', default: false },
  },
};

/**
 * Create a PR monitor notify workflow
 * Returns a compact message only when PR changes
 *
 * @param {Object} options
 * @param {string} options.repo - Repository in owner/repo format
 * @param {number} options.pr - PR number
 * @param {string} [options.key] - State key override
 * @returns {Lobster}
 */
export function prMonitorNotify(options) {
  const { repo, pr } = options;
  const key = options.key ?? `github.pr:${repo}#${pr}`;

  if (!repo) throw new Error('prMonitorNotify requires repo');
  if (!pr) throw new Error('prMonitorNotify requires pr');

  const workflow = new Lobster()
    .pipe(ghPrView({ repo, pr }))
    .pipe(diffLast(key, { changesOnly: true }))
    .pipe((results) => {
      const diffResult = results[0];

      if (diffResult.suppressed) {
        return [{ kind: 'github.pr.monitor.notify', suppressed: true }];
      }

      const current = diffResult.after;
      const before = diffResult.before;
      const summary = buildChangeSummary(before, current);

      const message = formatChangeMessage({
        repo,
        pr: Number(pr),
        changedFields: summary.changedFields,
        prInfo: current,
      });

      return [{
        kind: 'github.pr.monitor.notify',
        changed: true,
        repo,
        pr: Number(pr),
        message,
        prInfo: {
          number: current.number,
          title: current.title,
          url: current.url,
          state: current.state,
        },
        summary,
      }];
    })
    .meta({
      name: 'github.pr.monitor.notify',
      description: 'Emit a notification message when PR changes',
      requires: ['gh'],
      args: {
        repo: { type: 'string', required: true },
        pr: { type: 'number', required: true },
        key: { type: 'string' },
      },
    });

  return workflow;
}

// Attach metadata
prMonitorNotify.meta = {
  name: 'github.pr.monitor.notify',
  description: 'Emit a notification message when PR changes',
  requires: ['gh'],
  args: {
    repo: { type: 'string', required: true },
    pr: { type: 'number', required: true },
    key: { type: 'string' },
  },
};
