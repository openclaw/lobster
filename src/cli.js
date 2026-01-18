import { parsePipeline } from './parser.js';
import { createDefaultRegistry } from './commands/registry.js';
import { runPipeline } from './runtime.js';

export async function runCli(argv) {
  const registry = createDefaultRegistry();

  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(helpText());
    return;
  }

  if (argv[0] === 'help') {
    const topic = argv[1];
    if (!topic) {
      process.stdout.write(helpText());
      return;
    }
    const cmd = registry.get(topic);
    if (!cmd) {
      process.stderr.write(`Unknown command: ${topic}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(cmd.help());
    return;
  }

  const inputLine = argv.join(' ');
  let pipeline;
  try {
    pipeline = parsePipeline(inputLine);
  } catch (err) {
    process.stderr.write(`Parse error: ${err?.message ?? String(err)}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const output = await runPipeline({
      pipeline,
      registry,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
    });

    // Default rendering: if the last command didn't render, print JSON.
    if (!output.rendered) {
      process.stdout.write(JSON.stringify(output.items, null, 2));
      process.stdout.write('\n');
    }
  } catch (err) {
    process.stderr.write(`Error: ${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  }
}

function helpText() {
  return `lobster (v0.1) — Clawdbot-native typed shell\n\n` +
    `Usage:\n` +
    `  lobster '<pipeline>'\n` +
    `  lobster help <command>\n\n` +
    `Pipeline basics:\n` +
    `  - Commands are piped with |\n` +
    `  - Data is JSON-first (arrays/objects), not text-first\n` +
    `  - Most commands accept --flag value or --flag=value\n\n` +
    `Examples:\n` +
    `  lobster 'exec --json "echo [1,2,3]" | json'\n` +
    `  lobster 'gog.gmail.search --query "newer_than:7d" --max 10 | pick id,subject,from | table'\n` +
    `\nCommands:\n` +
    `  exec, head, json, pick, table, where, approve, gog.gmail.search, gog.gmail.send, email.triage\n`;
}
