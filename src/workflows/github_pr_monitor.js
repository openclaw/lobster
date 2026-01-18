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

function stableStringify(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
}

export async function runGithubPrMonitorWorkflow({ args, ctx }) {
  const repo = args.repo;
  const pr = args.pr;
  if (!repo || !pr) throw new Error('github.pr.monitor requires args.repo and args.pr');

  const key = args.key ?? `github.pr:${repo}#${pr}`;

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

  // Use Lobster state store convention (same dir) without depending on commands.
  // Store the last snapshot under the same key.
  const stateDir = (ctx.env.LOBSTER_STATE_DIR && String(ctx.env.LOBSTER_STATE_DIR).trim()) || null;

  const before = await (async () => {
    if (!stateDir) return null;
    const { promises: fsp } = await import('node:fs');
    const { join } = await import('node:path');

    const safe = String(key).toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    const filePath = join(stateDir, `${safe}.json`);

    try {
      const text = await fsp.readFile(filePath, 'utf8');
      return JSON.parse(text);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  })();

  const changed = stableStringify(before) !== stableStringify(current);

  // Persist if possible.
  if (stateDir) {
    const { promises: fsp } = await import('node:fs');
    const { join } = await import('node:path');
    await fsp.mkdir(stateDir, { recursive: true });
    const safe = String(key).toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    await fsp.writeFile(join(stateDir, `${safe}.json`), JSON.stringify(current, null, 2) + '\n', 'utf8');
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
