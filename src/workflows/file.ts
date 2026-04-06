import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { parsePipeline } from '../parser.js';
import { runPipeline } from '../runtime.js';
import { encodeToken } from '../token.js';
import { deleteStateJson, readStateJson, writeStateJson } from '../state/store.js';
import { readLineFromStream } from '../read_line.js';
import { resolveInlineShellCommand } from '../shell.js';

export type WorkflowFile = {
  name?: string;
  description?: string;
  args?: Record<string, { default?: unknown; description?: string }>;
  env?: Record<string, string>;
  cwd?: string;
  steps: WorkflowStep[];
};

export type WorkflowStep = {
  id: string;
  command?: string;
  run?: string;
  pipeline?: string;
  env?: Record<string, string>;
  cwd?: string;
  stdin?: unknown;
  approval?: WorkflowApproval;
  condition?: unknown;
  when?: unknown;
};

export type WorkflowApproval =
  | boolean
  | 'required'
  | string
  | {
    prompt?: string;
    items?: unknown[];
    preview?: string;
  };

export type WorkflowStepResult = {
  id: string;
  stdout?: string;
  json?: unknown;
  approved?: boolean;
  skipped?: boolean;
};

export type WorkflowRunResult = {
  status: 'ok' | 'needs_approval' | 'cancelled';
  output: unknown[];
  requiresApproval?: {
    type: 'approval_request';
    prompt: string;
    items: unknown[];
    preview?: string;
    resumeToken?: string;
  };
};

type RunContext = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: Record<string, string | undefined>;
  mode: 'human' | 'tool' | 'sdk';
  cwd?: string;
  signal?: AbortSignal;
  registry?: {
    get: (name: string) => any;
  };
  llmAdapters?: Record<string, any>;
  dryRun?: boolean;
};

export type WorkflowResumePayload = {
  protocolVersion: 1;
  v: 1;
  kind: 'workflow-file';
  stateKey?: string;
  filePath?: string;
  resumeAtIndex?: number;
  steps?: Record<string, WorkflowStepResult>;
  args?: Record<string, unknown>;
  approvalStepId?: string;
};

type WorkflowResumeState = {
  filePath: string;
  resumeAtIndex: number;
  steps: Record<string, WorkflowStepResult>;
  args: Record<string, unknown>;
  approvalStepId?: string;
  createdAt: string;
};

export async function loadWorkflowFile(filePath: string): Promise<WorkflowFile> {
  const text = await fsp.readFile(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  const parsed = ext === '.json' ? JSON.parse(text) : parseYaml(text);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Workflow file must be a JSON/YAML object');
  }

  const steps = (parsed as WorkflowFile).steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('Workflow file requires a non-empty steps array');
  }

  const seen = new Set<string>();
  for (const step of steps) {
    if (!step || typeof step !== 'object') {
      throw new Error('Workflow step must be an object');
    }
    if (!step.id || typeof step.id !== 'string') {
      throw new Error('Workflow step requires an id');
    }
    const shellCommand = typeof step.run === 'string' ? step.run : step.command;
    const pipeline = typeof step.pipeline === 'string' ? step.pipeline : undefined;
    const executionCount = Number(Boolean(shellCommand)) + Number(Boolean(pipeline));
    if (executionCount === 0 && !isApprovalStep(step.approval)) {
      throw new Error(`Workflow step ${step.id} requires run, command, pipeline, or approval`);
    }
    if (executionCount > 1) {
      throw new Error(`Workflow step ${step.id} can only define one of run, command, or pipeline`);
    }
    if (step.run !== undefined && typeof step.run !== 'string') {
      throw new Error(`Workflow step ${step.id} run must be a string`);
    }
    if (step.command !== undefined && typeof step.command !== 'string') {
      throw new Error(`Workflow step ${step.id} command must be a string`);
    }
    if (step.pipeline !== undefined && typeof step.pipeline !== 'string') {
      throw new Error(`Workflow step ${step.id} pipeline must be a string`);
    }
    if (seen.has(step.id)) {
      throw new Error(`Duplicate workflow step id: ${step.id}`);
    }
    seen.add(step.id);
  }

  return parsed as WorkflowFile;
}

