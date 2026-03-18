import { parsePipeline } from './parser.js';
import { createDefaultRegistry } from './commands/registry.js';
import { runPipeline } from './runtime.js';
import { encodeToken } from './token.js';
import { decodeResumeToken, parseResumeArgs } from './resume.js';
import { WorkflowResumeArgumentError, runWorkflowFile } from './workflows/file.js';
import { deleteStateJson } from './state/store.js';
import {
  extractPipelineHalt,
  loadPipelineResumeState,
  PipelineResumeState,
  savePipelineResumeState,
  validatePipelineInputResponse,
} from './pipeline_resume_state.js';

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

  if (argv[0] === 'version' || argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${await readVersion()}\n`);
    return;
  }

  if (argv[0] === 'doctor') {
    await handleDoctor({ argv: argv.slice(1), registry });
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
  const { mode, rest, filePath, argsJson } = parseRunArgs(argv);
  const normalizedMode = normalizeMode(mode);

  const workflowFile = filePath
    ? await resolveWorkflowFile(filePath)
    : await detectWorkflowFile(rest);
  if (workflowFile) {
    let parsedArgs = {};
    if (argsJson) {
      try {
        parsedArgs = JSON.parse(argsJson);
      } catch {
        if (mode === 'tool') {
          writeToolEnvelope({ ok: false, error: { type: 'parse_error', message: 'run --args-json must be valid JSON' } });
          process.exitCode = 2;
          return;
        }
        process.stderr.write('run --args-json must be valid JSON\n');
        process.exitCode = 2;
        return;
      }
    }

    try {
      const output = await runWorkflowFile({
        filePath: workflowFile,
        args: parsedArgs,
        ctx: {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          env: process.env,
          mode: normalizedMode,
          registry,
        },
      });

      if (normalizedMode === 'tool') {
        if (output.status === 'needs_approval') {
          writeToolEnvelope({
            ok: true,
            status: 'needs_approval',
            output: [],
            requiresApproval: output.requiresApproval ?? null,
            requiresInput: null,
          });
          return;
        }

        if (output.status === 'needs_input') {
          writeToolEnvelope({
            ok: true,
            status: 'needs_input',
            output: [],
            requiresApproval: null,
            requiresInput: output.requiresInput ?? null,
          });
          return;
        }

        writeToolEnvelope({
          ok: true,
          status: 'ok',
          output: output.output,
          requiresApproval: null,
          requiresInput: null,
        });
        return;
      }

      if (output.status === 'ok' && output.output.length) {
        process.stdout.write(JSON.stringify(output.output, null, 2));
        process.stdout.write('\n');
      }
      return;
    } catch (err) {
      if (normalizedMode === 'tool') {
        writeToolEnvelope({ ok: false, error: { type: 'runtime_error', message: err?.message ?? String(err) } });
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`Error: ${err?.message ?? String(err)}\n`);
      process.exitCode = 1;
      return;
    }
  }

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
      input: [],
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      mode: normalizedMode,
    });

    if (normalizedMode === 'tool') {
      const { approval, inputRequest } = extractPipelineHalt(output);

      if (approval) {
        const stateKey = await savePipelineResumeState(process.env, {
          pipeline,
          resumeAtIndex: (output.haltedAt?.index ?? -1) + 1,
          items: approval.items,
          haltType: 'approval_request',
          prompt: approval.prompt,
          createdAt: new Date().toISOString(),
        });

        const resumeToken = encodeToken({
          protocolVersion: 1,
          v: 1,
          kind: 'pipeline-resume',
          stateKey,
        });

        writeToolEnvelope({
          ok: true,
          status: 'needs_approval',
          output: [],
          requiresApproval: {
            ...approval,
            resumeToken,
          },
          requiresInput: null,
        });
        return;
      }

      if (inputRequest) {
        const stateKey = await savePipelineResumeState(process.env, {
          pipeline,
          resumeAtIndex: (output.haltedAt?.index ?? -1) + 1,
          items: inputRequest.items ?? [],
          haltType: 'input_request',
          inputSchema: inputRequest.responseSchema,
          prompt: inputRequest.prompt,
          createdAt: new Date().toISOString(),
        });

        const resumeToken = encodeToken({
          protocolVersion: 1,
          v: 1,
          kind: 'pipeline-resume',
          stateKey,
        });

        writeToolEnvelope({
          ok: true,
          status: 'needs_input',
          output: [],
          requiresApproval: null,
          requiresInput: {
            type: 'input_request',
            prompt: inputRequest.prompt,
            responseSchema: inputRequest.responseSchema,
            defaults: inputRequest.defaults,
            subject: inputRequest.subject,
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
        requiresInput: null,
      });
      return;
    }

    // Human mode: if the last command didn't render, print JSON.
    if (!output.rendered) {
      process.stdout.write(JSON.stringify(output.items, null, 2));
      process.stdout.write('\n');
    }
  } catch (err) {
    if (normalizedMode === 'tool') {
      writeToolEnvelope({ ok: false, error: { type: 'runtime_error', message: err?.message ?? String(err) } });
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`Error: ${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  }
}

