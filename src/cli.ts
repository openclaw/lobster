import { parsePipeline } from "./parser.js";
import { createDefaultRegistry } from "./commands/registry.js";
import { runPipeline } from "./runtime.js";
import { decodeResumeToken, parseResumeArgs, resolveApprovalId } from "./resume.js";
import { cleanupApprovalIndexByStateKey, deleteApprovalId } from "./state/store.js";
import {
  WorkflowResumeArgumentError,
  loadWorkflowFile,
  resolveWorkflowArgs,
  runWorkflowFile,
} from "./workflows/file.js";
import { renderWorkflowGraph } from "./workflows/graph.js";
import type { WorkflowGraphFormat } from "./workflows/graph.js";
import { deleteStateJson } from "./state/store.js";
import {
  finalizePipelineToolRun,
  loadPipelineResumeState,
  validatePipelineInputResponse,
} from "./pipeline_resume_state.js";

export async function runCli(argv) {
  const registry = createDefaultRegistry();

  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(helpText());
    return;
  }

  if (argv[0] === "help") {
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

  if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${await readVersion()}\n`);
    return;
  }

  if (argv[0] === "doctor") {
    await handleDoctor({ argv: argv.slice(1), registry });
    return;
  }

  if (argv[0] === "graph") {
    await handleGraph({ argv: argv.slice(1) });
    return;
  }

  if (argv[0] === "run") {
    await handleRun({ argv: argv.slice(1), registry });
    return;
  }

  if (argv[0] === "resume") {
    await handleResume({ argv: argv.slice(1), registry });
    return;
  }

  // Default: treat argv as a pipeline string.
  await handleRun({ argv, registry });
}

async function handleGraph({ argv }) {
  const parsed = parseGraphArgs(argv);
  if (parsed.help) {
    process.stdout.write(graphHelpText());
    return;
  }

  if (!parsed.filePath) {
    process.stderr.write("graph requires a workflow file path (use --file <path>)\n");
    process.exitCode = 2;
    return;
  }

  if (!isWorkflowGraphFormat(parsed.format)) {
    process.stderr.write("graph --format must be one of: mermaid, dot, ascii\n");
    process.exitCode = 2;
    return;
  }

  let argsJson: Record<string, unknown> = {};
  if (parsed.argsJson) {
    try {
      const value = JSON.parse(parsed.argsJson);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        process.stderr.write("graph --args-json must be a JSON object\n");
        process.exitCode = 2;
        return;
      }
      argsJson = value as Record<string, unknown>;
    } catch {
      process.stderr.write("graph --args-json must be valid JSON\n");
      process.exitCode = 2;
      return;
    }
  }

  let filePath: string;
  try {
    filePath = await resolveWorkflowFile(parsed.filePath);
  } catch (err) {
    process.stderr.write(`Error: ${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const workflow = await loadWorkflowFile(filePath);
    const args = resolveWorkflowArgs(workflow.args, argsJson);
    const graph = renderWorkflowGraph({ workflow, format: parsed.format, args });
    process.stdout.write(graph);
    process.stdout.write("\n");
  } catch (err) {
    process.stderr.write(`Error: ${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  }
}

function isWorkflowGraphFormat(value: string): value is WorkflowGraphFormat {
  return value === "mermaid" || value === "dot" || value === "ascii";
}

async function handleRun({ argv, registry }) {
  const parsed = parseRunArgs(argv);
  const { mode, argsJson } = parsed;
  const normalizedMode = normalizeMode(mode);
  const { rest, filePath, dryRun } = await resolveRunTarget(parsed);

  const workflowFile = filePath
    ? await resolveWorkflowFile(filePath)
    : await detectWorkflowFile(rest);
  if (workflowFile) {
    let parsedArgs = {};
    if (argsJson) {
      try {
        parsedArgs = JSON.parse(argsJson);
      } catch {
        if (mode === "tool") {
          writeToolEnvelope({
            ok: false,
            error: { type: "parse_error", message: "run --args-json must be valid JSON" },
          });
          process.exitCode = 2;
          return;
        }
        process.stderr.write("run --args-json must be valid JSON\n");
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
          dryRun,
        },
      });

      if (normalizedMode === "tool") {
        if (output.status === "needs_approval") {
          writeToolEnvelope({
            ok: true,
            status: "needs_approval",
            output: [],
            requiresApproval: output.requiresApproval ?? null,
            requiresInput: null,
          });
          return;
        }

        if (output.status === "needs_input") {
          writeToolEnvelope({
            ok: true,
            status: "needs_input",
            output: [],
            requiresApproval: null,
            requiresInput: output.requiresInput ?? null,
          });
          return;
        }

        writeToolEnvelope({
          ok: true,
          status: "ok",
          output: output.output,
          requiresApproval: null,
          requiresInput: null,
        });
        return;
      }

      if (output.status === "needs_approval" || output.status === "needs_input") {
        process.stdout.write(
          JSON.stringify(
            {
              status: output.status,
              output: [],
              requiresApproval: output.requiresApproval ?? null,
              requiresInput: output.requiresInput ?? null,
            },
            null,
            2,
          ),
        );
        process.stdout.write("\n");
        return;
      }

      if (output.status === "ok" && output.output.length) {
        process.stdout.write(JSON.stringify(output.output, null, 2));
        process.stdout.write("\n");
      }
      return;
    } catch (err) {
      if (normalizedMode === "tool") {
        writeToolEnvelope({
          ok: false,
          error: { type: "runtime_error", message: err?.message ?? String(err) },
        });
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`Error: ${err?.message ?? String(err)}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const pipelineString = rest.join(" ");

  let pipeline;
  try {
    pipeline = parsePipeline(pipelineString);
  } catch (err) {
    if (mode === "tool") {
      writeToolEnvelope({
        ok: false,
        error: { type: "parse_error", message: err?.message ?? String(err) },
      });
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
      dryRun,
    });

    if (normalizedMode === "tool") {
      const finalized = await finalizePipelineToolRun({
        env: process.env,
        pipeline,
        output,
      });
      writeToolEnvelope({
        ok: true,
        status: finalized.status,
        output: finalized.output,
        requiresApproval: finalized.requiresApproval,
        requiresInput: finalized.requiresInput,
      });
      return;
    }

    // Human mode: if the last command didn't render, print JSON.
    if (!output.rendered) {
      process.stdout.write(JSON.stringify(output.items, null, 2));
      process.stdout.write("\n");
    }
  } catch (err) {
    if (normalizedMode === "tool") {
      writeToolEnvelope({
        ok: false,
        error: { type: "runtime_error", message: err?.message ?? String(err) },
      });
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`Error: ${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  }
}

function parseRunArgs(argv) {
  const rest = [];
  let mode = "human";
  let filePath = null;
  let argsJson = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];

    // Treat --dry-run as a Lobster flag only before positional command/pipeline
    // args begin. Once rest has started, the token may belong to the command.
    // Trailing workflow-file --dry-run is handled later after we can prove the
    // first positional token is actually a workflow file.
    if (tok === "--dry-run" && rest.length === 0) {
      dryRun = true;
      continue;
    }

    if (tok === "--mode") {
      const value = argv[i + 1];
      if (value) {
        mode = value;
        i++;
      }
      continue;
    }

    if (tok.startsWith("--mode=")) {
      mode = tok.slice("--mode=".length) || "human";
      continue;
    }

    if (tok === "--file") {
      const value = argv[i + 1];
      if (value) {
        filePath = value;
        i++;
      }
      continue;
    }

    if (tok.startsWith("--file=")) {
      filePath = tok.slice("--file=".length);
      continue;
    }

    if (tok === "--args-json") {
      const value = argv[i + 1];
      if (value) {
        argsJson = value;
        i++;
      }
      continue;
    }

    if (tok.startsWith("--args-json=")) {
      argsJson = tok.slice("--args-json=".length);
      continue;
    }

    rest.push(tok);
  }

  return { mode, rest, filePath, argsJson, dryRun };
}

function parseGraphArgs(argv: string[]) {
  const rest: string[] = [];
  let filePath: string | null = null;
  let format = "mermaid";
  let argsJson: string | null = null;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];

    if (tok === "-h" || tok === "--help") {
      help = true;
      continue;
    }

    if (tok === "--file") {
      const value = argv[i + 1];
      if (value) {
        filePath = value;
        i++;
      }
      continue;
    }

    if (tok.startsWith("--file=")) {
      filePath = tok.slice("--file=".length);
      continue;
    }

    if (tok === "--format") {
      const value = argv[i + 1];
      if (value) {
        format = value;
        i++;
      }
      continue;
    }

    if (tok.startsWith("--format=")) {
      format = tok.slice("--format=".length) || "mermaid";
      continue;
    }

    if (tok === "--args-json") {
      const value = argv[i + 1];
      if (value) {
        argsJson = value;
        i++;
      }
      continue;
    }

    if (tok.startsWith("--args-json=")) {
      argsJson = tok.slice("--args-json=".length);
      continue;
    }

    rest.push(tok);
  }

  if (!filePath && rest.length > 0) {
    filePath = rest[0];
  }
  return { filePath, format, argsJson, help };
}

async function resolveRunTarget(parsed: {
  rest: string[];
  filePath: string | null;
  dryRun: boolean;
}) {
  if (parsed.filePath) return parsed;
  const restWithoutDryRun = parsed.rest.filter((token) => token !== "--dry-run");
  if (restWithoutDryRun.length === 1 && restWithoutDryRun.length !== parsed.rest.length) {
    try {
      const workflowFile = await resolveWorkflowFile(restWithoutDryRun[0]);
      return { ...parsed, filePath: workflowFile, rest: [], dryRun: true };
    } catch {
      return parsed;
    }
  }
  return parsed;
}

function normalizeMode(mode) {
  return mode === "tool" ? "tool" : "human";
}

async function detectWorkflowFile(rest) {
  if (rest.length !== 1) return null;
  const candidate = rest[0];
  if (!candidate || candidate.includes("|")) return null;
  try {
    return await resolveWorkflowFile(candidate);
  } catch {
    return null;
  }
}

async function resolveWorkflowFile(candidate) {
  const { promises: fsp } = await import("node:fs");
  const { resolve, extname, isAbsolute } = await import("node:path");
  const resolved = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) throw new Error("Workflow path is not a file");

  const ext = extname(resolved).toLowerCase();
  if (![".lobster", ".yaml", ".yml", ".json"].includes(ext)) {
    throw new Error("Workflow file must end in .lobster, .yaml, .yml, or .json");
  }

  return resolved;
}

async function handleResume({ argv, registry }) {
  const mode = "tool";
  let approved: boolean | undefined;
  let response: unknown = undefined;
  let cancel = false;
  let payload: any;
  let resolvedApprovalId: string | null = null;
  try {
    const parsed = parseResumeArgs(argv);
    approved = parsed.approved;
    response = parsed.response;
    cancel = parsed.cancel === true;
    resolvedApprovalId = parsed.approvalId;

    // Resolve short approval ID to token if provided
    let token: string;
    if (parsed.approvalId) {
      token = await resolveApprovalId(parsed.approvalId, process.env);
    } else {
      token = parsed.token!;
    }
    payload = decodeResumeToken(token);
  } catch (err) {
    writeToolEnvelope({
      ok: false,
      error: { type: "parse_error", message: err?.message ?? String(err) },
    });
    process.exitCode = 2;
    return;
  }

  // Helper: clean up approval ID index after successful use
  const cleanupIndex = async () => {
    if (resolvedApprovalId) {
      await deleteApprovalId({ env: process.env, approvalId: resolvedApprovalId });
    } else if (payload.stateKey) {
      await cleanupApprovalIndexByStateKey({ env: process.env, stateKey: payload.stateKey });
    }
  };

  if (cancel === true) {
    await cleanupIndex();
    if (payload.kind === "workflow-file" && payload.stateKey) {
      await deleteStateJson({ env: process.env, key: payload.stateKey });
    }
    if (payload.kind === "pipeline-resume" && payload.stateKey) {
      await deleteStateJson({ env: process.env, key: payload.stateKey });
    }
    writeToolEnvelope({
      ok: true,
      status: "cancelled",
      output: [],
      requiresApproval: null,
      requiresInput: null,
    });
    return;
  }

  if (payload.kind === "workflow-file") {
    try {
      const output = await runWorkflowFile({
        filePath: payload.filePath,
        ctx: {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          env: process.env,
          mode: "tool",
          registry,
        },
        resume: payload,
        approved,
        response,
        cancel,
      });

      if (output.status === "needs_approval") {
        writeToolEnvelope({
          ok: true,
          status: "needs_approval",
          output: [],
          requiresApproval: output.requiresApproval ?? null,
          requiresInput: null,
        });
        return;
      }

      if (output.status === "needs_input") {
        writeToolEnvelope({
          ok: true,
          status: "needs_input",
          output: [],
          requiresApproval: null,
          requiresInput: output.requiresInput ?? null,
        });
        return;
      }

      await cleanupIndex();
      if (output.status === "cancelled") {
        writeToolEnvelope({
          ok: true,
          status: "cancelled",
          output: [],
          requiresApproval: null,
          requiresInput: null,
        });
        return;
      }
      writeToolEnvelope({
        ok: true,
        status: "ok",
        output: output.output,
        requiresApproval: null,
        requiresInput: null,
      });
      return;
    } catch (err) {
      if (err instanceof WorkflowResumeArgumentError) {
        writeToolEnvelope({ ok: false, error: { type: "parse_error", message: err.message } });
        process.exitCode = 2;
        return;
      }
      // Don't clean up index on error — allow retry by --id
      writeToolEnvelope({
        ok: false,
        error: { type: "runtime_error", message: err?.message ?? String(err) },
      });
      process.exitCode = 1;
      return;
    }
  }
  const previousStateKey = payload.stateKey;
  let resumeState;
  try {
    resumeState = await loadPipelineResumeState(process.env, previousStateKey);
  } catch (err) {
    writeToolEnvelope({
      ok: false,
      error: { type: "runtime_error", message: err?.message ?? String(err) },
    });
    process.exitCode = 1;
    return;
  }
  if (resumeState.haltType === "input_request") {
    if (approved !== undefined) {
      writeToolEnvelope({
        ok: false,
        error: {
          type: "parse_error",
          message: "pipeline input resumes require --response-json <json>",
        },
      });
      process.exitCode = 2;
      return;
    }
    if (response === undefined) {
      writeToolEnvelope({
        ok: false,
        error: {
          type: "parse_error",
          message: "pipeline input resumes require --response-json <json>",
        },
      });
      process.exitCode = 2;
      return;
    }
    try {
      validatePipelineInputResponse(resumeState.inputSchema, response);
    } catch (err) {
      writeToolEnvelope({
        ok: false,
        error: { type: "parse_error", message: err?.message ?? String(err) },
      });
      process.exitCode = 2;
      return;
    }
  } else {
    if (response !== undefined) {
      writeToolEnvelope({
        ok: false,
        error: {
          type: "parse_error",
          message: "approval resumes require --approve yes|no, not --response-json",
        },
      });
      process.exitCode = 2;
      return;
    }
    if (approved !== true) {
      await cleanupIndex();
      await deleteStateJson({ env: process.env, key: previousStateKey });
      writeToolEnvelope({
        ok: true,
        status: "cancelled",
        output: [],
        requiresApproval: null,
        requiresInput: null,
      });
      return;
    }
  }

  const remaining = resumeState.pipeline.slice(resumeState.resumeAtIndex);
  const input = streamFromItems(
    resumeState.haltType === "input_request" ? [response] : resumeState.items,
  );

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
    await cleanupIndex();
    const finalized = await finalizePipelineToolRun({
      env: process.env,
      pipeline: remaining,
      output,
      previousStateKey,
    });
    writeToolEnvelope({
      ok: true,
      status: finalized.status,
      output: finalized.output,
      requiresApproval: finalized.requiresApproval,
      requiresInput: finalized.requiresInput,
    });
  } catch (err) {
    // Don't clean up index on error — allow retry by --id
    writeToolEnvelope({
      ok: false,
      error: { type: "runtime_error", message: err?.message ?? String(err) },
    });
    process.exitCode = 1;
  }
}

function streamFromItems(items: unknown[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

async function readVersion() {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");

  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "..", "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  return pkg.version ?? "0.0.0";
}

async function handleDoctor({ argv, registry }) {
  const mode = "tool";
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
      error: { type: "doctor_error", message: output.error?.message ?? String(output.error) },
    });
    process.exitCode = 1;
    return;
  }

  writeToolEnvelope({
    ok: true,
    status: "ok",
    output: [
      {
        toolMode: true,
        protocolVersion: 1,
        version: await readVersion(),
        notes: argv.length ? argv : undefined,
      },
    ],
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
  process.stdout.write("\n");
}

function helpText() {
  return (
    `lobster — OpenClaw-native typed shell\n\n` +
    `Usage:\n` +
    `  lobster '<pipeline>'\n` +
    `  lobster run --mode tool '<pipeline>'\n` +
    `  lobster run path/to/workflow.lobster\n` +
    `  lobster run --file path/to/workflow.lobster --args-json '{...}'\n` +
    `  lobster run --dry-run --file path/to/workflow.lobster\n` +
    `  lobster run --dry-run '<pipeline>'\n` +
    `  lobster graph --file path/to/workflow.lobster --format mermaid\n` +
    `  lobster graph --file path/to/workflow.lobster --format dot\n` +
    `  lobster graph --file path/to/workflow.lobster --format ascii\n` +
    `  lobster resume --token <token> --approve yes|no\n` +
    `  lobster resume --token <token> --response-json '{...}'\n` +
    `  lobster resume --token <token> --cancel\n` +
    `  lobster doctor\n` +
    `  lobster version\n` +
    `  lobster help <command>\n\n` +
    `Flags:\n` +
    `  --dry-run  Validate and print the execution plan without running anything\n\n` +
    `Modes:\n` +
    `  - human (default): renderers can write to stdout\n` +
    `  - tool: prints a single JSON envelope for easy integration\n\n` +
    `Examples:\n` +
    `  lobster 'exec --json "echo [1,2,3]" | json'\n` +
    `  lobster run --mode tool 'exec --json "echo [1]" | approve --prompt "ok?"'\n\n` +
    `Commands:\n` +
    `  exec, head, json, pick, table, where, approve, ask, openclaw.invoke, llm.invoke, llm_task.invoke, state.get, state.set, diff.last, commands.list, workflows.list, workflows.run, graph\n`
  );
}

function graphHelpText() {
  return (
    `lobster graph — render workflow step graphs\n\n` +
    `Usage:\n` +
    `  lobster graph --file path/to/workflow.lobster [--format mermaid|dot|ascii] [--args-json '{...}']\n` +
    `  lobster graph path/to/workflow.lobster [--format mermaid|dot|ascii]\n\n` +
    `Flags:\n` +
    `  --file       Workflow file path (.lobster, .yaml, .yml, .json)\n` +
    `  --format     Output format: mermaid (default), dot, ascii\n` +
    `  --args-json  JSON object used to resolve workflow args for labels\n`
  );
}