export function resolveWorkflowArgs(
  argDefs: WorkflowFile['args'],
  provided: Record<string, unknown> | undefined,
) {
  const resolved: Record<string, unknown> = {};
  if (argDefs) {
    for (const [key, def] of Object.entries(argDefs)) {
      if (def && typeof def === 'object' && 'default' in def) {
        resolved[key] = def.default;
      }
    }
  }
  if (provided) {
    for (const [key, value] of Object.entries(provided)) {
      resolved[key] = value;
    }
  }
  return resolved;
}

export async function runWorkflowFile({
  filePath,
  args,
  ctx,
  resume,
  approved,
}: {
  filePath?: string;
  args?: Record<string, unknown>;
  ctx: RunContext;
  resume?: WorkflowResumePayload;
  approved?: boolean;
}): Promise<WorkflowRunResult> {
  const consumedResumeStateKey = resume?.stateKey && typeof resume.stateKey === 'string'
    ? resume.stateKey
    : null;
  const resumeState = resume?.stateKey
    ? await loadWorkflowResumeState(ctx.env, resume.stateKey)
    : resume ?? null;
  const resolvedFilePath = filePath ?? resumeState?.filePath;
  if (!resolvedFilePath) {
    throw new Error('Workflow file path required');
  }
  const workflow = await loadWorkflowFile(resolvedFilePath);
  const resolvedArgs = resolveWorkflowArgs(workflow.args, args ?? resumeState?.args);
  const steps = workflow.steps;
  const results: Record<string, WorkflowStepResult> = resumeState?.steps
    ? cloneResults(resumeState.steps)
    : {};
  const startIndex = resumeState?.resumeAtIndex ?? 0;

  if (resumeState?.approvalStepId && approved === false) {
    if (consumedResumeStateKey) {
      await deleteStateJson({ env: ctx.env, key: consumedResumeStateKey });
    }
    return { status: 'cancelled', output: [] };
  }

  if (resumeState?.approvalStepId && typeof approved === 'boolean') {
    const previous = results[resumeState.approvalStepId] ?? { id: resumeState.approvalStepId };
    previous.approved = approved;
    results[resumeState.approvalStepId] = previous;
  }

  if (ctx.dryRun) {
    return dryRunWorkflow({ steps, resolvedArgs, results, startIndex, ctx });
  }

  let lastStepId: string | null = findLastCompletedStepId(steps, results);

  for (let idx = startIndex; idx < steps.length; idx++) {
    const step = steps[idx];

    if (!evaluateCondition(step.when ?? step.condition, results)) {
      results[step.id] = { id: step.id, skipped: true };
      continue;
    }

    const env = mergeEnv(ctx.env, workflow.env, step.env, resolvedArgs, results);
    const cwd = resolveCwd(step.cwd ?? workflow.cwd, resolvedArgs) ?? ctx.cwd;
    const execution = getStepExecution(step);

    let result: WorkflowStepResult;
    if (execution.kind === 'shell') {
      const command = resolveTemplate(execution.value, resolvedArgs, results);
      const stdinValue = resolveShellStdin(step.stdin, resolvedArgs, results);
      const { stdout } = await runShellCommand({ command, stdin: stdinValue, env, cwd, signal: ctx.signal });
      result = { id: step.id, stdout, json: parseJson(stdout) };
    } else if (execution.kind === 'pipeline') {
      if (!ctx.registry) {
        throw new Error(`Workflow step ${step.id} requires a command registry for pipeline execution`);
      }
      const pipelineText = resolveTemplate(execution.value, resolvedArgs, results);
      const inputValue = resolveInputValue(step.stdin, resolvedArgs, results);
      result = await runPipelineStep({
        stepId: step.id,
        pipelineText,
        inputValue,
        ctx,
        env,
        cwd,
      });
    } else {
      const inputValue = resolveInputValue(step.stdin, resolvedArgs, results);
      result = createSyntheticStepResult(step.id, inputValue);
    }

    results[step.id] = result;
    lastStepId = step.id;

    if (isApprovalStep(step.approval)) {
      const approval = extractApprovalRequest(step, results[step.id]);

      if (ctx.mode === 'tool' || !isInteractive(ctx.stdin)) {
        const stateKey = await saveWorkflowResumeState(ctx.env, {
          filePath: resolvedFilePath,
          resumeAtIndex: idx + 1,
          steps: results,
          args: resolvedArgs,
          approvalStepId: step.id,
          createdAt: new Date().toISOString(),
        });

        if (consumedResumeStateKey && consumedResumeStateKey !== stateKey) {
          await deleteStateJson({ env: ctx.env, key: consumedResumeStateKey });
        }

        const resumeToken = encodeToken({
          protocolVersion: 1,
          v: 1,
          kind: 'workflow-file',
          stateKey,
        } satisfies WorkflowResumePayload);

        return {
          status: 'needs_approval',
          output: [],
          requiresApproval: {
            ...approval,
            resumeToken,
          },
        };
      }

      ctx.stdout.write(`${approval.prompt} [y/N] `);
      const answer = await readLineFromStream(ctx.stdin, {
        timeoutMs: parseApprovalTimeoutMs(ctx.env),
      });
      if (!/^y(es)?$/i.test(String(answer).trim())) {
        throw new Error('Not approved');
      }
      results[step.id].approved = true;
    }
  }

  const output = lastStepId ? toOutputItems(results[lastStepId]) : [];
  if (consumedResumeStateKey) {
    await deleteStateJson({ env: ctx.env, key: consumedResumeStateKey });
  }
  return { status: 'ok', output };
}

