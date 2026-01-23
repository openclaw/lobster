import { spawn } from 'node:child_process';

export const execCommand = {
  name: 'exec',
  meta: {
    description: 'Run an OS command',
    argsSchema: {
      type: 'object',
      properties: {
        json: { type: 'boolean', description: 'Parse stdout as JSON (single value).' },
        shell: { type: 'string', description: 'Run via /bin/sh -lc with this command line.' },
        _: { type: 'array', items: { type: 'string' }, description: 'Command + args.' },
      },
      required: ['_'],
    },
    sideEffects: ['local_exec'],
  },
  help() {
    return `exec — run an OS command\n\n` +
      `Usage:\n` +
      `  exec <command...>\n` +
      `  exec --stdin raw|json|jsonl <command...>\n` +
      `  exec --json <command...>\n` +
      `  exec --shell "<command line>"\n\n` +
      `Notes:\n` +
      `  - With --json, parses stdout as JSON (single value).\n` +
      `  - With --stdin, writes pipeline input to stdin.\n` +
      `  - With --shell (or a single arg containing spaces), runs via /bin/sh -lc.\n`;
  },
  async run({ input, args, ctx }) {
    const cmd = args._;

    const shellLine = typeof args.shell === 'string' ? args.shell : null;
    const useShell = Boolean(args.shell) || (cmd.length === 1 && /\s/.test(cmd[0]));
    const stdinMode = typeof args.stdin === 'string' ? String(args.stdin).toLowerCase() : null;

    if (!cmd.length && !shellLine) throw new Error('exec requires a command');

    let stdinPayload = null;
    if (stdinMode) {
      const items = [];
      for await (const item of input) items.push(item);
      stdinPayload = encodeStdin(items, stdinMode);
    } else {
      // Drain input to avoid dangling streams.
      for await (const _item of input) {
        // no-op
      }
    }

    const result = useShell
      ? await runProcess('/bin/sh', ['-lc', shellLine ?? cmd[0] ?? ''], { env: ctx.env, cwd: process.cwd(), stdin: stdinPayload })
      : await runProcess(cmd[0], cmd.slice(1), { env: ctx.env, cwd: process.cwd(), stdin: stdinPayload });

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

function runProcess(command, argv, { env, cwd, stdin }) {
  return new Promise<any>((resolve, reject) => {
    const child = spawn(command, argv, {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    if (typeof stdin === 'string') {
      child.stdin.setDefaultEncoding('utf8');
      child.stdin.write(stdin);
    }
    child.stdin.end();

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`exec failed (${code}): ${stderr.trim() || stdout.trim() || command}`));
    });
  });
}

function encodeStdin(items, mode) {
  if (mode === 'json') return JSON.stringify(items);
  if (mode === 'jsonl') {
    return items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
  }
  if (mode === 'raw') {
    return items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n');
  }
  throw new Error(`exec --stdin must be raw, json, or jsonl (got ${mode})`);
}

async function* asStream(items) {
  for (const item of items) yield item;
}