function parseRunArgs(argv) {
  const rest = [];
  let mode = 'human';
  let filePath = null;
  let argsJson = null;

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

    if (tok === '--file') {
      const value = argv[i + 1];
      if (value) {
        filePath = value;
        i++;
      }
      continue;
    }

    if (tok.startsWith('--file=')) {
      filePath = tok.slice('--file='.length);
      continue;
    }

    if (tok === '--args-json') {
      const value = argv[i + 1];
      if (value) {
        argsJson = value;
        i++;
      }
      continue;
    }

    if (tok.startsWith('--args-json=')) {
      argsJson = tok.slice('--args-json='.length);
      continue;
    }

    rest.push(tok);
  }

  return { mode, rest, filePath, argsJson };
}

function normalizeMode(mode) {
  return mode === 'tool' ? 'tool' : 'human';
}

async function detectWorkflowFile(rest) {
  if (rest.length !== 1) return null;
  const candidate = rest[0];
  if (!candidate || candidate.includes('|')) return null;
  try {
    return await resolveWorkflowFile(candidate);
  } catch {
    return null;
  }
}

async function resolveWorkflowFile(candidate) {
  const { promises: fsp } = await import('node:fs');
  const { resolve, extname, isAbsolute } = await import('node:path');
  const resolved = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) throw new Error('Workflow path is not a file');

  const ext = extname(resolved).toLowerCase();
  if (!['.lobster', '.yaml', '.yml', '.json'].includes(ext)) {
    throw new Error('Workflow file must end in .lobster, .yaml, .yml, or .json');
  }

  return resolved;
}

