import { spawn } from 'node:child_process';

export const execCommand = {
  name: 'exec',
  help() {
    return `exec — run an OS command\n\n` +
      `Usage:\n` +
      `  exec <command...>\n` +
      `  exec --json <command...>\n` +
      `  exec --shell "<command line>"\n\n` +
      `Notes:\n` +
      `  - With --json, parses stdout as JSON (single value).\n` +
      `  - With --shell (or a single arg containing spaces), runs via /bin/sh -lc.\n`;
  },
  async run({ args, ctx }) {
    const cmd = args._;

    const shellLine = typeof args.shell === 'string' ? args.shell : null;
    const useShell = Boolean(args.shell) || (cmd.length === 1 && /\s/.test(cmd[0]));

    if (!cmd.length && !shellLine) throw new Error('exec requires a command');

    const result = useShell
      ? await runProcess('/bin/sh', ['-lc', shellLine ?? cmd[0] ?? ''], { env: ctx.env, cwd: process.cwd() })
      : await runProcess(cmd[0], cmd.slice(1), { env: ctx.env, cwd: process.cwd() });

    if (args.json) {
      let parsed;
      try {
        parsed = JSON.parse(result.stdout.trim() || 'null');
      } catch (err) {
        throw new Error(`exec --json could not parse stdout as JSON: ${err?.message ?? String(err)}`);
      }

      return {
        output: asStream(Array.isArray(parsed) ? parsed : [parsed]),
      };
    }

    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    return { output: asStream(lines) };
  },
};

function runProcess(command, argv, { env, cwd }) {
  return new Promise<any>((resolve, reject) => {
    const child = spawn(command, argv, {
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

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`exec failed (${code}): ${stderr.trim() || stdout.trim() || command}`));
    });
  });
}

async function* asStream(items) {
  for (const item of items) yield item;
}
