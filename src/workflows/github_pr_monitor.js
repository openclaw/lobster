import { spawn } from 'node:child_process';

function runProcess(command, argv, { env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (err?.code === 'ENOENT') {
        reject(new Error('gh not found on PATH (install GitHub CLI)'));
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`gh failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

import { diffAndStore } from '../state/store.js';

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

export function buildPrChangeSummary(before, after) {
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

function formatPrChangeMessage({ repo, pr, changedFields, prInfo }) {
  const fields = changedFields.length ? ` (${changedFields.join(', ')})` : '';
  const title = prInfo?.title ? `: ${prInfo.title}` : '';
  const url = prInfo?.url ? ` ${prInfo.url}` : '';
  return `PR updated: ${repo}#${pr}${title}${fields}.${url}`.replace(/\s+/g, ' ').trim();
}

export async function runGithubPrMonitorWorkflow({ args, ctx }) {
  const repo = args.repo;
  const pr = args.pr;
  if (!repo || !pr) throw new Error('github.pr.monitor requires args.repo and args.pr');

  const key = args.key ?? `github.pr:${repo}#${pr}`;
  const changesOnly = Boolean(args.changesOnly);
  const summaryOnly = Boolean(args.summaryOnly);

  const argv = [
    'pr',
    'view',
    String(pr),
    '--repo',
    String(repo),
    '--json',
    'number,title,url,state,isDraft,mergeable,reviewDecision,author,baseRefName,headRefName,updatedAt',
  ];

  const { stdout } = await runProcess('gh', argv, { env: ctx.env, cwd: process.cwd() });

  let current;
  try {
    current = JSON.parse(stdout.trim());
  } catch {
    throw new Error('gh returned non-JSON output');
  }

  const { changed, before } = await diffAndStore({ env: ctx.env, key, value: current });

  if (changesOnly && !changed) {
    return {
      kind: 'github.pr.monitor',
      repo,
      pr: Number(pr),
      key,
      changed: false,
      suppressed: true,
    };
  }

  const summary = buildPrChangeSummary(before, current);

  if (summaryOnly) {
    return {
      kind: 'github.pr.monitor',
      repo,
      pr: Number(pr),
      key,
      changed,
      summary,
      pr: {
        number: current.number,
        title: current.title,
        url: current.url,
        state: current.state,
        updatedAt: current.updatedAt,
      },
    };
  }

  return {
    kind: 'github.pr.monitor',
    repo,
    pr: Number(pr),
    key,
    changed,
    summary,
    prSnapshot: current,
  };
}

export async function runGithubPrMonitorNotifyWorkflow({ args, ctx }) {
  const base = await runGithubPrMonitorWorkflow({
    args: {
      ...args,
      changesOnly: true,
      summaryOnly: true,
    },
    ctx,
  });

  if (base.suppressed) {
    return { kind: 'github.pr.monitor.notify', suppressed: true };
  }

  const changedFields = base.summary?.changedFields ?? [];
  const prInfo = base.pr ?? {};

  return {
    kind: 'github.pr.monitor.notify',
    changed: Boolean(base.changed),
    repo: args.repo,
    pr: Number(args.pr),
    message: formatPrChangeMessage({
      repo: args.repo,
      pr: Number(args.pr),
      changedFields,
      prInfo,
    }),
    pr: prInfo,
    summary: base.summary,
  };
}