// Returns a human-readable note if a step.stdin value references a prior step's
// output. Because dry-run placeholders have no actual stdout/json, we surface
// this so users know the value is unknown at plan time rather than silently
// resolving to an empty string.
function dryRunStdinNote(stdin: unknown): string | null {
  if (stdin === null || stdin === undefined) return null;
  if (typeof stdin !== 'string') return null;
  const trimmed = stdin.trim();
  // Strict step ref: '$step-id.stdout' or '$step-id.json'
  if (/^\$[A-Za-z0-9_-]+\.(stdout|json)$/.test(trimmed)) {
    return `${trimmed}  [output unknown at plan time]`;
  }
  // Inline template ref: contains '$stepid.stdout' or '$stepid.json'
  if (/\$[A-Za-z0-9_-]+\.(stdout|json)/.test(trimmed)) {
    return `${trimmed}  [contains step output refs — unknown at plan time]`;
  }
  return null;
}

function dryRunTemplateNote(input: string): string | null {
  if (/\$[A-Za-z0-9_-]+\.(stdout|json)/.test(input)) {
    return '[contains step output refs — unknown at plan time]';
  }
  return null;
}

function resolveDryRunTemplate(
  input: string,
  args: Record<string, unknown>,
  results: Record<string, WorkflowStepResult>,
) {
  const withArgs = resolveArgsTemplate(input, args);
  return withArgs.replace(/\$([A-Za-z0-9_-]+)\.(stdout|json|approved)/g, (match, id, field) => {
    if (field === 'approved') {
      const step = results[id];
      if (!step) return match;
      return step.approved === true ? 'true' : 'false';
    }
    return match;
  });
}

