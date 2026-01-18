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

export async function runGithubPrMonitorWorkflow({ args, ctx }) {
  const repo = args.repo;
  const pr = args.pr;
  if (!repo || !pr) throw new Error('github.pr.monitor requires args.repo and args.pr');

  const key = args.key ?? `github.pr:${repo}#${pr}`;
  const changesOnly = Boolean(args.changesOnly);

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

  const { changed } = await diffAndStore({ env: ctx.env, key, value: current });

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

  return {
    kind: 'github.pr.monitor',
    repo,
    pr: Number(pr),
    key,
    changed,
    prSnapshot: current,
  };
}
