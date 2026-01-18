import { spawn } from 'node:child_process';

export const gogGmailSendCommand = {
  name: 'gog.gmail.send',
  help() {
    return `gog.gmail.send — send an email via steipete/gog\n\n` +
      `Usage:\n` +
      `  gog.gmail.send --to a@b.com --subject "Hi" --body "Hello" [--account you@gmail.com]\n\n` +
      `Notes:\n` +
      `  - Does not handle auth; relies on existing gog auth/credentials locally.\n` +
      `  - Prefer running behind an approval gate (e.g. | approve --prompt "Send?").\n`;
  },
  async run({ args, ctx }) {
    const to = args.to;
    const subject = args.subject;
    const body = args.body;
    const account = args.account;

    if (!to || !subject || body === undefined) {
      throw new Error('gog.gmail.send requires --to, --subject, and --body');
    }

    const env = { ...ctx.env };
    if (account) env.GOG_ACCOUNT = String(account);

    const argv = ['gmail', 'send', '--to', String(to), '--subject', String(subject), '--body', String(body), '--no-input'];

    const { stdout } = await runProcess('gog', argv, { env, cwd: process.cwd() });

    return {
      output: (async function* () {
        yield { ok: true, to, subject, result: stdout.trim() };
      })(),
    };
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