function dryRunWorkflow({
  steps,
  resolvedArgs,
  results,
  startIndex,
  ctx,
}: {
  steps: WorkflowStep[];
  resolvedArgs: Record<string, unknown>;
  results: Record<string, WorkflowStepResult>;
  startIndex: number;
  ctx: RunContext;
}): WorkflowRunResult {
  const lines: string[] = [];
  const totalSteps = steps.length - startIndex;
  lines.push(`[DRY RUN] Would execute ${totalSteps} step${totalSteps !== 1 ? 's' : ''}:\n`);

  for (let idx = startIndex; idx < steps.length; idx++) {
    const step = steps[idx];
    const num = idx - startIndex + 1;

    if (!evaluateCondition(step.when ?? step.condition, results)) {
      results[step.id] = { id: step.id, skipped: true };
      lines.push(`  ${num}. ${step.id}  [skipped — condition: false]`);
      continue;
    }

    // Validate stdin refs early — throws if a strict ref like '$missing.stdout'
    // points to a step that doesn't exist at all (real execution would also fail).
    // We call resolveInputValue with the current results so refs to steps we've
    // already visited (placeholders) are accepted without throwing.
    if (step.stdin !== undefined && step.stdin !== null) {
      try {
        resolveInputValue(step.stdin, resolvedArgs, results);
      } catch (err: any) {
        throw new Error(`Workflow step ${step.id} stdin: ${err?.message ?? String(err)}`);
      }
    }

    const execution = getStepExecution(step);

    // Annotate when the resolved command/pipeline references a prior step's output.
    // Since dry-run placeholders have no actual stdout/json, note it explicitly
    // rather than silently collapsing the reference to an empty string.
    const stdinNote = dryRunStdinNote(step.stdin);

    if (execution.kind === 'shell') {
      const command = resolveDryRunTemplate(execution.value, resolvedArgs, results);
      const commandNote = dryRunTemplateNote(command);
      lines.push(`  ${num}. ${step.id}  [shell]`);
      lines.push(`     run: ${command}${commandNote ? `  ${commandNote}` : ''}`);
    } else if (execution.kind === 'pipeline') {
      const pipelineText = resolveDryRunTemplate(execution.value, resolvedArgs, results);
      const pipelineNote = dryRunTemplateNote(pipelineText);
      // Validate pipeline syntax and registry even in dry-run so errors surface early.
      if (!ctx.registry) {
        throw new Error(`Workflow step ${step.id} requires a command registry for pipeline execution`);
      }
      // Validate that every stage name is a known command.
      const stages = parsePipeline(pipelineText);
      for (const stage of stages) {
        if (!ctx.registry.get(stage.name)) {
          throw new Error(`Workflow step ${step.id} pipeline references unknown command: ${stage.name}`);
        }
      }
      lines.push(`  ${num}. ${step.id}  [pipeline]`);
      lines.push(`     pipeline: ${pipelineText}${pipelineNote ? `  ${pipelineNote}` : ''}`);
    } else {
      lines.push(`  ${num}. ${step.id}  [no-op]`);
    }

    if (stdinNote) lines.push(`     stdin: ${stdinNote}`);
    if (isApprovalStep(step.approval)) {
      lines.push(`     [approval required]`);
    }

    // Record a placeholder result so later steps can reference this step in conditions.
    // For approval steps, model approval as granted so downstream conditions like
    // $step.approved evaluate correctly in the plan (rather than always being false).
    // We intentionally omit stdout/json — dryRunStdinNote() surfaces that gap.
    results[step.id] = isApprovalStep(step.approval)
      ? { id: step.id, approved: true }
      : { id: step.id };
  }

  lines.push('');
  ctx.stderr.write(lines.join('\n'));
  return { status: 'ok', output: [] };
}

export function decodeWorkflowResumePayload(payload: unknown): WorkflowResumePayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Partial<WorkflowResumePayload>;
  if (data.kind !== 'workflow-file') return null;
  if (data.protocolVersion !== 1 || data.v !== 1) throw new Error('Unsupported token version');
  if (data.stateKey && typeof data.stateKey === 'string') {
    return data as WorkflowResumePayload;
  }
  if (!data.filePath || typeof data.filePath !== 'string') throw new Error('Invalid workflow token');
  if (typeof data.resumeAtIndex !== 'number') throw new Error('Invalid workflow token');
  if (!data.steps || typeof data.steps !== 'object') throw new Error('Invalid workflow token');
  if (!data.args || typeof data.args !== 'object') throw new Error('Invalid workflow token');
  return data as WorkflowResumePayload;
}

async function saveWorkflowResumeState(env: Record<string, string | undefined>, state: WorkflowResumeState) {
  const stateKey = `workflow_resume_${randomUUID()}`;
  await writeStateJson({ env, key: stateKey, value: state });
  return stateKey;
}

