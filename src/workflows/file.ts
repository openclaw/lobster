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
import { sharedAjv } from '../validation.js';

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
  input?: WorkflowInputRequest;
  condition?: unknown;
  when?: unknown;
  retry?: number;
  retry_delay?: string;
  on_error?: 'fail' | 'skip' | string;
  next?: string;
  max_iterations?: number;
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

export type WorkflowInputRequest = {
  prompt: string;
  responseSchema: unknown;
  defaults?: unknown;
};

export type WorkflowStepResult = {
  id: string;
  stdout?: string;
  json?: unknown;
  approved?: boolean;
  subject?: unknown;
  response?: unknown;
  failed?: boolean;
  error?: string;
  skipped?: boolean;
};

export type WorkflowRunResult = {
  status: 'ok' | 'needs_approval' | 'needs_input' | 'cancelled';
  output: unknown[];
  requiresApproval?: {
    type: 'approval_request';
    prompt: string;
    items: unknown[];
    preview?: string;
    resumeToken?: string;
  };
  requiresInput?: {
    type: 'input_request';
    prompt: string;
    responseSchema: unknown;
    defaults?: unknown;
    subject?: unknown;
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
  inputStepId?: string;
  inputSchema?: unknown;
  inputSubject?: unknown;
  iterationCounts?: Record<string, number>;
};

type WorkflowResumeState = {
  filePath: string;
  resumeAtIndex: number;
  steps: Record<string, WorkflowStepResult>;
  args: Record<string, unknown>;
  approvalStepId?: string;
  inputStepId?: string;
  inputSchema?: unknown;
  inputSubject?: unknown;
  iterationCounts?: Record<string, number>;
  createdAt: string;
};

export class WorkflowResumeArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowResumeArgumentError';
  }
}

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
    if (executionCount === 0 && !isApprovalStep(step.approval) && !isInputStep(step.input)) {
      throw new Error(`Workflow step ${step.id} requires run, command, pipeline, approval, or input`);
    }
    if (executionCount > 1) {
      throw new Error(`Workflow step ${step.id} can only define one of run, command, or pipeline`);
    }
    if (executionCount > 0 && isInputStep(step.input)) {
      throw new Error(`Workflow step ${step.id} input steps cannot define run, command, or pipeline`);
    }
    if (isApprovalStep(step.approval) && isInputStep(step.input)) {
      throw new Error(`Workflow step ${step.id} cannot define both approval and input`);
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
    if (step.input !== undefined && !isInputStep(step.input)) {
      throw new Error(`Workflow step ${step.id} input must be an object`);
    }
    if (step.input && typeof step.input.prompt !== 'string') {
      throw new Error(`Workflow step ${step.id} input.prompt must be a string`);
    }
    if (step.input && (!step.input.responseSchema || typeof step.input.responseSchema !== 'object')) {
      throw new Error(`Workflow step ${step.id} input.responseSchema must be an object`);
    }
    if (step.input) {
      try {
        sharedAjv.compile(step.input.responseSchema as any);
      } catch (err: any) {
        throw new Error(
          `Workflow step ${step.id} input.responseSchema is invalid: ${err?.message ?? String(err)}`,
        );
      }
    }
    if (step.retry !== undefined && (!Number.isInteger(step.retry) || step.retry < 0)) {
      throw new Error(`Workflow step ${step.id} retry must be a non-negative integer`);
    }
    if (step.retry_delay !== undefined && !isValidDurationString(step.retry_delay)) {
      throw new Error(`Workflow step ${step.id} retry_delay must be a duration like 1s or 500ms`);
    }
    if (step.max_iterations !== undefined && (!Number.isInteger(step.max_iterations) || step.max_iterations <= 0)) {
      throw new Error(`Workflow step ${step.id} max_iterations must be a positive integer`);
    }
    if (step.on_error !== undefined && typeof step.on_error !== 'string') {
      throw new Error(`Workflow step ${step.id} on_error must be a string`);
    }
    if (step.next !== undefined && typeof step.next !== 'string') {
      throw new Error(`Workflow step ${step.id} next must be a string`);
    }
    if (seen.has(step.id)) {
      throw new Error(`Duplicate workflow step id: ${step.id}`);
    }
    seen.add(step.id);
  }

  for (const step of steps) {
    if (step.next) {
      const target = step.next.trim();
      if (!target) {
        throw new Error(`Workflow step ${step.id} next cannot be empty`);
      }
      if (!seen.has(target)) {
        throw new Error(`Workflow step ${step.id} next target not found: ${target}`);
      }
      if (isApprovalStep(step.approval) || isInputStep(step.input)) {
        throw new Error(`Workflow step ${step.id} cannot use next with approval/input steps`);
      }
    }
    if (typeof step.on_error === 'string') {
      const target = step.on_error.trim();
      if (!target) {
        throw new Error(`Workflow step ${step.id} on_error cannot be empty`);
      }
      if (!['fail', 'skip'].includes(target) && !seen.has(target)) {
        throw new Error(`Workflow step ${step.id} on_error target not found: ${target}`);
      }
    }
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
  response,
  cancel,
}: {
  filePath?: string;
  args?: Record<string, unknown>;
  ctx: RunContext;
  resume?: WorkflowResumePayload;
  approved?: boolean;
  response?: unknown;
  cancel?: boolean;
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
  const stepIndexById = new Map(steps.map((step, idx) => [step.id, idx]));
  const jumpTargets = collectJumpTargets(steps);
  const results: Record<string, WorkflowStepResult> = resumeState?.steps
    ? cloneResults(resumeState.steps)
    : {};
  const iterationCounts: Record<string, number> = resumeState?.iterationCounts
    ? { ...resumeState.iterationCounts }
    : {};
  const startIndex = resumeState?.resumeAtIndex ?? 0;
  if (resumeState?.approvalStepId && resumeState?.inputStepId) {
    throw new Error('Invalid workflow resume state');
  }

  if (resumeState?.approvalStepId) {
    if (response !== undefined) {
      throw new WorkflowResumeArgumentError('Workflow resume requires --approve yes|no for approval requests');
    }
    if (cancel === true || approved === false) {
      if (consumedResumeStateKey) {
        await deleteStateJson({ env: ctx.env, key: consumedResumeStateKey });
      }
      return { status: 'cancelled', output: [] };
    }
    if (typeof approved !== 'boolean') {
      throw new WorkflowResumeArgumentError('Workflow resume requires --approve yes|no for approval requests');
    }
    const previous = results[resumeState.approvalStepId] ?? { id: resumeState.approvalStepId };
    previous.approved = approved;
    results[resumeState.approvalStepId] = previous;
  }

  if (resumeState?.inputStepId) {
    if (cancel === true) {
      if (consumedResumeStateKey) {
        await deleteStateJson({ env: ctx.env, key: consumedResumeStateKey });
      }
      return { status: 'cancelled', output: [] };
    }
    if (approved !== undefined) {
      throw new WorkflowResumeArgumentError('Workflow resume requires --response-json for input requests');
    }
    if (response === undefined) {
      throw new WorkflowResumeArgumentError('Workflow resume requires --response-json for input requests');
    }
    const inputStep = steps[stepIndexById.get(resumeState.inputStepId) ?? -1];
    if (!inputStep || !isInputStep(inputStep.input)) {
      throw new Error(`Invalid input step in resume state: ${resumeState.inputStepId}`);
    }
    try {
      validateInputResponse({
        schema: resumeState.inputSchema ?? inputStep.input.responseSchema,
        response,
        stepId: inputStep.id,
      });
    } catch (err: any) {
      throw new WorkflowResumeArgumentError(err?.message ?? String(err));
    }
    const previous = results[resumeState.inputStepId] ?? { id: resumeState.inputStepId };
    previous.subject = resumeState.inputSubject ?? null;
    previous.response = response;
    delete previous.skipped;
    delete previous.failed;
    delete previous.error;
    results[resumeState.inputStepId] = previous;
  }

  let lastStepId: string | null =
    resumeState?.inputStepId ?? findLastCompletedStepId(steps, results);

  let idx = startIndex;
  while (idx < steps.length) {
    const step = steps[idx];

    if (!evaluateCondition(step.when ?? step.condition, results)) {
      const previous = results[step.id];
      results[step.id] = previous
        ? {
          id: step.id,
          stdout: previous.stdout,
          json: previous.json,
          subject: previous.subject,
          response: previous.response,
          skipped: true,
        }
        : { id: step.id, skipped: true };
      idx += 1;
      continue;
    }

    if (shouldTrackStepIterations(step, jumpTargets)) {
      const maxIterations = resolveMaxIterations(step.max_iterations);
      const nextIteration = (iterationCounts[step.id] ?? 0) + 1;
      iterationCounts[step.id] = nextIteration;
      if (nextIteration > maxIterations) {
        throw new Error(
          `Workflow step ${step.id} exceeded max_iterations (${maxIterations}). ` +
          `This usually indicates a loop that never exits.`,
        );
      }
    }

    if (isInputStep(step.input)) {
      const subject = resolveInputSubject({
        step,
        args: resolvedArgs,
        results,
        lastStepId,
      });
      const inputRequest = buildNeedsInputRequest({
        stepId: step.id,
        prompt: step.input.prompt,
        responseSchema: step.input.responseSchema,
        defaults: step.input.defaults,
        subject,
        maxEnvelopeBytes: resolveToolEnvelopeMaxBytes(ctx.env),
      });

      if (ctx.mode === 'tool' || !isInteractive(ctx.stdin)) {
        const stateKey = await saveWorkflowResumeState(ctx.env, {
          filePath: resolvedFilePath,
          resumeAtIndex: idx + 1,
          steps: results,
          args: resolvedArgs,
          inputStepId: step.id,
          inputSchema: step.input.responseSchema,
          inputSubject: inputRequest.subject,
          iterationCounts,
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
          status: 'needs_input',
          output: [],
          requiresInput: {
            ...inputRequest,
            resumeToken,
          },
        };
      }

      ctx.stdout.write(`${step.input.prompt}\n`);
      ctx.stdout.write('Enter JSON response: ');
      const raw = await readLineFromStream(ctx.stdin, {
        timeoutMs: parseApprovalTimeoutMs(ctx.env),
      });
      const parsed = parseResponseJson(String(raw ?? '').trim());
      validateInputResponse({
        schema: step.input.responseSchema,
        response: parsed,
        stepId: step.id,
      });
      results[step.id] = {
        id: step.id,
        subject,
        response: parsed,
      };
      lastStepId = step.id;
      idx += 1;
      continue;
    }

    const env = mergeEnv(ctx.env, workflow.env, step.env, resolvedArgs, results);
    const cwd = resolveCwd(step.cwd ?? workflow.cwd, resolvedArgs) ?? ctx.cwd;
    const execution = getStepExecution(step);

    let result: WorkflowStepResult | null = null;
    let failure: unknown = null;
    try {
      result = await runWithRetry({
        retries: step.retry ?? 0,
        retryDelayMs: parseRetryDelayMs(step.retry_delay),
        signal: ctx.signal,
        run: async () => {
          if (execution.kind === 'shell') {
            const command = resolveTemplate(execution.value, resolvedArgs, results);
            const stdinValue = resolveShellStdin(step.stdin, resolvedArgs, results);
            const { stdout } = await runShellCommand({ command, stdin: stdinValue, env, cwd, signal: ctx.signal });
            return { id: step.id, stdout, json: parseJson(stdout) };
          }
          if (execution.kind === 'pipeline') {
            if (!ctx.registry) {
              throw new Error(`Workflow step ${step.id} requires a command registry for pipeline execution`);
            }
            const pipelineText = resolveTemplate(execution.value, resolvedArgs, results);
            const inputValue = resolveInputValue(step.stdin, resolvedArgs, results);
            return await runPipelineStep({
              stepId: step.id,
              pipelineText,
              inputValue,
              ctx,
              env,
              cwd,
            });
          }
          const inputValue = resolveInputValue(step.stdin, resolvedArgs, results);
          return createSyntheticStepResult(step.id, inputValue);
        },
      });
    } catch (err) {
      failure = err;
    }

    if (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      results[step.id] = {
        id: step.id,
        failed: true,
        error: message,
      };
      lastStepId = step.id;
      const onErrorTarget = normalizeOnError(step.on_error);
      if (onErrorTarget === 'fail') {
        throw failure;
      }
      if (onErrorTarget === 'skip') {
        idx += 1;
        continue;
      }
      const jumpIndex = stepIndexById.get(onErrorTarget);
      if (jumpIndex === undefined) {
        throw new Error(`Workflow step ${step.id} on_error target not found: ${onErrorTarget}`);
      }
      idx = jumpIndex;
      continue;
    }

    results[step.id] = result!;
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
          iterationCounts,
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

    if (step.next) {
      const jumpIndex = stepIndexById.get(step.next.trim());
      if (jumpIndex === undefined) {
        throw new Error(`Workflow step ${step.id} next target not found: ${step.next}`);
      }
      idx = jumpIndex;
      continue;
    }
    idx += 1;
  }

  const output = lastStepId ? toOutputItems(results[lastStepId]) : [];
  if (consumedResumeStateKey) {
    await deleteStateJson({ env: ctx.env, key: consumedResumeStateKey });
  }
  return { status: 'ok', output };
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
  if (data.iterationCounts !== undefined) {
    if (!data.iterationCounts || typeof data.iterationCounts !== 'object' || Array.isArray(data.iterationCounts)) {
      throw new Error('Invalid workflow resume state');
    }
    for (const value of Object.values(data.iterationCounts)) {
      if (!Number.isInteger(value) || (value as number) < 0) {
        throw new Error('Invalid workflow resume state');
      }
    }
  }
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
  return input.replace(/\$([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g, (match, id, pathValue) => {
    const refValue = getStepRefValue({ id, path: pathValue }, results, false);
    if (refValue === undefined) {
      if (pathValue === 'approved' || pathValue === 'skipped') return 'false';
      return '';
    }
    return renderTemplateValue(refValue);
  });
}

function parseStepRef(value: string) {
  const match = value.match(/^\$([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)$/);
  if (!match) return null;
  return { id: match[1], path: match[2] };
}

function getStepRefValue(
  ref: { id: string; path: string },
  results: Record<string, WorkflowStepResult>,
  strict: boolean,
) {
  const step = results[ref.id];
  if (!step) {
    if (strict) throw new Error(`Unknown step reference: ${ref.id}.${ref.path}`);
    return undefined;
  }
  return getValueByPath(step, ref.path);
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
  return evaluateExpression(trimmed, results);
}

function isApprovalStep(approval: WorkflowStep['approval']) {
  if (approval === true) return true;
  if (typeof approval === 'string' && approval.trim().length > 0) return true;
  if (approval && typeof approval === 'object' && !Array.isArray(approval)) return true;
  return false;
}

function isInputStep(input: WorkflowStep['input']) {
  return Boolean(input && typeof input === 'object' && !Array.isArray(input));
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
  if (result.response !== undefined) {
    return Array.isArray(result.response) ? result.response : [result.response];
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

const DURATION_PATTERN = /^(\d+)(ms|s|m|h)$/i;
const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_NEEDS_INPUT_SUBJECT_BYTES = 192_000;
const DEFAULT_TOOL_ENVELOPE_MAX_BYTES = 512_000;
const RESUME_TOKEN_PLACEHOLDER = 'x'.repeat(220);

function parseResponseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON passed to --response-json');
  }
}

function validateInputResponse(params: {
  schema: unknown;
  response: unknown;
  stepId: string;
}) {
  const validator = sharedAjv.compile(params.schema as object);
  const ok = validator(params.response);
  if (ok) return;
  const first = validator.errors?.[0];
  const pathValue = first?.instancePath || '/';
  const reason = first?.message ? ` ${first.message}` : '';
  throw new Error(
    `Workflow input step ${params.stepId} response failed schema validation at ${pathValue}:${reason}`,
  );
}

function resolveInputSubject(params: {
  step: WorkflowStep;
  args: Record<string, unknown>;
  results: Record<string, WorkflowStepResult>;
  lastStepId: string | null;
}) {
  if (params.step.stdin !== undefined) {
    return resolveInputValue(params.step.stdin, params.args, params.results);
  }
  if (!params.lastStepId) return null;
  const previous = params.results[params.lastStepId];
  if (!previous) return null;
  if (previous.json !== undefined) return previous.json;
  if (previous.response !== undefined) return previous.response;
  if (previous.stdout !== undefined) return previous.stdout;
  return null;
}

function maybeTruncateInputSubject(subject: unknown): unknown {
  let serialized = '';
  try {
    serialized = JSON.stringify(subject ?? null);
  } catch {
    return {
      truncated: true,
      bytes: 0,
      preview: '[unserializable subject]',
    };
  }
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength <= MAX_NEEDS_INPUT_SUBJECT_BYTES) return subject;
  const preview = serialized.slice(0, 2000);
  return {
    truncated: true,
    bytes: byteLength,
    preview,
  };
}

function resolveToolEnvelopeMaxBytes(env: Record<string, string | undefined>) {
  const raw = env?.LOBSTER_MAX_TOOL_ENVELOPE_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1024) {
    return DEFAULT_TOOL_ENVELOPE_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function buildNeedsInputRequest(params: {
  stepId: string;
  prompt: string;
  responseSchema: unknown;
  defaults: unknown;
  subject: unknown;
  maxEnvelopeBytes: number;
}) {
  const base = {
    type: 'input_request' as const,
    prompt: params.prompt,
    responseSchema: params.responseSchema,
    ...(params.defaults !== undefined ? { defaults: params.defaults } : null),
  };

  let subject = params.subject;
  let request = { ...base, subject };
  if (fitsNeedsInputEnvelope(request, params.maxEnvelopeBytes)) {
    return request;
  }

  subject = maybeTruncateInputSubject(subject);
  request = { ...base, subject };
  if (fitsNeedsInputEnvelope(request, params.maxEnvelopeBytes)) {
    return request;
  }

  request = {
    ...base,
    subject: {
      truncated: true,
      bytes: estimateSerializedBytes(params.subject),
      preview: '[subject omitted: envelope size limit]',
    },
  };
  if (fitsNeedsInputEnvelope(request, params.maxEnvelopeBytes)) {
    return request;
  }

  throw new Error(
    `Workflow input step ${params.stepId} needs_input envelope exceeds ${params.maxEnvelopeBytes} bytes ` +
    `even after subject truncation`,
  );
}

function fitsNeedsInputEnvelope(
  request: {
    type: 'input_request';
    prompt: string;
    responseSchema: unknown;
    defaults?: unknown;
    subject: unknown;
  },
  maxEnvelopeBytes: number,
) {
  const envelope = {
    protocolVersion: 1,
    ok: true,
    status: 'needs_input',
    output: [],
    requiresApproval: null,
    requiresInput: {
      ...request,
      resumeToken: RESUME_TOKEN_PLACEHOLDER,
    },
  };
  return estimateSerializedBytes(envelope) <= maxEnvelopeBytes;
}

function estimateSerializedBytes(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isValidDurationString(value: string) {
  return DURATION_PATTERN.test(value.trim());
}

function parseRetryDelayMs(value: unknown) {
  if (value === undefined || value === null) return DEFAULT_RETRY_DELAY_MS;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value !== 'string') {
    throw new Error('retry_delay must be a duration string like 1s');
  }
  const trimmed = value.trim();
  const match = trimmed.match(DURATION_PATTERN);
  if (!match) {
    throw new Error(`Invalid retry_delay: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return amount * multiplier;
}

async function runWithRetry<T>(params: {
  retries: number;
  retryDelayMs: number;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  const retries = Number.isInteger(params.retries) && params.retries > 0 ? params.retries : 0;
  const attempts = retries + 1;
  for (let attempt = 1; ; attempt++) {
    if (params.signal?.aborted) {
      throw new Error('Workflow aborted');
    }
    try {
      return await params.run();
    } catch (err) {
      if (attempt >= attempts) {
        throw err;
      }
      await sleepWithAbort(params.retryDelayMs, params.signal);
    }
  }
}

async function sleepWithAbort(ms: number, signal?: AbortSignal) {
  const waitMs = Math.max(0, ms);
  if (!waitMs) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, waitMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Workflow aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function normalizeOnError(value: WorkflowStep['on_error']) {
  const raw = typeof value === 'string' ? value.trim() : 'fail';
  if (!raw || raw === 'fail') return 'fail' as const;
  if (raw === 'skip') return 'skip' as const;
  return raw;
}

function resolveMaxIterations(value: WorkflowStep['max_iterations']) {
  if (value === undefined || value === null) return DEFAULT_MAX_ITERATIONS;
  return value;
}

function collectJumpTargets(steps: WorkflowStep[]) {
  const out = new Set<string>();
  for (const step of steps) {
    if (typeof step.next === 'string' && step.next.trim()) {
      out.add(step.next.trim());
    }
    if (typeof step.on_error === 'string') {
      const target = step.on_error.trim();
      if (target && target !== 'fail' && target !== 'skip') {
        out.add(target);
      }
    }
  }
  return out;
}

function shouldTrackStepIterations(step: WorkflowStep, jumpTargets: Set<string>) {
  if (step.max_iterations !== undefined) return true;
  if (typeof step.next === 'string' && step.next.trim()) return true;
  if (typeof step.on_error === 'string') {
    const target = step.on_error.trim();
    if (target && target !== 'fail' && target !== 'skip') return true;
  }
  return jumpTargets.has(step.id);
}

function renderTemplateValue(value: unknown) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getValueByPath(value: unknown, pathValue: string) {
  const fields = pathValue.split('.');
  let current: unknown = value;
  for (const field of fields) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(field);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[field];
  }
  return current;
}

function evaluateExpression(expression: string, results: Record<string, WorkflowStepResult>) {
  const hasAnd = containsConditionOperator(expression, '&&');
  const hasOr = containsConditionOperator(expression, '||');
  if (hasAnd && hasOr) {
    throw new Error(`Unsupported condition: ${expression}`);
  }
  if (hasAnd) {
    const parts = splitConditionByOperator(expression, '&&');
    return parts.every((part) => evaluateAtom(part, results));
  }
  if (hasOr) {
    const parts = splitConditionByOperator(expression, '||');
    return parts.some((part) => evaluateAtom(part, results));
  }
  return evaluateAtom(expression, results);
}

function containsConditionOperator(input: string, op: '&&' | '||') {
  return splitConditionByOperator(input, op).length > 1;
}

function splitConditionByOperator(input: string, op: '&&' | '||') {
  const pieces: string[] = [];
  let current = '';
  let quote = false;
  for (let idx = 0; idx < input.length; idx++) {
    const ch = input[idx];
    if (ch === '"' && !isEscapedQuote(input, idx)) {
      quote = !quote;
      current += ch;
      continue;
    }
    if (!quote && input.slice(idx, idx + op.length) === op) {
      pieces.push(current.trim());
      current = '';
      idx += op.length - 1;
      continue;
    }
    current += ch;
  }
  pieces.push(current.trim());
  return pieces.filter((piece) => piece.length > 0);
}

function isEscapedQuote(input: string, quoteIndex: number) {
  let backslashes = 0;
  for (let idx = quoteIndex - 1; idx >= 0 && input[idx] === '\\'; idx--) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function evaluateAtom(atomRaw: string, results: Record<string, WorkflowStepResult>): boolean {
  const atom = atomRaw.trim();
  if (!atom) throw new Error('Unsupported condition');
  if (atom === 'true') return true;
  if (atom === 'false') return false;
  if (atom.startsWith('!')) {
    return !evaluateAtom(atom.slice(1), results);
  }

  const comparison = parseComparison(atom);
  if (comparison) {
    const left = resolveConditionRef(comparison.ref, results);
    if (left === undefined || left === null) return false;
    const leftText = String(left);
    return comparison.op === '==' ? leftText === comparison.literal : leftText !== comparison.literal;
  }

  const ref = parseStepRef(atom);
  if (!ref) {
    throw new Error(`Unsupported condition: ${atom}`);
  }
  const value = getStepRefValue(ref, results, false);
  return Boolean(value);
}

function parseComparison(atom: string): { ref: { id: string; path: string }; op: '==' | '!='; literal: string } | null {
  const match = atom.match(
    /^(\$[A-Za-z0-9_-]+\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s*(==|!=)\s*(.+)$/,
  );
  if (!match) return null;
  const ref = parseStepRef(match[1]);
  if (!ref) throw new Error(`Unsupported condition: ${atom}`);
  return {
    ref,
    op: match[2] as '==' | '!=',
    literal: parseConditionLiteral(match[3].trim()),
  };
}

function parseConditionLiteral(input: string) {
  if (input.startsWith('"')) {
    if (!input.endsWith('"') || input.length < 2) {
      throw new Error(`Invalid quoted literal in condition: ${input}`);
    }
    const body = input.slice(1, -1);
    return body.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (!/^[^\s&|"]+$/.test(input)) {
    throw new Error(`Invalid literal in condition: ${input}`);
  }
  return input;
}

function resolveConditionRef(ref: { id: string; path: string }, results: Record<string, WorkflowStepResult>) {
  return getStepRefValue(ref, results, false);
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
