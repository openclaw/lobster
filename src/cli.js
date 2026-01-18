import { parsePipeline } from './parser.js';
import { createDefaultRegistry } from './commands/registry.js';
import { runPipeline } from './runtime.js';
import { encodeToken } from './token.js';
import { decodeResumeToken, parseResumeArgs } from './resume.js';

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

  if (argv[0] === 'run') {
    await handleRun({ argv: argv.slice(1), registry });
    return;
  }

  if (argv[0] === 'resume') {
    await handleResume({ argv: argv.slice(1), registry });
    return;
  }

  // Default: treat argv as a pipeline string.
  await handleRun({ argv, registry });
}

async function handleRun({ argv, registry }) {
  const { mode, rest } = parseModeAndStrip(argv);
  const pipelineString = rest.join(' ');

  let pipeline;
  try {
    pipeline = parsePipeline(pipelineString);
  } catch (err) {
    if (mode === 'tool') {
      writeToolEnvelope({ ok: false, error: { type: 'parse_error', message: err?.message ?? String(err) } });
      process.exitCode = 2;
      return;
    }
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
      mode,
    });

    if (mode === 'tool') {
      const approval = output.halted && output.items.length === 1 && output.items[0]?.type === 'approval_request'
        ? output.items[0]
        : null;

      if (approval) {
        const resumeToken = encodeToken({
          v: 1,
          pipeline,
          resumeAtIndex: (output.haltedAt?.index ?? -1) + 1,
          items: approval.items,
          prompt: approval.prompt,
        });

        writeToolEnvelope({
          ok: true,
          status: 'needs_approval',
          output: [],
          requiresApproval: {
            ...approval,
            resumeToken,
          },
        });
        return;
      }

      writeToolEnvelope({
        ok: true,
        status: 'ok',
        output: output.items,
        requiresApproval: null,
      });
      return;
    }

    // Human mode: if the last command didn't render, print JSON.
    if (!output.rendered) {
      process.stdout.write(JSON.stringify(output.items, null, 2));
      process.stdout.write('\n');
    }
  } catch (err) {
    if (mode === 'tool') {
      writeToolEnvelope({ ok: false, error: { type: 'runtime_error', message: err?.message ?? String(err) } });
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`Error: ${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  }
}

function parseModeAndStrip(argv) {
  const rest = [];
  let mode = 'human';

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];

    if (tok === '--mode') {
      const value = argv[i + 1];
      if (value) {
        mode = value;
        i++;
      }
      continue;
    }

    if (tok.startsWith('--mode=')) {
      mode = tok.slice('--mode='.length) || 'human';
      continue;
    }

    rest.push(tok);
  }

  return { mode, rest };
}

async function handleResume({ argv, registry }) {
  const mode = 'tool';
  const { token, approved } = parseResumeArgs(argv);
  const payload = decodeResumeToken(token);

  if (!approved) {
    writeToolEnvelope({ ok: true, status: 'cancelled', output: [], requiresApproval: null });
    return;
  }

  const remaining = payload.pipeline.slice(payload.resumeAtIndex);
  const input = (async function* () {
    for (const item of payload.items) yield item;
  })();

  try {
    const output = await runPipeline({
      pipeline: remaining,
      registry,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      mode,
      input,
    });

    const approval = output.halted && output.items.length === 1 && output.items[0]?.type === 'approval_request'
      ? output.items[0]
      : null;

    if (approval) {
      const resumeToken = encodeToken({
        v: 1,
        pipeline: remaining,
        resumeAtIndex: (output.haltedAt?.index ?? -1) + 1,
        items: approval.items,
        prompt: approval.prompt,
      });

      writeToolEnvelope({
        ok: true,
        status: 'needs_approval',
        output: [],
        requiresApproval: { ...approval, resumeToken },
      });
      return;
    }

    writeToolEnvelope({ ok: true, status: 'ok', output: output.items, requiresApproval: null });
  } catch (err) {
    writeToolEnvelope({ ok: false, error: { type: 'runtime_error', message: err?.message ?? String(err) } });
    process.exitCode = 1;
  }
}

function writeToolEnvelope(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2));
  process.stdout.write('\n');
}

function helpText() {
  return `lobster (v0.1) — Clawdbot-native typed shell\n\n` +
    `Usage:\n` +
    `  lobster '<pipeline>'\n` +
    `  lobster run --mode tool '<pipeline>'\n` +
    `  lobster help <command>\n\n` +
    `Modes:\n` +
    `  - human (default): renderers can write to stdout\n` +
    `  - tool: prints a single JSON envelope for easy integration\n\n` +
    `Pipeline basics:\n` +
    `  - Commands are piped with |\n` +
    `  - Data is JSON-first (arrays/objects), not text-first\n` +
    `  - Most commands accept --flag value or --flag=value\n\n` +
    `Examples:\n` +
    `  lobster 'exec --json "echo [1,2,3]" | json'\n` +
    `  lobster 'gog.gmail.search --query "newer_than:7d" --max 10 | pick id,subject,from | table'\n` +
    `  lobster run --mode tool 'exec --json "echo [1]" | approve --prompt "ok?"'\n` +
    `  lobster resume --token <token> --approve yes\n` +
    `\nCommands:\n` +
    `  exec, head, json, pick, table, where, approve, gog.gmail.search, gog.gmail.send, email.triage, clawd.invoke\n`;
}