async function loadWorkflowResumeState(env: Record<string, string | undefined>, stateKey: string) {
  const stored = await readStateJson({ env, key: stateKey });
  if (!stored || typeof stored !== 'object') {
    throw new Error('Workflow resume state not found');
  }
  const data = stored as Partial<WorkflowResumeState>;
  if (!data.filePath || typeof data.filePath !== 'string') throw new Error('Invalid workflow resume state');
  if (typeof data.resumeAtIndex !== 'number') throw new Error('Invalid workflow resume state');
  if (!data.steps || typeof data.steps !== 'object') throw new Error('Invalid workflow resume state');
  if (!data.args || typeof data.args !== 'object') throw new Error('Invalid workflow resume state');
  return data as WorkflowResumeState;
}

function mergeEnv(
  base: Record<string, string | undefined>,
  workflowEnv: WorkflowFile['env'],
  stepEnv: WorkflowStep['env'],
  args: Record<string, unknown>,
  results: Record<string, WorkflowStepResult>,
) {
  const env = { ...base } as Record<string, string | undefined>;

  // Expose resolved args as env vars so shell commands can safely reference them
  // without embedding raw values into the command string.
  // Example: $LOBSTER_ARG_TEXT
  env.LOBSTER_ARGS_JSON = JSON.stringify(args ?? {});
  for (const [key, value] of Object.entries(args ?? {})) {
    const normalized = normalizeArgEnvKey(key);
    if (!normalized) continue;
    env[`LOBSTER_ARG_${normalized}`] = String(value);
  }

  const apply = (source?: Record<string, string>) => {
    if (!source) return;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') {
        env[key] = resolveTemplate(value, args, results);
      }
    }
  };

  // Allow explicit env blocks to override injected defaults.
  apply(workflowEnv);
  apply(stepEnv);
  return env;
}

function normalizeArgEnvKey(key: string): string | null {
  const trimmed = String(key ?? '').trim();
  if (!trimmed) return null;
  // Keep it predictable for shells: uppercase and [A-Z0-9_]
  const up = trimmed.toUpperCase();
  const normalized = up.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || null;
}

function resolveCwd(cwd: string | undefined, args: Record<string, unknown>) {
  if (!cwd) return undefined;
  return resolveArgsTemplate(cwd, args);
}

function resolveInputValue(
  stdin: unknown,
  args: Record<string, unknown>,
  results: Record<string, WorkflowStepResult>,
) {
  if (stdin === null || stdin === undefined) return null;
  if (typeof stdin === 'string') {
    const ref = parseStepRef(stdin.trim());
    if (ref) return getStepRefValue(ref, results, true);
    return resolveTemplate(stdin, args, results);
  }
  return stdin;
}

function resolveShellStdin(
  stdin: unknown,
  args: Record<string, unknown>,
  results: Record<string, WorkflowStepResult>,
) {
  const value = resolveInputValue(stdin, args, results);
  return encodeShellInput(value);
}

function resolveTemplate(
  input: string,
  args: Record<string, unknown>,
  results: Record<string, WorkflowStepResult>,
) {
  const withArgs = resolveArgsTemplate(input, args);
  return resolveStepRefs(withArgs, results);
}

function resolveArgsTemplate(input: string, args: Record<string, unknown>) {
  return input.replace(/\$\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
    if (key in args) return String(args[key]);
    return match;
  });
}

function resolveStepRefs(input: string, results: Record<string, WorkflowStepResult>) {
  return input.replace(/\$([A-Za-z0-9_-]+)\.(stdout|json|approved)/g, (match, id, field) => {
    const step = results[id];
    if (!step) return match;
    if (field === 'stdout') return step.stdout ?? '';
    if (field === 'json') return step.json !== undefined ? JSON.stringify(step.json) : '';
    if (field === 'approved') return step.approved === true ? 'true' : 'false';
    return match;
  });
}

function parseStepRef(value: string) {
  const match = value.match(/^\$([A-Za-z0-9_-]+)\.(stdout|json)$/);
  if (!match) return null;
  return { id: match[1], field: match[2] as 'stdout' | 'json' };
}

