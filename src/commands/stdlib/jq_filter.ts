import { spawn } from 'node:child_process';

export const jqFilterCommand = {
  name: 'jq-filter',
  meta: {
    description: 'Apply a jq expression to each pipeline item',
    argsSchema: {
      type: 'object',
      properties: {
        _: { type: 'array', items: { type: 'string' }, description: 'jq expression' },
        expr: { type: 'string', description: 'jq expression (alternative to positional)' },
      },
      required: ['_'],
    },
    sideEffects: ['local_exec'],
  },
  help() {
    return `jq-filter — apply a jq expression to each pipeline item\n\n` +
      `Usage:\n` +
      `  <items> | jq-filter <expr>\n` +
      `  <items> | jq-filter --expr <expr>\n\n` +
      `Notes:\n` +
      `  - Each input item is serialized as JSON and piped to jq -c <expr>.\n` +
      `  - Each non-empty stdout line is parsed as JSON and yielded.\n` +
      `  - Requires jq on PATH.\n`;
  },
  async run({ input, args }) {
    const expr = args._[0] || args.expr;
    if (!expr) throw new Error('jq-filter requires an expression');

    const results = [];
    for await (const item of input) {
      const itemJson = JSON.stringify(item);
      const output = await runJq(expr, itemJson);
      const lines = output.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        results.push(JSON.parse(line));
      }
    }

    return { output: asStream(results) };
  },
};

function runJq(expr, stdin) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('jq', ['-c', expr], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.stdin.setDefaultEncoding('utf8');
    child.stdin.write(stdin);
    child.stdin.end();

    child.on('error', (err) => {
      reject(new Error(`jq-filter: failed to spawn jq: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout);
      reject(new Error(`jq-filter failed (exit ${code}): ${stderr.trim() || 'unknown error'}`));
    });
  });
}

async function* asStream(items) {
  for (const item of items) yield item;
}
