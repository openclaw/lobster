import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { parsePipeline } from '../parser.js';
import { runPipeline } from '../runtime.js';
import { encodeToken, decodeToken } from '../token.js';
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

export type FlowRule =
  | { when: string; goto: string }
  | { default: string };

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
  flow?: FlowRule[];
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
  visitCounts?: Record<string, number>;
  flowPending?: boolean;
};

type WorkflowResumeState = {
  filePath: string;
  resumeAtIndex: number;
  steps: Record<string, WorkflowStepResult>;
  args: Record<string, unknown>;
  approvalStepId?: string;
  createdAt: string;
  visitCounts?: Record<string, number>;
  flowPending?: boolean;
  childStateKey?: string;
  childFilePath?: string;
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

  // First pass: collect step IDs for flow target validation
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

  // Second pass: validate flow rules and max_iterations
  for (const step of steps) {
    if (step.flow !== undefined) {
      if (!Array.isArray(step.flow)) {
        throw new Error(`Step ${step.id}: flow must be an array`);
      }
      for (let i = 0; i < step.flow.length; i++) {
        const rule = step.flow[i];
        if ('default' in rule) {
          if (i !== step.flow.length - 1) {
            throw new Error(`Step ${step.id}: default must be the last flow rule`);
          }
          if (!seen.has(rule.default)) {
            throw new Error(`Step ${step.id}: goto target '${rule.default}' not found`);
          }
        } else if ('when' in rule && 'goto' in rule) {
          if (!seen.has(rule.goto)) {
            throw new Error(`Step ${step.id}: goto target '${rule.goto}' not found`);
          }
        } else {
          throw new Error(`Step ${step.id}: invalid flow rule at index ${i}`);
        }
      }
    }
    if (step.max_iterations !== undefined) {
      if (
        typeof step.max_iterations !== 'number' ||
        step.max_iterations < 1 ||
        !Number.isInteger(step.max_iterations)
      ) {
        throw new Error(`Step ${step.id}: max_iterations must be a positive integer`);
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
  _depth = 0,
}: {
  filePath?: string;
  args?: Record<string, unknown>;
  ctx: RunContext;
  resume?: WorkflowResumePayload;
  approved?: boolean;
  _depth?: number;
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

  if (resumeState?.approvalStepId && approved === false && !resumeState.flowPending) {
    if (consumedResumeStateKey) {
      await deleteStateJson({ env: ctx.env, key: consumedResumeStateKey });
    }
    return { status: 'cancelled', output: [] };
  }

  if (resumeState?.approvalStepId && typeof approved === 'boolean' && !resumeState.flowPending) {
    const previous = results[resumeState.approvalStepId] ?? { id: resumeState.approvalStepId };
    previous.approved = approved;
    results[resumeState.approvalStepId] = previous;
  }

  // Build step index map for flow jump resolution
  const stepIndexMap = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    stepIndexMap.set(steps[i].id, i);
  }

  // Restore visit counts from resume state (for halt/resume across loops)
  const visitCounts = new Map<string, number>(
    Object.entries(resumeState?.visitCounts ?? {}),
  );

  let lastStepId: string | null = findLastCompletedStepId(steps, results);
  let idx = startIndex;

  while (idx >= 0 && idx < steps.length) {
    const step = steps[idx];

    // Handle flowPending resume: skip re-execution, just set approval and evaluate flow
    // (Only when no childStateKey — child resume takes precedence)
    const hasChildResume = !!(resumeState as WorkflowResumeState | null)?.childStateKey;
    if (resumeState?.flowPending && idx === startIndex && !hasChildResume) {
      if (resumeState.approvalStepId === step.id && typeof approved === 'boolean') {
        results[step.id] = { ...(results[step.id] ?? { id: step.id }), approved };
      }
      lastStepId = step.id;
      const flowTarget = evaluateFlowRules(step.flow, results);
      if (flowTarget !== null) {
        idx = stepIndexMap.get(flowTarget)!;
      } else {
        idx++;
      }
      // flowPending only applies to the first step on resume
      (resumeState as WorkflowResumeState).flowPending = false;
      continue;
    }

    if (!evaluateCondition(step.when ?? step.condition, results)) {
      results[step.id] = { id: step.id, skipped: true };
      idx++;
      continue;
    }

    const childResumeKey = (resumeState as WorkflowResumeState | null)?.childStateKey;

    // Resuming a halted child continues the current parent visit instead of starting a new one.
    const visits = childResumeKey && idx === startIndex
      ? (visitCounts.get(step.id) ?? 1)
      : (visitCounts.get(step.id) ?? 0) + 1;
    const maxIter = step.max_iterations ?? 10;
    if (visits > maxIter) {
      throw new Error(`Step '${step.id}' exceeded max_iterations (${maxIter})`);
    }
    visitCounts.set(step.id, visits);
    const env = mergeEnv(ctx.env, workflow.env, step.env, resolvedArgs, results);
    const cwd = resolveCwd(step.cwd ?? workflow.cwd, resolvedArgs) ?? ctx.cwd;
    const execution = getStepExecution(step);

    let result: WorkflowStepResult;
    if (execution.kind === 'shell') {
      const command = resolveTemplate(execution.value, resolvedArgs, results);
      const lobsterRun = parseLobsterRunCommand(command);
      const childResumeFilePath = (resumeState as WorkflowResumeState | null)?.childFilePath;

      if (lobsterRun || childResumeKey) {
        const childResult = await executeChildWorkflow(
          lobsterRun ?? { file: childResumeFilePath },
          {
            parentFilePath: resolvedFilePath,
            env,
            cwd,
            ctx,
            depth: _depth + 1,
            resumeChildStateKey: childResumeKey,
            resumeApproved: approved,
          },
        );

        // Once we've used the child resume key, clear it so we don't re-use it.
        if (resumeState) (resumeState as WorkflowResumeState).childStateKey = undefined;

        if (childResult.halted) {
          const hasFlow = step.flow && step.flow.length > 0;
          const stateKey = await saveWorkflowResumeState(ctx.env, {
            filePath: resolvedFilePath,
            resumeAtIndex: idx,
            steps: results,
            args: resolvedArgs,
            approvalStepId: childResult.approvalStepId,
            createdAt: new Date().toISOString(),
            visitCounts: Object.fromEntries(visitCounts),
            childStateKey: childResult.childStateKey,
            childFilePath: childResult.childFilePath,
            flowPending: hasFlow ? true : undefined,
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
              ...(childResult.requiresApproval!),
              resumeToken,
            },
          };
        }

        result = { ...childResult.stepResult!, id: step.id };
      } else {
        const stdinValue = resolveShellStdin(step.stdin, resolvedArgs, results);
        const { stdout } = await runShellCommand({ command, stdin: stdinValue, env, cwd, signal: ctx.signal });
        result = { id: step.id, stdout, json: parseJson(stdout) };
      }
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
        // If step has flow, resume at same index with flowPending so flow evaluates on resume
        const hasFlow = step.flow && step.flow.length > 0;
        const stateKey = await saveWorkflowResumeState(ctx.env, {
          filePath: resolvedFilePath,
          resumeAtIndex: hasFlow ? idx : idx + 1,
          steps: results,
          args: resolvedArgs,
          approvalStepId: step.id,
          createdAt: new Date().toISOString(),
          visitCounts: Object.fromEntries(visitCounts),
          flowPending: hasFlow ? true : undefined,
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

    // Evaluate flow rules after execution (and approval if interactive)
    const flowTarget = evaluateFlowRules(step.flow, results);
    if (flowTarget !== null) {
      idx = stepIndexMap.get(flowTarget)!;
    } else {
      idx++;
    }
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

export function evaluateCondition(
  condition: unknown,
  results: Record<string, WorkflowStepResult>,
): boolean {
  if (condition === undefined || condition === null) return true;
  if (typeof condition === 'boolean') return condition;
  if (typeof condition !== 'string') throw new Error('Unsupported condition type');

  const trimmed = condition.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  const parsed = parseConditionExpression(trimmed);
  const resolvedValue = resolveDeepRef(parsed.ref, results);

  if (parsed.op === null) {
    return isTruthy(resolvedValue);
  }

  return compareValues(resolvedValue, parsed.op, parsed.literal);
}

function parseConditionExpression(input: string): { ref: string; op: string | null; literal: unknown } {
  // Try comparison: <ref> <op> <literal>
  const compMatch = input.match(/^(\$[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\s*(==|!=|>=?|<=?)\s*(.+)$/);
  if (compMatch) {
    return { ref: compMatch[1], op: compMatch[2], literal: parseLiteral(compMatch[3].trim()) };
  }
  // Try bare ref
  const refMatch = input.match(/^(\$[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)$/);
  if (refMatch) {
    return { ref: refMatch[1], op: null, literal: null };
  }
  throw new Error(`Unsupported condition: ${input}`);
}

function parseLiteral(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  const num = Number(raw);
  if (!Number.isNaN(num)) return num;
  throw new Error(`Cannot parse literal: ${raw}`);
}

export function resolveDeepRef(
  ref: string,
  results: Record<string, WorkflowStepResult>,
): unknown {
  const match = ref.match(/^\$([A-Za-z0-9_-]+)\.(.+)$/);
  if (!match) throw new Error(`Invalid ref: ${ref}`);

  const [, stepId, path] = match;
  const step = results[stepId];
  if (!step) return undefined;

  const segments = path.split('.');
  let current: unknown = step;

  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[seg];
  }

  return current;
}

export function evaluateFlowRules(
  flow: FlowRule[] | undefined,
  results: Record<string, WorkflowStepResult>,
): string | null {
  if (!flow) return null;
  for (const rule of flow) {
    if ('default' in rule) return rule.default;
    if (evaluateCondition(rule.when, results)) return rule.goto;
  }
  return null;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  return true;
}

function compareValues(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case '==': return left === right;
    case '!=': return left !== right;
    case '>':  return typeof left === 'number' && typeof right === 'number' && left > right;
    case '<':  return typeof left === 'number' && typeof right === 'number' && left < right;
    case '>=': return typeof left === 'number' && typeof right === 'number' && left >= right;
    case '<=': return typeof left === 'number' && typeof right === 'number' && left <= right;
    default: throw new Error(`Unknown operator: ${op}`);
  }
}

type ChildExecutionResult =
  | { halted: false; stepResult: WorkflowStepResult }
  | {
      halted: true;
      childStateKey: string;
      childFilePath: string;
      approvalStepId?: string;
      requiresApproval: WorkflowRunResult['requiresApproval'];
      stepResult?: never;
    };

async function executeChildWorkflow(
  parsed: { name?: string; file?: string; argsJson?: string },
  context: {
    parentFilePath: string;
    env: Record<string, string | undefined>;
    cwd?: string;
    ctx: RunContext;
    depth: number;
    resumeChildStateKey?: string;
    resumeApproved?: boolean;
  },
): Promise<ChildExecutionResult> {
  const maxDepth = parseInt((context.env.LOBSTER_MAX_WORKFLOW_DEPTH as string | undefined) ?? '10', 10);
  if (context.depth > maxDepth) {
    throw new Error(`Workflow nesting depth exceeded (max: ${maxDepth})`);
  }

  let childPath: string;
  if (context.resumeChildStateKey) {
    // Resuming a halted child — path comes from resumeChildFilePath
    childPath = parsed.file!;
  } else if (parsed.file) {
    childPath = path.resolve(context.cwd ?? '.', parsed.file);
  } else {
    childPath = await resolveWorkflowByName(
      parsed.name!,
      context.parentFilePath,
      context.env.LOBSTER_WORKFLOW_PATH as string | undefined,
      context.cwd,
    );
  }

  const childArgs = parsed.argsJson ? JSON.parse(parsed.argsJson) : {};

  // Build resume payload for child if we have a child state key
  let childResume: WorkflowResumePayload | undefined;
  if (context.resumeChildStateKey) {
    childResume = {
      protocolVersion: 1,
      v: 1,
      kind: 'workflow-file',
      stateKey: context.resumeChildStateKey,
    };
  }

  const childCtx: RunContext = {
    ...context.ctx,
    env: context.env as Record<string, string | undefined>,
  };

  const childResult = await runWorkflowFile({
    filePath: childPath,
    args: childArgs,
    ctx: childCtx,
    resume: childResume,
    approved: context.resumeApproved,
    _depth: context.depth,
  });

  if (childResult.status === 'needs_approval') {
    // Child halted — extract the child state key from the resume token
    const childPayload = childResult.requiresApproval?.resumeToken
      ? decodeResumeTokenInternal(childResult.requiresApproval.resumeToken)
      : null;

    return {
      halted: true,
      childStateKey: childPayload?.stateKey ?? '',
      childFilePath: childPath,
      approvalStepId: childPayload?.approvalStepId,
      requiresApproval: childResult.requiresApproval,
    };
  }

  // Child completed — map output to step result
  return { halted: false, stepResult: childOutputToStepResult(childPath, childResult) };
}

function childOutputToStepResult(stepId: string, childResult: WorkflowRunResult): WorkflowStepResult {
  const output = childResult.output;
  if (output.length === 0) {
    return { id: stepId, stdout: '', json: undefined };
  }
  const value = output.length === 1 ? output[0] : output;
  return {
    id: stepId,
    stdout: JSON.stringify(value),
    json: value,
  };
}

function decodeResumeTokenInternal(token: string): WorkflowResumePayload | null {
  try {
    return decodeToken(token) as WorkflowResumePayload | null;
  } catch {
    return null;
  }
}

export function parseLobsterRunCommand(command: string): {
  name?: string;
  file?: string;
  argsJson?: string;
} | null {
  const trimmed = command.trim();
  if (!trimmed.startsWith('lobster.run')) return null;
  // Must be followed by end-of-string or whitespace
  if (trimmed.length > 'lobster.run'.length && !/\s/.test(trimmed['lobster.run'.length])) return null;

  const rest = trimmed.slice('lobster.run'.length).trim();

  let name: string | undefined;
  let file: string | undefined;
  let argsJson: string | undefined;

  // Parse --name <value>
  const nameMatch = rest.match(/(?:^|\s)--name\s+([^\s]+)/);
  if (nameMatch) name = nameMatch[1];

  // Parse --file <value>
  const fileMatch = rest.match(/(?:^|\s)--file\s+([^\s]+)/);
  if (fileMatch) file = fileMatch[1];

  // Parse --args-json '<json>' or --args-json <json>
  const argsJsonMatch = rest.match(/(?:^|\s)--args-json\s+'([^']*)'/) ?? rest.match(/(?:^|\s)--args-json\s+(\S+)/);
  if (argsJsonMatch) argsJson = argsJsonMatch[1];

  if (name && file) {
    throw new Error('lobster.run: --name and --file are mutually exclusive');
  }
  if (!name && !file) {
    throw new Error('lobster.run: one of --name or --file is required');
  }

  return { name, file, argsJson };
}

export async function resolveWorkflowByName(
  name: string,
  parentFilePath: string,
  workflowPath: string | undefined,
  cwd: string | undefined,
): Promise<string> {
  const extensions = ['.lobster', '.yaml', '.yml', '.json'];
  const dirs = [
    path.dirname(parentFilePath),
    ...(workflowPath ? workflowPath.split(':') : []),
    ...(cwd ? [cwd] : []),
  ];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      try {
        await fsp.access(candidate);
        return candidate;
      } catch { /* continue */ }
    }
  }
  throw new Error(`Workflow not found: ${name}`);
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