function getStepRefValue(
  ref: { id: string; field: 'stdout' | 'json' },
  results: Record<string, WorkflowStepResult>,
  strict: boolean,
) {
  const step = results[ref.id];
  if (!step) {
    if (strict) throw new Error(`Unknown step reference: ${ref.id}.${ref.field}`);
    return '';
  }
  if (ref.field === 'stdout') return step.stdout ?? '';
  return step.json;
}

function evaluateCondition(
  condition: unknown,
  results: Record<string, WorkflowStepResult>,
) {
  if (condition === undefined || condition === null) return true;
  if (typeof condition === 'boolean') return condition;
  if (typeof condition !== 'string') throw new Error('Unsupported condition type');

  const trimmed = condition.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  const match = trimmed.match(/^\$([A-Za-z0-9_-]+)\.(approved|skipped)$/);
  if (!match) throw new Error(`Unsupported condition: ${condition}`);

  const step = results[match[1]];
  if (!step) return false;

  return match[2] === 'approved' ? step.approved === true : step.skipped === true;
}

function isApprovalStep(approval: WorkflowStep['approval']) {
  if (approval === true) return true;
  if (typeof approval === 'string' && approval.trim().length > 0) return true;
  if (approval && typeof approval === 'object' && !Array.isArray(approval)) return true;
  return false;
}

function extractApprovalRequest(step: WorkflowStep, result: WorkflowStepResult) {
  const approvalConfig = normalizeApprovalConfig(step.approval);
  const fallbackPrompt = approvalConfig.prompt ?? `Approve ${step.id}?`;
  const json = result.json;

  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const candidate = json as {
      requiresApproval?: { prompt?: string; items?: unknown[]; preview?: string };
      prompt?: string;
      items?: unknown[];
      preview?: string;
    };
    if (candidate.requiresApproval?.prompt) {
      return {
        type: 'approval_request' as const,
        prompt: candidate.requiresApproval.prompt,
        items: candidate.requiresApproval.items ?? [],
        ...(candidate.requiresApproval.preview ? { preview: candidate.requiresApproval.preview } : null),
      };
    }
    if (candidate.prompt) {
      return {
        type: 'approval_request' as const,
        prompt: candidate.prompt,
        items: candidate.items ?? [],
        ...(candidate.preview ? { preview: candidate.preview } : null),
      };
    }
  }

  const items = approvalConfig.items ?? normalizeApprovalItems(result.json);
  const preview = approvalConfig.preview ?? buildResultPreview(result);

  return {
    type: 'approval_request' as const,
    prompt: fallbackPrompt,
    items,
    ...(preview ? { preview } : null),
  };
}

function parseJson(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function toOutputItems(result: WorkflowStepResult | undefined) {
  if (!result) return [];
  if (result.json !== undefined) {
    return Array.isArray(result.json) ? result.json : [result.json];
  }
  if (result.stdout !== undefined) {
    return result.stdout === '' ? [] : [result.stdout];
  }
  return [];
}

function cloneResults(results: Record<string, WorkflowStepResult>) {
  const out: Record<string, WorkflowStepResult> = {};
  for (const [key, value] of Object.entries(results)) {
    out[key] = { ...value };
  }
  return out;
}

function findLastCompletedStepId(steps: WorkflowStep[], results: Record<string, WorkflowStepResult>) {
  for (let idx = steps.length - 1; idx >= 0; idx--) {
    if (results[steps[idx].id]) return steps[idx].id;
  }
  return null;
}

function isInteractive(stdin: NodeJS.ReadableStream) {
  return Boolean((stdin as NodeJS.ReadStream).isTTY);
}

function parseApprovalTimeoutMs(env: Record<string, string | undefined>) {
  const raw = env?.LOBSTER_APPROVAL_INPUT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

async function runShellCommand({
  command,
  stdin,
  env,
  cwd,
  signal,
}: {
  command: string;
  stdin: string | null;
  env: Record<string, string | undefined>;
  cwd?: string;
  signal?: AbortSignal;
}) {
  const { spawn } = await import('node:child_process');

  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const shell = resolveInlineShellCommand({ command, env });
    const child = spawn(shell.command, shell.argv, {
      env,
      cwd,
      signal,
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
      reject(new Error(`workflow command failed (${code}): ${stderr.trim() || stdout.trim() || command}`));
    });
  });
}

