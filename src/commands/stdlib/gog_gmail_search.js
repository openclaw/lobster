import { spawn } from 'node:child_process';

export const gogGmailSearchCommand = {
  name: 'gog.gmail.search',
  help() {
    return `gog.gmail.search — fetch Gmail messages via steipete/gog\n\n` +
      `Usage:\n` +
      `  gog.gmail.search --query "newer_than:7d" --max 10 [--account you@gmail.com]\n\n` +
      `Behavior:\n` +
      `  - Runs: gog gmail search <query> --max <n> --json --no-input\n` +
      `  - Does not handle auth; relies on existing gog auth/credentials locally.\n`;
  },
  async run({ args, ctx }) {
    const query = args.query ?? args._[0];
    const max = args.max ?? 10;
    const account = args.account;

    if (!query) throw new Error('gog.gmail.search requires --query');

    const env = { ...ctx.env };
    if (account) env.GOG_ACCOUNT = String(account);

    const argv = ['gmail', 'search', String(query), '--max', String(max), '--json', '--no-input'];
    const { stdout } = await runProcess('gog', argv, { env, cwd: process.cwd() });

    let parsed;
    try {
      parsed = JSON.parse(stdout.trim() || '[]');
    } catch (err) {
      throw new Error(`gog gmail search returned non-JSON output`);
    }

    // Keep it permissive: pass through what gog returns.
    // Later we can normalize into a canonical EmailMessage schema.
    const items = Array.isArray(parsed) ? parsed : [parsed];

    return { output: asStream(items) };
  },
};

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
        reject(new Error('gog not found on PATH (install steipete/gog from ClawdHub)'));
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`gog failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function* asStream(items) {
  for (const item of items) yield item;
}
