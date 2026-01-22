/**
 * GitHub PR View Stage - Fetch PR details via gh CLI
 *
 * @example
 * import { Lobster } from 'lobster-sdk';
 * import { ghPrView } from 'lobster/recipes/github';
 *
 * new Lobster()
 *   .pipe(ghPrView({ repo: 'owner/repo', pr: 123 }))
 *   .pipe(pr => console.log(pr.state));
 */

import { spawn } from 'node:child_process';

/**
 * Run gh command
 * @param {string[]} argv
 * @param {Object} options
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runGh(argv, { env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', argv, {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`gh failed (${code}): ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}

/**
 * Create a GitHub PR view stage
 *
 * @param {Object} options
 * @param {string} options.repo - Repository in owner/repo format
 * @param {number} options.pr - PR number
 * @param {string[]} [options.fields] - Fields to fetch
 * @returns {Object} Stage object with run method
 */
export function ghPrView(options) {
  const { repo, pr } = options;
  const fields = options.fields ?? [
    'number', 'title', 'url', 'state', 'isDraft',
    'mergeable', 'reviewDecision', 'author',
    'baseRefName', 'headRefName', 'updatedAt',
  ];

  if (!repo) throw new Error('ghPrView requires repo');
  if (!pr) throw new Error('ghPrView requires pr');

  return {
    type: 'github.pr.view',
    repo,
    pr,

    async run({ input, ctx }) {
      // Drain input
      for await (const _ of input) {
        // no-op
      }

      const argv = [
        'pr', 'view',
        String(pr),
        '--repo', String(repo),
        '--json', fields.join(','),
      ];

      const { stdout } = await runGh(argv, { env: ctx.env, cwd: process.cwd() });

      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        throw new Error('gh returned non-JSON output');
      }

      return {
        output: (async function* () {
          yield parsed;
        })(),
      };
    },
  };
}