function getStepExecution(step: WorkflowStep) {
  if (typeof step.pipeline === 'string' && step.pipeline.trim()) {
    return { kind: 'pipeline' as const, value: step.pipeline };
  }

  const shellCommand = typeof step.run === 'string' ? step.run : step.command;
  if (typeof shellCommand === 'string' && shellCommand.trim()) {
    return { kind: 'shell' as const, value: shellCommand };
  }

  return { kind: 'none' as const };
}

async function runPipelineStep({
  stepId,
  pipelineText,
  inputValue,
  ctx,
  env,
  cwd,
}: {
  stepId: string;
  pipelineText: string;
  inputValue: unknown;
  ctx: RunContext;
  env: Record<string, string | undefined>;
  cwd?: string;
}) {
  let pipeline;
  try {
    pipeline = parsePipeline(pipelineText);
  } catch (err: any) {
    throw new Error(`Workflow step ${stepId} pipeline parse failed: ${err?.message ?? String(err)}`);
  }

  const stdout = new PassThrough();
  let renderedStdout = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk) => {
    renderedStdout += String(chunk);
  });

  const result = await runPipeline({
    pipeline,
    registry: ctx.registry,
    stdin: ctx.stdin,
    stdout,
    stderr: ctx.stderr,
    env,
    mode: ctx.mode,
    cwd,
    signal: ctx.signal,
    llmAdapters: ctx.llmAdapters,
    input: inputValueToStream(inputValue),
  });
  stdout.end();

  if (result.halted) {
    const haltedName = result.haltedAt?.stage?.name ?? 'unknown';
    if (result.items.length === 1 && result.items[0]?.type === 'approval_request') {
      throw new Error(
        `Workflow step ${stepId} halted for approval inside pipeline stage ${haltedName}. Use a separate approval step in the workflow file.`,
      );
    }
    throw new Error(`Workflow step ${stepId} halted before completion at pipeline stage ${haltedName}`);
  }

  const normalizedStdout = renderedStdout || serializePipelineItemsToStdout(result.items);
  const json = result.items.length
    ? (result.items.length === 1 ? result.items[0] : result.items)
    : parseJson(renderedStdout);

  return {
    id: stepId,
    stdout: normalizedStdout,
    json,
  } satisfies WorkflowStepResult;
}

function createSyntheticStepResult(stepId: string, value: unknown): WorkflowStepResult {
  if (value === null || value === undefined) {
    return { id: stepId };
  }
  if (typeof value === 'string') {
    return {
      id: stepId,
      stdout: value,
      json: parseJson(value),
    };
  }
  return {
    id: stepId,
    stdout: serializeValueForStdout(value),
    json: value,
  };
}

function encodeShellInput(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function* inputValueToItems(value: unknown) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) yield item;
    return;
  }
  yield value;
}

function inputValueToStream(value: unknown) {
  return (async function* () {
    for (const item of inputValueToItems(value)) {
      yield item;
    }
  })();
}

function serializePipelineItemsToStdout(items: unknown[]) {
  if (!items.length) return '';
  if (items.every((item) => typeof item === 'string')) {
    return items.map((item) => String(item)).join('\n');
  }
  if (items.length === 1) {
    return serializeValueForStdout(items[0]);
  }
  return JSON.stringify(items);
}

function serializeValueForStdout(value: unknown) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function normalizeApprovalConfig(approval: WorkflowStep['approval']) {
  if (approval === true || approval === 'required' || approval === undefined || approval === false) {
    return {} as { prompt?: string; items?: unknown[]; preview?: string };
  }
  if (typeof approval === 'string') {
    return { prompt: approval };
  }
  if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
    return approval;
  }
  return {} as { prompt?: string; items?: unknown[]; preview?: string };
}

function normalizeApprovalItems(value: unknown) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function buildResultPreview(result: WorkflowStepResult) {
  if (result.stdout) return result.stdout.trim().slice(0, 2000);
  if (result.json !== undefined) return serializeValueForStdout(result.json).trim().slice(0, 2000);
  return undefined;
}