async function handleResume({ argv, registry }) {
  const mode = 'tool';
  let approved: boolean | undefined;
  let response: unknown = undefined;
  let cancel = false;
  let payload: any;
  try {
    const parsed = parseResumeArgs(argv);
    approved = parsed.approved;
    response = parsed.response;
    cancel = Boolean(parsed.cancel);
    payload = decodeResumeToken(parsed.token);
  } catch (err) {
    writeToolEnvelope({ ok: false, error: { type: 'parse_error', message: err?.message ?? String(err) } });
    process.exitCode = 2;
    return;
  }

  if (payload.kind === 'workflow-file') {
    try {
      const output = await runWorkflowFile({
        filePath: payload.filePath,
        ctx: {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          env: process.env,
          mode: 'tool',
          registry,
        },
        resume: payload,
        approved,
        response,
        cancel,
      });

      if (output.status === 'needs_approval') {
        writeToolEnvelope({
          ok: true,
          status: 'needs_approval',
          output: [],
          requiresApproval: output.requiresApproval ?? null,
          requiresInput: null,
        });
        return;
      }

      if (output.status === 'needs_input') {
        writeToolEnvelope({
          ok: true,
          status: 'needs_input',
          output: [],
          requiresApproval: null,
          requiresInput: output.requiresInput ?? null,
        });
        return;
      }

      if (output.status === 'cancelled') {
        writeToolEnvelope({
          ok: true,
          status: 'cancelled',
          output: [],
          requiresApproval: null,
          requiresInput: null,
        });
        return;
      }

      writeToolEnvelope({
        ok: true,
        status: 'ok',
        output: output.output,
        requiresApproval: null,
        requiresInput: null,
      });
      return;
    } catch (err) {
      if (err instanceof WorkflowResumeArgumentError) {
        writeToolEnvelope({ ok: false, error: { type: 'parse_error', message: err.message } });
        process.exitCode = 2;
        return;
      }
      writeToolEnvelope({ ok: false, error: { type: 'runtime_error', message: err?.message ?? String(err) } });
      process.exitCode = 1;
      return;
    }
  }

  const previousStateKey = payload.stateKey;
  let resumeState: PipelineResumeState;
  try {
    resumeState = await loadPipelineResumeState(process.env, previousStateKey);
  } catch (err) {
    writeToolEnvelope({ ok: false, error: { type: 'runtime_error', message: err?.message ?? String(err) } });
    process.exitCode = 1;
    return;
  }

  if (cancel) {
    await deleteStateJson({ env: process.env, key: previousStateKey });
    writeToolEnvelope({ ok: true, status: 'cancelled', output: [], requiresApproval: null, requiresInput: null });
    return;
  }

  if (resumeState.haltType === 'approval_request') {
    if (response !== undefined) {
      writeToolEnvelope({
        ok: false,
        error: { type: 'parse_error', message: 'pipeline approval resumes require --approve yes|no' },
      });
      process.exitCode = 2;
      return;
    }
    if (typeof approved !== 'boolean') {
      writeToolEnvelope({
        ok: false,
        error: { type: 'parse_error', message: 'pipeline approval resumes require --approve yes|no' },
      });
      process.exitCode = 2;
      return;
    }
    if (approved === false) {
      await deleteStateJson({ env: process.env, key: previousStateKey });
      writeToolEnvelope({ ok: true, status: 'cancelled', output: [], requiresApproval: null, requiresInput: null });
      return;
    }
  }

  if (resumeState.haltType === 'input_request') {
    if (approved !== undefined) {
      writeToolEnvelope({
        ok: false,
        error: { type: 'parse_error', message: 'pipeline input resumes require --response-json <json>' },
      });
      process.exitCode = 2;
      return;
    }
    if (response === undefined) {
      writeToolEnvelope({
        ok: false,
        error: { type: 'parse_error', message: 'pipeline input resumes require --response-json <json>' },
      });
      process.exitCode = 2;
      return;
    }
    try {
      validatePipelineInputResponse(resumeState.inputSchema, response);
    } catch (err) {
      writeToolEnvelope({ ok: false, error: { type: 'parse_error', message: err?.message ?? String(err) } });
      process.exitCode = 2;
      return;
    }
  }

  if (!resumeState.haltType) {
    if (response !== undefined) {
      writeToolEnvelope({
        ok: false,
        error: { type: 'parse_error', message: 'legacy pipeline resumes require --approve yes|no' },
      });
      process.exitCode = 2;
      return;
    }
    if (typeof approved !== 'boolean') {
      writeToolEnvelope({
        ok: false,
        error: { type: 'parse_error', message: 'legacy pipeline resumes require --approve yes|no' },
      });
      process.exitCode = 2;
      return;
    }
    if (approved === false) {
      await deleteStateJson({ env: process.env, key: previousStateKey });
      writeToolEnvelope({ ok: true, status: 'cancelled', output: [], requiresApproval: null, requiresInput: null });
      return;
    }
  }

  const remaining = resumeState.pipeline.slice(resumeState.resumeAtIndex);
  const inputItems = resumeState.haltType === 'input_request'
    ? [response]
    : resumeState.items;
  const input = streamFromItems(inputItems);

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

    const { approval, inputRequest } = extractPipelineHalt(output);

    if (approval) {
      const nextStateKey = await savePipelineResumeState(process.env, {
        pipeline: remaining,
        resumeAtIndex: (output.haltedAt?.index ?? -1) + 1,
        items: approval.items,
        haltType: 'approval_request',
        prompt: approval.prompt,
        createdAt: new Date().toISOString(),
      });
      await deleteStateJson({ env: process.env, key: previousStateKey });

      const resumeToken = encodeToken({
        protocolVersion: 1,
        v: 1,
        kind: 'pipeline-resume',
        stateKey: nextStateKey,
      });

      writeToolEnvelope({
        ok: true,
        status: 'needs_approval',
        output: [],
        requiresApproval: { ...approval, resumeToken },
        requiresInput: null,
      });
      return;
    }

    if (inputRequest) {
      const nextStateKey = await savePipelineResumeState(process.env, {
        pipeline: remaining,
        resumeAtIndex: (output.haltedAt?.index ?? -1) + 1,
        items: inputRequest.items ?? [],
        haltType: 'input_request',
        inputSchema: inputRequest.responseSchema,
        prompt: inputRequest.prompt,
        createdAt: new Date().toISOString(),
      });
      await deleteStateJson({ env: process.env, key: previousStateKey });

      const resumeToken = encodeToken({
        protocolVersion: 1,
        v: 1,
        kind: 'pipeline-resume',
        stateKey: nextStateKey,
      });

      writeToolEnvelope({
        ok: true,
        status: 'needs_input',
        output: [],
        requiresApproval: null,
        requiresInput: {
          type: 'input_request',
          prompt: inputRequest.prompt,
          responseSchema: inputRequest.responseSchema,
          defaults: inputRequest.defaults,
          subject: inputRequest.subject,
          resumeToken,
        },
      });
      return;
    }

    await deleteStateJson({ env: process.env, key: previousStateKey });
    writeToolEnvelope({
      ok: true,
      status: 'ok',
      output: output.items,
      requiresApproval: null,
      requiresInput: null,
    });
  } catch (err) {
    writeToolEnvelope({ ok: false, error: { type: 'runtime_error', message: err?.message ?? String(err) } });
    process.exitCode = 1;
  }
}

function streamFromItems(items: unknown[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

async function readVersion() {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '..', '..', 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  return pkg.version ?? '0.0.0';
}

async function handleDoctor({ argv, registry }) {
  const mode = 'tool';
  const pipeline = "exec --json --shell 'echo [1]'";
  const output: any = await (async () => {
    try {
      const parsed = parsePipeline(pipeline);
      return await runPipeline({
        pipeline: parsed,
        registry,
        input: [],
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
        mode,
      });
    } catch (err: any) {
      return { error: err };
    }
  })();

  if (output?.error) {
    writeToolEnvelope({
      ok: false,
      error: { type: 'doctor_error', message: output.error?.message ?? String(output.error) },
    });
    process.exitCode = 1;
    return;
  }

  writeToolEnvelope({
    ok: true,
    status: 'ok',
    output: [{
      toolMode: true,
      protocolVersion: 1,
      version: await readVersion(),
      notes: argv.length ? argv : undefined,
    }],
    requiresApproval: null,
    requiresInput: null,
  });
}

function writeToolEnvelope(payload) {
  const envelope = {
    protocolVersion: 1,
    ...payload,
  };
  process.stdout.write(JSON.stringify(envelope, null, 2));
  process.stdout.write('\n');
}

function helpText() {
  return `lobster — OpenClaw-native typed shell\n\n` +
    `Usage:\n` +
    `  lobster '<pipeline>'\n` +
    `  lobster run --mode tool '<pipeline>'\n` +
    `  lobster run path/to/workflow.lobster\n` +
    `  lobster run --file path/to/workflow.lobster --args-json '{...}'\n` +
    `  lobster resume --token <token> --approve yes|no\n` +
    `  lobster resume --token <token> --response-json '{...}'\n` +
    `  lobster resume --token <token> --cancel\n` +
    `  lobster doctor\n` +
    `  lobster version\n` +
    `  lobster help <command>\n\n` +
    `Modes:\n` +
    `  - human (default): renderers can write to stdout\n` +
    `  - tool: prints a single JSON envelope for easy integration\n\n` +
    `Examples:\n` +
    `  lobster 'exec --json "echo [1,2,3]" | json'\n` +
    `  lobster run --mode tool 'exec --json "echo [1]" | approve --prompt "ok?"'\n\n` +
    `Commands:\n` +
    `  exec, head, json, pick, table, where, approve, ask, openclaw.invoke, llm.invoke, llm_task.invoke, state.get, state.set, diff.last, commands.list, workflows.list, workflows.run\n`;
}
