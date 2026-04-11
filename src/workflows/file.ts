import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PassThrough } from 'node:stream';

import { parsePipeline } from '../parser.js';
import { runPipeline } from '../runtime.js';
import { encodeToken, decodeToken } from '../token.js';
import { createApprovalIndex, deleteStateJson, readStateJson, writeStateJson } from '../state/store.js';
import { readLineFromStream } from '../read_line.js';
import { resolveInlineShellCommand } from '../shell.js';
import { sharedAjv } from '../validation.js';
import { CostTracker } from '../core/cost_tracker.js';
import type { CostLimit, CostSummary } from '../core/cost_tracker.js';
import { withRetry, resolveRetryConfig } from '../core/retry.js';
import type { RetryConfig } from '../core/retry.js';

export type WorkflowFile = {
  name?: string;
  description?: string;
  args?: Record<string, { default?: unknown; description?: string }>;
  env?: Record<string, string>;
  cwd?: string;
  steps: WorkflowStep[];
  cost_limit?: CostLimit;
};

export type ParallelBranch = {
  id: string;
  run?: string;
  command?: string;
  pipeline?: string;
  env?: Record<string, string>;
  cwd?: string;
  stdin?: unknown;
};

export type ParallelConfig = {
  wait?: 'all' | 'any';
  timeout_ms?: number;
  branches: ParallelBranch[];
};

export type WorkflowStep = {
  id: string;
  command?: string;
  run?: string;
  pipeline?: string;
  workflow?: string;
  workflow_args?: Record<string, unknown>;
  env?: Record<string, string>;
  cwd?: string;
  stdin?: unknown;
  approval?: WorkflowApproval;
  input?: WorkflowInputRequest;
  condition?: unknown;
  when?: unknown;
  parallel?: ParallelConfig;
  for_each?: string;
  item_var?: string;
  index_var?: string;
  batch_size?: number;
  pause_ms?: number;
  steps?: WorkflowStep[];
  timeout_ms?: number;
  on_error?: 'stop' | 'continue' | 'skip_rest';
  retry?: {
    max?: number;
    backoff?: 'fixed' | 'exponential';
    delay_ms?: number;
    max_delay_ms?: number;
    jitter?: boolean;
  };
};

export type WorkflowApproval =
  | boolean
  | 'required'
  | string
  | {
    prompt?: string;
    items?: unknown[];
    preview?: string;
    initiated_by?: string;
    initiatedBy?: string;
    required_approver?: string;
    requiredApprover?: string;
    require_different_approver?: boolean;
    requireDifferentApprover?: boolean;
  };

type WorkflowApprovalIdentity = {
  initiatedBy?: string;
  requiredApprover?: string;
  requireDifferentApprover?: boolean;
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
  initiatedBy?: string;
  approvedBy?: string;
  subject?: unknown;
  response?: unknown;
  skipped?: boolean;
  error?: boolean;
  errorMessage?: string;
};

export type WorkflowRunResult = {
  status: 'ok' | 'needs_approval' | 'needs_input' | 'cancelled';
  output: unknown[];
  requiresApproval?: {
    type: 'approval_request';
    prompt: string;
    items: unknown[];
    preview?: string;
    initiatedBy?: string;
    requiredApprover?: string;
    requireDifferentApprover?: boolean;
    resumeToken?: string;
    approvalId?: string;
  };
  requiresInput?: {
    type: 'input_request';
    prompt: string;
    responseSchema: unknown;
    defaults?: unknown;
    subject?: unknown;
    resumeToken?: string;
  };
  _meta?: {
    cost?: CostSummary;
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
  _activeWorkflows?: Set<string>;
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
  approvalIdentity?: WorkflowApprovalIdentity;
  inputStepId?: string;
  inputSchema?: unknown;
  inputSubject?: unknown;
};

type WorkflowResumeState = {
  filePath: string;
  resumeAtIndex: number;
  steps: Record<string, WorkflowStepResult>;
  args: Record<string, unknown>;
  approvalStepId?: string;
  approvalIdentity?: WorkflowApprovalIdentity;
  inputStepId?: string;
  inputSchema?: unknown;
  inputSubject?: unknown;
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

  const costLimit = (parsed as WorkflowFile).cost_limit;
  if (costLimit !== undefined) {
    if (!costLimit || typeof costLimit !== 'object' || Array.isArray(costLimit)) {
      throw new Error('Workflow cost_limit must be an object');
    }
    if (!Number.isFinite(Number(costLimit.max_usd)) || Number(costLimit.max_usd) < 0) {
      throw new Error('Workflow cost_limit.max_usd must be a non-negative number');
    }
    if (costLimit.action !== undefined && costLimit.action !== 'warn' && costLimit.action !== 'stop') {
      throw new Error('Workflow cost_limit.action must be "warn" or "stop"');
    }
  }

  const seen = new Set<string>();
  for (const step of steps) {
    if (!step || typeof step !== 'object') {
      throw new Error('Workflow step must be an object');
    }
    if (!step.id || typeof step.id !== 'string') {
      throw new Error('Workflow step requires an id');
    }
    if (step.workflow !== undefined && typeof step.workflow !== 'string') {
      throw new Error(`Workflow step ${step.id} workflow must be a string (file path)`);
    }
    if (typeof step.workflow === 'string' && !step.workflow.trim()) {
      throw new Error(`Workflow step ${step.id} workflow path cannot be blank`);
    }
    if (step.workflow_args !== undefined) {
      if (!step.workflow_args || typeof step.workflow_args !== 'object' || Array.isArray(step.workflow_args)) {
        throw new Error(`Workflow step ${step.id} workflow_args must be a plain object`);
      }
    }
    if (step.parallel !== undefined && (!step.parallel || typeof step.parallel !== 'object' || Array.isArray(step.parallel))) {
      throw new Error(`Workflow step ${step.id} parallel must be an object`);
    }
    const isParallel = Boolean(step.parallel && typeof step.parallel === 'object' && !Array.isArray(step.parallel));
    if (isParallel) {
      const parallel = step.parallel as ParallelConfig;
      if (!Array.isArray(parallel.branches) || parallel.branches.length === 0) {
        throw new Error(`Workflow step ${step.id} parallel requires a non-empty branches array`);
      }
      if (parallel.wait !== undefined && parallel.wait !== 'all' && parallel.wait !== 'any') {
        throw new Error(`Workflow step ${step.id} parallel wait must be "all" or "any"`);
      }
      if (
        parallel.timeout_ms !== undefined
        && (
          typeof parallel.timeout_ms !== 'number'
          || !Number.isFinite(parallel.timeout_ms)
          || !Number.isInteger(parallel.timeout_ms)
          || parallel.timeout_ms < 1
          || parallel.timeout_ms > 2_147_483_647
        )
      ) {
        throw new Error(`Workflow step ${step.id} parallel timeout_ms must be a positive integer between 1 and 2147483647`);
      }

      const branchIds = new Set<string>();
      for (const branch of parallel.branches) {
        if (!branch || typeof branch !== 'object') {
          throw new Error(`Workflow step ${step.id} parallel branches must be objects`);
        }
        if (!branch.id || typeof branch.id !== 'string') {
          throw new Error(`Workflow step ${step.id} parallel branch requires an id`);
        }
        if (branch.id === step.id) {
          throw new Error(`Workflow step ${step.id} parallel branch id cannot match the step id`);
        }
        if (branchIds.has(branch.id)) {
          throw new Error(`Workflow step ${step.id} duplicate parallel branch id: ${branch.id}`);
        }
        if (seen.has(branch.id)) {
          throw new Error(`Duplicate workflow id across steps/parallel branches: ${branch.id}`);
        }
        branchIds.add(branch.id);
        const branchShell = typeof branch.run === 'string' ? branch.run : branch.command;
        const branchPipeline = typeof branch.pipeline === 'string' ? branch.pipeline : undefined;
        const branchExecCount = Number(Boolean(branchShell)) + Number(Boolean(branchPipeline));
        if (branchExecCount === 0) {
          throw new Error(`Workflow step ${step.id} parallel branch ${branch.id} requires run, command, or pipeline`);
        }
        if (branchExecCount > 1) {
          throw new Error(`Workflow step ${step.id} parallel branch ${branch.id} can only define one of run, command, or pipeline`);
        }
        if (branch.run !== undefined && typeof branch.run !== 'string') {
          throw new Error(`Workflow step ${step.id} parallel branch ${branch.id} run must be a string`);
        }
        if (branch.command !== undefined && typeof branch.command !== 'string') {
          throw new Error(`Workflow step ${step.id} parallel branch ${branch.id} command must be a string`);
        }
        if (branch.pipeline !== undefined && typeof branch.pipeline !== 'string') {
          throw new Error(`Workflow step ${step.id} parallel branch ${branch.id} pipeline must be a string`);
        }
      }
    }
    if (step.for_each !== undefined && typeof step.for_each !== 'string') {
      throw new Error(`Workflow step ${step.id} for_each must be a string (step reference expression)`);
    }
    const isForEach = typeof step.for_each === 'string';
    if (isForEach) {
      if (!Array.isArray(step.steps) || step.steps.length === 0) {
        throw new Error(`Workflow step ${step.id} for_each requires a non-empty steps array`);
      }
      if (
        step.batch_size !== undefined
        && (
          typeof step.batch_size !== 'number'
          || !Number.isInteger(step.batch_size)
          || step.batch_size < 1
        )
      ) {
        throw new Error(`Workflow step ${step.id} batch_size must be a positive integer`);
      }
      if (
        step.pause_ms !== undefined
        && (
          typeof step.pause_ms !== 'number'
          || !Number.isFinite(step.pause_ms)
          || step.pause_ms < 0
        )
      ) {
        throw new Error(`Workflow step ${step.id} pause_ms must be a finite non-negative number`);
      }
      if (isApprovalStep(step.approval)) {
        throw new Error(`Workflow step ${step.id} for_each steps cannot define approval (use a separate step after the loop)`);
      }
      if (isInputStep(step.input)) {
        throw new Error(`Workflow step ${step.id} for_each steps cannot define input (use a separate step after the loop)`);
      }
      if (step.stdin !== undefined && step.stdin !== null) {
        throw new Error(`Workflow step ${step.id} for_each steps cannot define stdin (loop input comes from the for_each expression)`);
      }
      const loopShell = typeof step.run === 'string' ? step.run : step.command;
      const loopPipeline = typeof step.pipeline === 'string' ? step.pipeline : undefined;
      if (loopShell || loopPipeline || step.workflow || step.parallel) {
        throw new Error(`Workflow step ${step.id} for_each cannot also define run, command, pipeline, workflow, or parallel`);
      }
      if (step.item_var !== undefined && typeof step.item_var !== 'string') {
        throw new Error(`Workflow step ${step.id} item_var must be a string`);
      }
      if (step.index_var !== undefined && typeof step.index_var !== 'string') {
        throw new Error(`Workflow step ${step.id} index_var must be a string`);
      }
      const loopItemVar = step.item_var ?? 'item';
      const loopIndexVar = step.index_var ?? 'index';
      if (loopItemVar === loopIndexVar) {
        throw new Error(`Workflow step ${step.id} item_var and index_var cannot be the same`);
      }
      const subStepIds = new Set<string>();
      for (const sub of step.steps) {
        if (!sub || typeof sub !== 'object' || !sub.id || typeof sub.id !== 'string') {
          throw new Error(`Workflow step ${step.id} for_each sub-step requires an id`);
        }
        if (sub.id === loopItemVar || sub.id === loopIndexVar) {
          throw new Error(`Workflow step ${step.id} for_each sub-step id '${sub.id}' conflicts with loop variable`);
        }
        if (subStepIds.has(sub.id)) {
          throw new Error(`Workflow step ${step.id} duplicate for_each sub-step id: ${sub.id}`);
        }
        subStepIds.add(sub.id);
        if (isApprovalStep(sub.approval) || isInputStep(sub.input)) {
          throw new Error(`Workflow step ${step.id} for_each sub-steps cannot contain approval or input steps`);
        }
        if (sub.run !== undefined && typeof sub.run !== 'string') {
          throw new Error(`Workflow step ${step.id} for_each sub-step ${sub.id} run must be a string`);
        }
        if (sub.command !== undefined && typeof sub.command !== 'string') {
          throw new Error(`Workflow step ${step.id} for_each sub-step ${sub.id} command must be a string`);
        }
        if (sub.pipeline !== undefined && typeof sub.pipeline !== 'string') {
          throw new Error(`Workflow step ${step.id} for_each sub-step ${sub.id} pipeline must be a string`);
        }
        if (sub.workflow || sub.parallel || sub.for_each) {
          throw new Error(`Workflow step ${step.id} for_each sub-step ${sub.id} cannot define workflow, parallel, or for_each`);
        }
        const subShell = typeof sub.run === 'string' && sub.run.trim()
          ? sub.run
          : (typeof sub.command === 'string' && sub.command.trim() ? sub.command : undefined);
        const subPipeline = typeof sub.pipeline === 'string' && sub.pipeline.trim()
          ? sub.pipeline
          : undefined;
        if (!subShell && !subPipeline) {
          throw new Error(`Workflow step ${step.id} for_each sub-step ${sub.id} requires run, command, or pipeline`);
        }
        if (Number(Boolean(subShell)) + Number(Boolean(subPipeline)) > 1) {
          throw new Error(`Workflow step ${step.id} for_each sub-step ${sub.id} can only define one of run, command, or pipeline`);
        }
      }
    }
    const shellCommand = typeof step.run === 'string' ? step.run : step.command;
    const pipeline = typeof step.pipeline === 'string' ? step.pipeline : undefined;
    const workflowRef = typeof step.workflow === 'string' && step.workflow.trim() ? step.workflow : undefined;
    const executionCount = Number(Boolean(shellCommand))
      + Number(Boolean(pipeline))
      + Number(Boolean(workflowRef))
      + Number(isParallel)
      + Number(isForEach);
    if (executionCount === 0 && !isApprovalStep(step.approval) && !isInputStep(step.input)) {
      throw new Error(`Workflow step ${step.id} requires run, command, pipeline, workflow, parallel, for_each, approval, or input`);
    }
    if (executionCount > 1) {
      throw new Error(`Workflow step ${step.id} can only define one of run, command, pipeline, workflow, parallel, or for_each`);
    }
    if (executionCount > 0 && isInputStep(step.input)) {
      throw new Error(`Workflow step ${step.id} input steps cannot define run, command, pipeline, workflow, parallel, or for_each`);
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
    if (step.input && (step.input.responseSchema === undefined || typeof step.input.responseSchema !== 'object')) {
      throw new Error(`Workflow step ${step.id} input.responseSchema must be an object`);
    }
    if (step.input) {
      try {
        sharedAjv.compile(step.input.responseSchema as any);
      } catch (err: any) {
        throw new Error(`Workflow step ${step.id} input.responseSchema is invalid: ${err?.message ?? String(err)}`);
      }
    }
    if (step.approval && typeof step.approval === 'object' && !Array.isArray(step.approval)) {
      const approval = step.approval as Record<string, unknown>;
      if (approval.initiated_by !== undefined && typeof approval.initiated_by !== 'string') {
        throw new Error(`Workflow step ${step.id} approval.initiated_by must be a string`);
      }
      if (approval.initiatedBy !== undefined && typeof approval.initiatedBy !== 'string') {
        throw new Error(`Workflow step ${step.id} approval.initiatedBy must be a string`);
      }
      if (approval.required_approver !== undefined && typeof approval.required_approver !== 'string') {
        throw new Error(`Workflow step ${step.id} approval.required_approver must be a string`);
      }
      if (approval.requiredApprover !== undefined && typeof approval.requiredApprover !== 'string') {
        throw new Error(`Workflow step ${step.id} approval.requiredApprover must be a string`);
      }
      if (
        approval.require_different_approver !== undefined
        && typeof approval.require_different_approver !== 'boolean'
      ) {
        throw new Error(`Workflow step ${step.id} approval.require_different_approver must be a boolean`);
      }
      if (
        approval.requireDifferentApprover !== undefined
        && typeof approval.requireDifferentApprover !== 'boolean'
      ) {
        throw new Error(`Workflow step ${step.id} approval.requireDifferentApprover must be a boolean`);
      }
    }
    if (
      step.timeout_ms !== undefined
      && (
        typeof step.timeout_ms !== 'number'
        || !Number.isFinite(step.timeout_ms)
        || !Number.isInteger(step.timeout_ms)
        || step.timeout_ms < 1
        || step.timeout_ms > 2_147_483_647
      )
    ) {
      throw new Error(`Workflow step ${step.id} timeout_ms must be a positive integer between 1 and 2147483647`);
    }
    if (
      step.on_error !== undefined
      && step.on_error !== 'stop'
      && step.on_error !== 'continue'
      && step.on_error !== 'skip_rest'
    ) {
      throw new Error(`Workflow step ${step.id} on_error must be "stop", "continue", or "skip_rest"`);
    }
    if (step.retry !== undefined) {
      if (!step.retry || typeof step.retry !== 'object' || Array.isArray(step.retry)) {
        throw new Error(`Workflow step ${step.id} retry must be an object`);
      }
      const r = step.retry;
      if (r.max !== undefined && (typeof r.max !== 'number' || !Number.isInteger(r.max) || r.max < 1)) {
        throw new Error(`Workflow step ${step.id} retry.max must be a positive integer`);
      }
      if (r.backoff !== undefined && r.backoff !== 'fixed' && r.backoff !== 'exponential') {
        throw new Error(`Workflow step ${step.id} retry.backoff must be "fixed" or "exponential"`);
      }
      if (r.delay_ms !== undefined && (typeof r.delay_ms !== 'number' || !Number.isFinite(r.delay_ms) || r.delay_ms < 0)) {
        throw new Error(`Workflow step ${step.id} retry.delay_ms must be a finite non-negative number`);
      }
      if (r.max_delay_ms !== undefined && (typeof r.max_delay_ms !== 'number' || !Number.isFinite(r.max_delay_ms) || r.max_delay_ms < 0)) {
        throw new Error(`Workflow step ${step.id} retry.max_delay_ms must be a finite non-negative number`);
      }
      if (r.jitter !== undefined && typeof r.jitter !== 'boolean') {
        throw new Error(`Workflow step ${step.id} retry.jitter must be a boolean`);
      }
    }
    if (seen.has(step.id)) {
      throw new Error(`Duplicate workflow step id: ${step.id}`);
    }
    if (isParallel) {
      const parallel = step.parallel as ParallelConfig;
      for (const branch of parallel.branches) {
        seen.add(branch.id);
      }
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
    ? await resolveWorkflowResumeStateKey(ctx.env, resume.stateKey)
    : null;
  const resumeState = resume?.stateKey
    ? await loadWorkflowResumeState(ctx.env, consumedResumeStateKey ?? resume.stateKey)
    : resume ?? null;
  if (resumeState?.approvalStepId && resumeState?.inputStepId) {
    throw new Error('Invalid workflow resume state');
  }

  if (resumeState?.approvalStepId) {
    if (response !== undefined) {
      throw new WorkflowResumeArgumentError('Workflow resume requires --approve yes|no for approval requests');
    }
    if (cancel !== true && typeof approved !== 'boolean') {
      throw new WorkflowResumeArgumentError('Workflow resume requires --approve yes|no for approval requests');
    }
    if (cancel === true || approved === false) {
      if (consumedResumeStateKey) {
        await deleteStateJson({ env: ctx.env, key: consumedResumeStateKey });
      }
      return { status: 'cancelled', output: [] };
    }
  }

  if (resumeState?.inputStepId && cancel === true) {
    if (consumedResumeStateKey) {
      await deleteStateJson({ env: ctx.env, key: consumedResumeStateKey });
    }
    return { status: 'cancelled', output: [] };
  }

  const resolvedFilePath = filePath ?? resumeState?.filePath;
  if (!resolvedFilePath) {
    throw new Error('Workflow file path required');
  }
  if (!ctx._activeWorkflows) {
    ctx._activeWorkflows = new Set<string>();
  }
  const canonicalFilePath = await fsp.realpath(resolvedFilePath);
  ctx._activeWorkflows.add(canonicalFilePath);
  try {
    const workflow = await loadWorkflowFile(resolvedFilePath);
    const resolvedArgs = resolveWorkflowArgs(workflow.args, args ?? resumeState?.args);
    const steps = workflow.steps;
    const stepIndexById = new Map(steps.map((step, idx) => [step.id, idx]));
    const results: Record<string, WorkflowStepResult> = resumeState?.steps
      ? cloneResults(resumeState.steps)
      : {};
    const startIndex = resumeState?.resumeAtIndex ?? 0;

    if (resumeState?.approvalStepId && typeof approved === 'boolean') {
      const previous = results[resumeState.approvalStepId] ?? { id: resumeState.approvalStepId };
      const approvedBy = String(ctx.env.LOBSTER_APPROVAL_APPROVED_BY ?? '').trim() || undefined;
      if (approved === true) {
        enforceApprovalIdentity({
          stepId: resumeState.approvalStepId,
          identity: resumeState.approvalIdentity,
          approvedBy,
        });
      }
      previous.approved = approved;
      if (approvedBy) previous.approvedBy = approvedBy;
      results[resumeState.approvalStepId] = previous;
    }

    if (resumeState?.inputStepId) {
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
      results[resumeState.inputStepId] = previous;
    }

    if (ctx.dryRun) {
      return dryRunWorkflow({ steps, resolvedArgs, results, startIndex, ctx });
    }

    const costTracker = new CostTracker(CostTracker.parsePricingFromEnv(ctx.env));
    let lastStepId: string | null = resumeState?.inputStepId ?? findLastCompletedStepId(steps, results);

    for (let idx = startIndex; idx < steps.length; idx++) {
      const step = steps[idx];

    if (!evaluateCondition(step.when ?? step.condition, results)) {
      results[step.id] = { id: step.id, skipped: true };
      continue;
    }

    if (isInputStep(step.input)) {
      const subject = resolveInputSubject({
        step,
        args: resolvedArgs,
        results,
        lastStepId,
      });

      if (ctx.mode === 'tool' || !isInteractive(ctx.stdin)) {
        const inputRequest = buildNeedsInputRequest({
          stepId: step.id,
          prompt: step.input.prompt,
          responseSchema: step.input.responseSchema,
          defaults: step.input.defaults,
          subject,
          maxEnvelopeBytes: resolveToolEnvelopeMaxBytes(ctx.env),
        });
        const stateKey = await saveWorkflowResumeState(ctx.env, {
          filePath: resolvedFilePath,
          resumeAtIndex: idx + 1,
          steps: results,
          args: resolvedArgs,
          inputStepId: step.id,
          inputSchema: step.input.responseSchema,
          // Preserve the full resolved subject for resume semantics; the tool
          // envelope may contain a truncated preview to stay within size limits.
          inputSubject: subject,
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
      continue;
    }

    if (typeof step.for_each === 'string' && Array.isArray(step.steps)) {
      const itemsRef = resolveInputValue(step.for_each, resolvedArgs, results);
      if (!Array.isArray(itemsRef)) {
        throw new Error(`Workflow step ${step.id} for_each: expected array, got ${typeof itemsRef}`);
      }

      const itemVar = step.item_var ?? 'item';
      const indexVar = step.index_var ?? 'index';
      const batchSize = step.batch_size ?? 1;
      const iterationResults: unknown[] = [];

      for (let itemIdx = 0; itemIdx < itemsRef.length; itemIdx++) {
        if (step.pause_ms && itemIdx > 0 && itemIdx % batchSize === 0) {
          await abortableSleep(step.pause_ms, ctx.signal);
        }

        const item = itemsRef[itemIdx];
        const scopedResults: Record<string, WorkflowStepResult> = { ...results };
        scopedResults[itemVar] = {
          id: itemVar,
          json: item,
          stdout: typeof item === 'string' ? item : JSON.stringify(item),
        };
        scopedResults[indexVar] = {
          id: indexVar,
          json: itemIdx,
          stdout: String(itemIdx),
        };

        for (const subStep of step.steps) {
          if (!evaluateCondition(subStep.when ?? subStep.condition, scopedResults)) {
            scopedResults[subStep.id] = { id: subStep.id, skipped: true };
            continue;
          }

          const loopEnvBase = mergeEnv(ctx.env, workflow.env, step.env, resolvedArgs, scopedResults);
          const subEnv = subStep.env
            ? mergeEnv(loopEnvBase, undefined, subStep.env, resolvedArgs, scopedResults)
            : loopEnvBase;
          const subCwd = resolveCwd(subStep.cwd ?? step.cwd ?? workflow.cwd, resolvedArgs) ?? ctx.cwd;
          const subExecution = getStepExecution(subStep);

          let subResult: WorkflowStepResult;
          if (subExecution.kind === 'shell') {
            const command = resolveTemplate(subExecution.value, resolvedArgs, scopedResults);
            const stdinValue = resolveShellStdin(subStep.stdin, resolvedArgs, scopedResults);
            const { stdout } = await runShellCommand({ command, stdin: stdinValue, env: subEnv, cwd: subCwd, signal: ctx.signal });
            subResult = { id: subStep.id, stdout, json: parseJson(stdout) };
          } else if (subExecution.kind === 'pipeline') {
            if (!ctx.registry) {
              throw new Error(`Workflow step ${step.id} for_each sub-step ${subStep.id} requires a command registry for pipeline execution`);
            }
            const pipelineText = resolveTemplate(subExecution.value, resolvedArgs, scopedResults);
            const inputValue = resolveInputValue(subStep.stdin, resolvedArgs, scopedResults);
            subResult = await runPipelineStep({
              stepId: subStep.id,
              pipelineText,
              inputValue,
              ctx,
              env: subEnv,
              cwd: subCwd,
            });
          } else {
            const inputValue = resolveInputValue(subStep.stdin, resolvedArgs, scopedResults);
            subResult = createSyntheticStepResult(subStep.id, inputValue);
          }

          scopedResults[subStep.id] = subResult;
          trackStepCost(costTracker, `${step.id}.${subStep.id}`, subResult);
          if (workflow.cost_limit) {
            costTracker.checkLimit(workflow.cost_limit, ctx.stderr);
          }
        }

        const iterResult: Record<string, unknown> = { [itemVar]: item, [indexVar]: itemIdx };
        for (const subStep of step.steps) {
          const subResult = scopedResults[subStep.id];
          if (subResult && !subResult.skipped) {
            iterResult[subStep.id] = subResult.json !== undefined ? subResult.json : subResult.stdout;
          }
        }
        iterationResults.push(iterResult);
      }

      const loopResult: WorkflowStepResult = {
        id: step.id,
        json: iterationResults,
        stdout: JSON.stringify(iterationResults),
      };
      results[step.id] = loopResult;
      lastStepId = step.id;
      trackStepCost(costTracker, step.id, loopResult);
      if (workflow.cost_limit) {
        costTracker.checkLimit(workflow.cost_limit, ctx.stderr);
      }
      continue;
    }

    const env = mergeEnv(ctx.env, workflow.env, step.env, resolvedArgs, results);
    const cwd = resolveCwd(step.cwd ?? workflow.cwd, resolvedArgs) ?? ctx.cwd;
    const execution = getStepExecution(step);
    const retryConfig = resolveRetryConfig(step.retry);

    const executeStepAttempt = async (): Promise<{
      result: WorkflowStepResult;
      parallelBranchResults: Record<string, WorkflowStepResult> | null;
    }> => {
      // Combine external cancellation and optional per-step timeout into one signal.
      let stepSignal: AbortSignal | undefined = ctx.signal;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (step.timeout_ms) {
        const timeoutController = new AbortController();
        timeoutId = setTimeout(
          () => timeoutController.abort(new Error(`Step '${step.id}' timed out after ${step.timeout_ms}ms`)),
          step.timeout_ms,
        );
        stepSignal = ctx.signal
          ? AbortSignal.any([ctx.signal, timeoutController.signal])
          : timeoutController.signal;
      }

      let result: WorkflowStepResult;
      let parallelBranchResults: Record<string, WorkflowStepResult> | null = null;
      try {
        if (execution.kind === 'parallel') {
          const parallel = execution.value;
          const wait = parallel.wait ?? 'all';
          const branchAbortController = new AbortController();
          const branchSignal = stepSignal
            ? AbortSignal.any([stepSignal, branchAbortController.signal])
            : branchAbortController.signal;
          const shouldForceKill = Boolean(step.timeout_ms || parallel.timeout_ms);
          const runBranch = async (branch: ParallelBranch): Promise<{ branchId: string; result: WorkflowStepResult }> => {
            const mergedBranchEnv = { ...(step.env ?? {}), ...(branch.env ?? {}) };
            const branchEnv = mergeEnv(ctx.env, workflow.env, mergedBranchEnv, resolvedArgs, results);
            const branchCwd = resolveCwd(branch.cwd ?? step.cwd ?? workflow.cwd, resolvedArgs) ?? ctx.cwd;
            const branchShell = typeof branch.run === 'string' ? branch.run : branch.command;
            const branchExec = typeof branch.pipeline === 'string' && branch.pipeline.trim()
              ? { kind: 'pipeline' as const, value: branch.pipeline }
              : (typeof branchShell === 'string' && branchShell.trim()
                ? { kind: 'shell' as const, value: branchShell }
                : { kind: 'none' as const });

            if (branchExec.kind === 'shell') {
              const command = resolveTemplate(branchExec.value, resolvedArgs, results);
              const stdinValue = resolveShellStdin(branch.stdin, resolvedArgs, results);
              const { stdout } = await runShellCommand({
                command,
                stdin: stdinValue,
                env: branchEnv,
                cwd: branchCwd,
                signal: branchSignal,
                ...(shouldForceKill ? { killSignal: 'SIGKILL' as NodeJS.Signals } : {}),
              });
              return { branchId: branch.id, result: { id: branch.id, stdout, json: parseJson(stdout) } };
            }

            if (branchExec.kind === 'pipeline') {
              if (!ctx.registry) {
                throw new Error(`Parallel branch ${branch.id} requires a command registry for pipeline execution`);
              }
              const pipelineText = resolveTemplate(branchExec.value, resolvedArgs, results);
              const inputValue = resolveInputValue(branch.stdin, resolvedArgs, results);
              const branchResult = await runPipelineStep({
                stepId: branch.id,
                pipelineText,
                inputValue,
                ctx: { ...ctx, signal: branchSignal },
                env: branchEnv,
                cwd: branchCwd,
              });
              return { branchId: branch.id, result: branchResult };
            }

            return { branchId: branch.id, result: { id: branch.id } };
          };

          let parallelTimeoutId: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = parallel.timeout_ms
            ? new Promise<never>((_resolve, reject) => {
              parallelTimeoutId = setTimeout(() => {
                branchAbortController.abort();
                reject(new Error(`Parallel step ${step.id} timed out after ${parallel.timeout_ms}ms`));
              }, parallel.timeout_ms);
            })
            : null;

          try {
            if (wait === 'any') {
              const branchPromises = parallel.branches.map((branch) => runBranch(branch));
              const winner = await (timeoutPromise
                ? Promise.race([...branchPromises, timeoutPromise])
                : Promise.race(branchPromises)) as { branchId: string; result: WorkflowStepResult };
              parallelBranchResults = { [winner.branchId]: winner.result };
              branchAbortController.abort();
            } else {
              const branchPromises = parallel.branches.map((branch) => runBranch(branch));
              const settled = await (timeoutPromise
                ? Promise.race([Promise.allSettled(branchPromises), timeoutPromise])
                : Promise.allSettled(branchPromises)) as PromiseSettledResult<{ branchId: string; result: WorkflowStepResult }>[];

              parallelBranchResults = {};
              for (const entry of settled) {
                if (entry.status === 'rejected') {
                  throw new Error(`Parallel branch failed: ${entry.reason?.message ?? String(entry.reason)}`);
                }
                parallelBranchResults[entry.value.branchId] = entry.value.result;
              }
            }
          } finally {
            if (parallelTimeoutId !== undefined) clearTimeout(parallelTimeoutId);
          }

          const merged: Record<string, unknown> = {};
          for (const [branchId, branchResult] of Object.entries(parallelBranchResults ?? {})) {
            merged[branchId] = branchResult.json;
          }
          result = {
            id: step.id,
            json: merged,
            stdout: wait === 'any'
              ? (Object.values(parallelBranchResults ?? {})[0]?.stdout ?? '')
              : JSON.stringify(merged),
          };
        } else if (execution.kind === 'workflow') {
          const workflowPath = resolveTemplate(execution.value, resolvedArgs, results);
          const resolvedWorkflowPath = path.isAbsolute(workflowPath)
            ? workflowPath
            : path.resolve(path.dirname(resolvedFilePath), workflowPath);
          const activeWorkflows = ctx._activeWorkflows ?? new Set<string>();
          let canonicalWorkflowPath: string;
          try {
            canonicalWorkflowPath = await fsp.realpath(resolvedWorkflowPath);
          } catch {
            throw new Error(`Workflow step ${step.id} workflow file not found: ${resolvedWorkflowPath}`);
          }
          if (activeWorkflows.has(canonicalWorkflowPath)) {
            throw new Error(`Workflow step ${step.id} creates a cycle: ${canonicalWorkflowPath} is already being executed`);
          }
          const childActive = new Set(activeWorkflows);
          childActive.add(canonicalWorkflowPath);
          const subArgs = resolveWorkflowStepArgs(step.workflow_args, resolvedArgs, results);
          const subResult = await runWorkflowFile({
            filePath: resolvedWorkflowPath,
            args: subArgs,
            ctx: { ...ctx, env, cwd, _activeWorkflows: childActive },
          });
          if (subResult.status === 'needs_approval' || subResult.status === 'needs_input') {
            const resumeToken = subResult.requiresApproval?.resumeToken ?? subResult.requiresInput?.resumeToken;
            if (resumeToken) {
              try {
                const decoded = decodeToken(resumeToken) as { stateKey?: string } | null;
                if (decoded?.stateKey) {
                  await deleteStateJson({ env: ctx.env, key: decoded.stateKey }).catch(() => {});
                }
              } catch {
                // best-effort cleanup
              }
            }
            throw new Error(
              `Workflow step ${step.id} sub-workflow halted for ${
                subResult.status === 'needs_approval' ? 'approval' : 'input'
              }. Sub-workflow approval/input gates are not supported in composition.`,
            );
          }
          const json = subResult.output.length === 1 ? subResult.output[0] : subResult.output;
          const stdout = subResult.output.length ? serializeValueForStdout(json) : '';
          result = { id: step.id, stdout, json };
        } else if (execution.kind === 'shell') {
          const command = resolveTemplate(execution.value, resolvedArgs, results);
          const stdinValue = resolveShellStdin(step.stdin, resolvedArgs, results);
          const { stdout } = await runShellCommand({
            command,
            stdin: stdinValue,
            env,
            cwd,
            signal: stepSignal,
            ...(step.timeout_ms ? { killSignal: 'SIGKILL' as NodeJS.Signals } : {}),
          });
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
            ctx: { ...ctx, signal: stepSignal },
            env,
            cwd,
          });
        } else {
          const inputValue = resolveInputValue(step.stdin, resolvedArgs, results);
          result = createSyntheticStepResult(step.id, inputValue);
        }

        return { result, parallelBranchResults };
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    };

    let result: WorkflowStepResult;
    let parallelBranchResults: Record<string, WorkflowStepResult> | null = null;
    try {
      const attemptResult = retryConfig.max > 1
        ? await withRetry(executeStepAttempt, retryConfig, {
          signal: ctx.signal,
          shouldRetry: (error) => {
            const message = error?.message ?? String(error);
            return !/halted (for approval inside|before completion at) pipeline/.test(message);
          },
          onRetry: (attempt, error, delayMs) => {
            ctx.stderr.write(
              `[RETRY] Step '${step.id}' failed (attempt ${attempt}/${retryConfig.max}): ${error?.message ?? String(error)}. Retrying in ${delayMs}ms...\n`,
            );
          },
        })
        : await executeStepAttempt();
      result = attemptResult.result;
      parallelBranchResults = attemptResult.parallelBranchResults;
    } catch (err: any) {
      if (ctx.signal?.aborted && (err?.name === 'AbortError' || err?.code === 'ABORT_ERR')) {
        throw err;
      }
      if (err?.message && /halted (for approval inside|before completion at) pipeline/.test(err.message)) {
        throw err;
      }

      const isAbortErr = err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
      const isTimeout = Boolean(step.timeout_ms) && isAbortErr;
      const errorMessage = isTimeout
        ? `Step '${step.id}' timed out after ${step.timeout_ms}ms`
        : (err?.message ?? String(err));
      const policy = step.on_error ?? 'stop';

      if (policy === 'stop') {
        throw isTimeout ? new Error(errorMessage) : err;
      }

      results[step.id] = {
        id: step.id,
        error: true,
        errorMessage,
      };

      if (policy === 'skip_rest') {
        break;
      }
      continue;
    }

    if (parallelBranchResults) {
      for (const [branchId, branchResult] of Object.entries(parallelBranchResults)) {
        results[branchId] = branchResult;
        trackStepCost(costTracker, branchId, branchResult);
      }
    }
    results[step.id] = result;
    lastStepId = step.id;

    trackStepCost(costTracker, step.id, result);
    if (workflow.cost_limit) {
      costTracker.checkLimit(workflow.cost_limit, ctx.stderr);
    }

    if (isApprovalStep(step.approval)) {
      const approval = extractApprovalRequest(step, results[step.id], ctx.env);
      const approvalIdentity = approvalIdentityFromRequest(approval);
      if (approvalIdentity.initiatedBy) {
        results[step.id].initiatedBy = approvalIdentity.initiatedBy;
      }

      if (ctx.mode === 'tool' || !isInteractive(ctx.stdin)) {
        const stateKey = await saveWorkflowResumeState(ctx.env, {
          filePath: resolvedFilePath,
          resumeAtIndex: idx + 1,
          steps: results,
          args: resolvedArgs,
          approvalStepId: step.id,
          approvalIdentity,
          createdAt: new Date().toISOString(),
        });

        let approvalId: string;
        try {
          approvalId = await createApprovalIndex({ env: ctx.env, stateKey });
        } catch (err) {
          await deleteStateJson({ env: ctx.env, key: stateKey }).catch(() => {});
          throw err;
        }

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
            approvalId,
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
      const approvedBy = String(ctx.env.LOBSTER_APPROVAL_APPROVED_BY ?? '').trim() || undefined;
      enforceApprovalIdentity({
        stepId: step.id,
        identity: approvalIdentity,
        approvedBy,
      });
      results[step.id].approved = true;
      if (approvedBy) results[step.id].approvedBy = approvedBy;
    }
  }

    const output = lastStepId ? toOutputItems(results[lastStepId]) : [];
    if (consumedResumeStateKey) {
      await deleteStateJson({ env: ctx.env, key: consumedResumeStateKey });
    }
    const runResult: WorkflowRunResult = { status: 'ok', output };
    if (costTracker.hasUsage()) {
      runResult._meta = { cost: costTracker.getSummary() };
    }
    return runResult;
  } finally {
    ctx._activeWorkflows?.delete(canonicalFilePath);
  }
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

function hasDeferredDryRunStageName(input: string) {
  return /\$[A-Za-z0-9_-]+\.(stdout|json)/.test(input);
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

    if (isInputStep(step.input)) {
      lines.push(`  ${num}. ${step.id}  [input]`);
      lines.push(`     prompt: ${step.input.prompt}`);
      lines.push(`     [input required]`);
      results[step.id] = { id: step.id, response: { pending: true } };
      continue;
    }

    if (typeof step.for_each === 'string' && Array.isArray(step.steps)) {
      lines.push(`  ${num}. ${step.id}  [for_each]`);
      const forEachRef = step.for_each;
      const forEachNote = dryRunTemplateNote(forEachRef);
      lines.push(`     for_each: ${forEachRef}${forEachNote ? `  ${forEachNote}` : ''}`);
      if (forEachRef.trim().startsWith('$')) {
        try {
          resolveInputValue(forEachRef, resolvedArgs, results);
        } catch (err: any) {
          throw new Error(`Workflow step ${step.id} for_each: ${err?.message ?? String(err)}`);
        }
      }
      const dryItemVar = step.item_var ?? 'item';
      const dryIndexVar = step.index_var ?? 'index';
      lines.push(`     item_var: ${dryItemVar}, index_var: ${dryIndexVar}`);
      if (step.batch_size) lines.push(`     batch_size: ${step.batch_size}`);
      if (step.pause_ms) lines.push(`     pause_ms: ${step.pause_ms}`);
      lines.push(`     sub-steps: ${step.steps.length}`);

      const loopScopedResults = { ...results };
      loopScopedResults[dryItemVar] = { id: dryItemVar, json: { _placeholder: true } };
      loopScopedResults[dryIndexVar] = { id: dryIndexVar, json: 0 };
      for (let subIdx = 0; subIdx < step.steps.length; subIdx++) {
        const sub = step.steps[subIdx];
        if (!evaluateCondition(sub.when ?? sub.condition, loopScopedResults)) {
          lines.push(`       ${subIdx + 1}. ${sub.id}  [skipped — condition: false]`);
          loopScopedResults[sub.id] = { id: sub.id, skipped: true };
          continue;
        }
        if (sub.stdin !== undefined && sub.stdin !== null) {
          try {
            resolveInputValue(sub.stdin, resolvedArgs, loopScopedResults);
          } catch (err: any) {
            throw new Error(`Workflow step ${step.id} for_each sub-step ${sub.id} stdin: ${err?.message ?? String(err)}`);
          }
        }
        const subExec = getStepExecution(sub);
        if (subExec.kind === 'shell') {
          const command = resolveDryRunTemplate(subExec.value, resolvedArgs, loopScopedResults);
          lines.push(`       ${subIdx + 1}. ${sub.id}  [shell] run: ${command}`);
        } else if (subExec.kind === 'pipeline') {
          if (!ctx.registry) {
            throw new Error(`Workflow step ${step.id} for_each sub-step ${sub.id} requires a command registry for pipeline execution`);
          }
          const pipelineText = resolveDryRunTemplate(subExec.value, resolvedArgs, loopScopedResults);
          const stages = parsePipeline(pipelineText);
          for (const stage of stages) {
            if (hasDeferredDryRunStageName(stage.name)) continue;
            if (!ctx.registry.get(stage.name)) {
              throw new Error(`Workflow step ${step.id} for_each sub-step ${sub.id} pipeline: unknown command: ${stage.name}`);
            }
          }
          lines.push(`       ${subIdx + 1}. ${sub.id}  [pipeline] pipeline: ${pipelineText}`);
        } else {
          lines.push(`       ${subIdx + 1}. ${sub.id}  [no-op]`);
        }
        loopScopedResults[sub.id] = { id: sub.id };
      }
      results[step.id] = { id: step.id };
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

    if (execution.kind === 'parallel') {
      lines.push(`  ${num}. ${step.id}  [parallel]`);
      lines.push(`     wait: ${step.parallel?.wait ?? 'all'}`);
      if (step.parallel?.timeout_ms) {
        lines.push(`     timeout: ${step.parallel.timeout_ms}ms`);
      }
      for (const branch of step.parallel?.branches ?? []) {
        const branchShell = typeof branch.run === 'string' ? branch.run : branch.command;
        if (typeof branch.pipeline === 'string' && branch.pipeline.trim()) {
          const pipelineText = resolveDryRunTemplate(branch.pipeline, resolvedArgs, results);
          const pipelineNote = dryRunTemplateNote(pipelineText);
          if (!ctx.registry) {
            throw new Error(`Parallel branch ${branch.id} requires a command registry for pipeline execution`);
          }
          const stages = parsePipeline(pipelineText);
          for (const stage of stages) {
            if (hasDeferredDryRunStageName(stage.name)) continue;
            if (!ctx.registry.get(stage.name)) {
              throw new Error(`Parallel branch ${branch.id} pipeline references unknown command: ${stage.name}`);
            }
          }
          lines.push(`     branch ${branch.id}: [pipeline] ${pipelineText}${pipelineNote ? `  ${pipelineNote}` : ''}`);
        } else if (typeof branchShell === 'string' && branchShell.trim()) {
          const command = resolveDryRunTemplate(branchShell, resolvedArgs, results);
          const commandNote = dryRunTemplateNote(command);
          lines.push(`     branch ${branch.id}: [shell] ${command}${commandNote ? `  ${commandNote}` : ''}`);
        } else {
          lines.push(`     branch ${branch.id}: [no-op]`);
        }
        results[branch.id] = { id: branch.id };
      }
    } else if (execution.kind === 'workflow') {
      const workflowPath = resolveDryRunTemplate(execution.value, resolvedArgs, results);
      const pathNote = dryRunTemplateNote(workflowPath);
      lines.push(`  ${num}. ${step.id}  [workflow]`);
      lines.push(`     workflow: ${workflowPath}${pathNote ? `  ${pathNote}` : ''}`);
      if (step.workflow_args && typeof step.workflow_args === 'object') {
        const argKeys = Object.keys(step.workflow_args);
        if (argKeys.length) {
          lines.push(`     args: ${argKeys.join(', ')}`);
        }
      }
    } else if (execution.kind === 'shell') {
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
        if (hasDeferredDryRunStageName(stage.name)) {
          continue;
        }
        if (!ctx.registry.get(stage.name)) {
          throw new Error(`Workflow step ${step.id} pipeline references unknown command: ${stage.name}`);
        }
      }
      lines.push(`  ${num}. ${step.id}  [pipeline]`);
      lines.push(`     pipeline: ${pipelineText}${pipelineNote ? `  ${pipelineNote}` : ''}`);
      if (stages.some((stage) => hasDeferredDryRunStageName(stage.name))) {
        lines.push('     [command validation deferred — stage name depends on step output]');
      }
    } else {
      lines.push(`  ${num}. ${step.id}  [no-op]`);
    }

    if (stdinNote) lines.push(`     stdin: ${stdinNote}`);
    if (step.timeout_ms) lines.push(`     timeout: ${step.timeout_ms}ms`);
    if (step.on_error && step.on_error !== 'stop') lines.push(`     on_error: ${step.on_error}`);
    if (step.retry && typeof step.retry === 'object') {
      const rc = resolveRetryConfig(step.retry as RetryConfig);
      if (rc.max > 1) {
        lines.push(`     retry: up to ${rc.max} attempts, ${rc.backoff} backoff (base: ${rc.delay_ms}ms${rc.jitter ? ', jitter' : ''})`);
      }
    }
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

function alternateWorkflowResumeStateKey(stateKey: string): string | null {
  if (stateKey.includes('workflow-resume_')) {
    return stateKey.replace('workflow-resume_', 'workflow_resume_');
  }
  if (stateKey.includes('workflow_resume_')) {
    return stateKey.replace('workflow_resume_', 'workflow-resume_');
  }
  return null;
}

async function resolveWorkflowResumeStateKey(
  env: Record<string, string | undefined>,
  stateKey: string,
): Promise<string> {
  const stored = await readStateJson({ env, key: stateKey });
  if (stored && typeof stored === 'object') {
    return stateKey;
  }
  const altKey = alternateWorkflowResumeStateKey(stateKey);
  if (!altKey) {
    return stateKey;
  }
  const altStored = await readStateJson({ env, key: altKey });
  if (altStored && typeof altStored === 'object') {
    return altKey;
  }
  return stateKey;
}

async function loadWorkflowResumeState(env: Record<string, string | undefined>, stateKey: string) {
  let stored = await readStateJson({ env, key: stateKey });
  if ((!stored || typeof stored !== 'object') && typeof stateKey === 'string') {
    const altKey = alternateWorkflowResumeStateKey(stateKey);
    if (altKey) {
      stored = await readStateJson({ env, key: altKey });
    }
  }
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

function resolveWorkflowStepArgs(
  workflowArgs: Record<string, unknown> | undefined,
  parentArgs: Record<string, unknown>,
  results: Record<string, WorkflowStepResult>,
): Record<string, unknown> {
  if (!workflowArgs) return {};
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(workflowArgs)) {
    if (typeof value === 'string') {
      resolved[key] = resolveTemplate(value, parentArgs, results);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

function resolveArgsTemplate(input: string, args: Record<string, unknown>) {
  return input.replace(/\$\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
    if (key in args) return String(args[key]);
    return match;
  });
}

function resolveStepRefs(input: string, results: Record<string, WorkflowStepResult>) {
  return input.replace(/\$([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g, (match, id, pathValue) => {
    if (!(id in results)) {
      return match;
    }
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
  return evaluateConditionExpression(trimmed, results);
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

function extractApprovalRequest(
  step: WorkflowStep,
  result: WorkflowStepResult,
  env?: Record<string, string | undefined>,
) {
  const approvalConfig = normalizeApprovalConfig(step.approval);
  const configIdentity = approvalIdentityFromRaw(approvalConfig);
  if (!configIdentity.initiatedBy) {
    const fromEnv = String(env?.LOBSTER_APPROVAL_INITIATED_BY ?? '').trim();
    if (fromEnv) configIdentity.initiatedBy = fromEnv;
  }
  if (!configIdentity.requiredApprover) {
    const fromEnv = String(env?.LOBSTER_APPROVAL_REQUIRED_APPROVER ?? '').trim();
    if (fromEnv) configIdentity.requiredApprover = fromEnv;
  }
  if (!configIdentity.requireDifferentApprover) {
    const fromEnv = parseBoolLike(env?.LOBSTER_APPROVAL_REQUIRE_DIFFERENT_APPROVER);
    if (fromEnv === true) configIdentity.requireDifferentApprover = true;
  }
  const fallbackPrompt = approvalConfig.prompt ?? `Approve ${step.id}?`;
  const json = result.json;

  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const candidate = json as {
      requiresApproval?: {
        prompt?: string;
        items?: unknown[];
        preview?: string;
        initiated_by?: string;
        initiatedBy?: string;
        required_approver?: string;
        requiredApprover?: string;
        require_different_approver?: boolean;
        requireDifferentApprover?: boolean;
      };
      prompt?: string;
      items?: unknown[];
      preview?: string;
      initiated_by?: string;
      initiatedBy?: string;
      required_approver?: string;
      requiredApprover?: string;
      require_different_approver?: boolean;
      requireDifferentApprover?: boolean;
    };
    if (candidate.requiresApproval?.prompt) {
      const identity = {
        ...configIdentity,
        ...approvalIdentityFromRaw(candidate.requiresApproval as Record<string, unknown>),
      };
      return {
        type: 'approval_request' as const,
        prompt: candidate.requiresApproval.prompt,
        items: candidate.requiresApproval.items ?? [],
        ...(candidate.requiresApproval.preview ? { preview: candidate.requiresApproval.preview } : null),
        ...(identity.initiatedBy ? { initiatedBy: identity.initiatedBy } : null),
        ...(identity.requiredApprover ? { requiredApprover: identity.requiredApprover } : null),
        ...(identity.requireDifferentApprover ? { requireDifferentApprover: true } : null),
      };
    }
    if (candidate.prompt) {
      const identity = {
        ...configIdentity,
        ...approvalIdentityFromRaw(candidate as Record<string, unknown>),
      };
      return {
        type: 'approval_request' as const,
        prompt: candidate.prompt,
        items: candidate.items ?? [],
        ...(candidate.preview ? { preview: candidate.preview } : null),
        ...(identity.initiatedBy ? { initiatedBy: identity.initiatedBy } : null),
        ...(identity.requiredApprover ? { requiredApprover: identity.requiredApprover } : null),
        ...(identity.requireDifferentApprover ? { requireDifferentApprover: true } : null),
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
    ...(configIdentity.initiatedBy ? { initiatedBy: configIdentity.initiatedBy } : null),
    ...(configIdentity.requiredApprover ? { requiredApprover: configIdentity.requiredApprover } : null),
    ...(configIdentity.requireDifferentApprover ? { requireDifferentApprover: true } : null),
  };
}

function approvalIdentityFromRaw(
  raw: Record<string, unknown> | NormalizedApprovalConfig | null | undefined,
): WorkflowApprovalIdentity {
  if (!raw) return {};
  const value = raw as Record<string, unknown>;
  const initiatedBy = String(value.initiatedBy ?? value.initiated_by ?? '').trim() || undefined;
  const requiredApprover = String(value.requiredApprover ?? value.required_approver ?? '').trim() || undefined;
  const requireDifferentRaw = value.requireDifferentApprover ?? value.require_different_approver;
  const requireDifferentApprover = typeof requireDifferentRaw === 'boolean' ? requireDifferentRaw : undefined;
  return {
    ...(initiatedBy ? { initiatedBy } : null),
    ...(requiredApprover ? { requiredApprover } : null),
    ...(requireDifferentApprover === true ? { requireDifferentApprover: true } : null),
  };
}

function approvalIdentityFromRequest(request: WorkflowRunResult['requiresApproval']): WorkflowApprovalIdentity {
  if (!request) return {};
  return {
    ...(request.initiatedBy ? { initiatedBy: request.initiatedBy } : null),
    ...(request.requiredApprover ? { requiredApprover: request.requiredApprover } : null),
    ...(request.requireDifferentApprover ? { requireDifferentApprover: true } : null),
  };
}

function enforceApprovalIdentity({
  stepId,
  identity,
  approvedBy,
}: {
  stepId: string;
  identity: WorkflowApprovalIdentity | undefined;
  approvedBy?: string;
}) {
  const policy = identity ?? {};
  const approver = String(approvedBy ?? '').trim() || undefined;

  if (!policy.requiredApprover && !policy.requireDifferentApprover) return;
  if (!approver) {
    throw new WorkflowResumeArgumentError(
      `Workflow step ${stepId} approval requires approver identity; set LOBSTER_APPROVAL_APPROVED_BY`,
    );
  }
  if (policy.requiredApprover && approver !== policy.requiredApprover) {
    throw new WorkflowResumeArgumentError(
      `Workflow step ${stepId} approval requires approver '${policy.requiredApprover}', got '${approver}'`,
    );
  }
  if (policy.requireDifferentApprover && policy.initiatedBy && approver === policy.initiatedBy) {
    throw new WorkflowResumeArgumentError(
      `Workflow step ${stepId} approval must be granted by someone other than '${policy.initiatedBy}'`,
    );
  }
}

function parseBoolLike(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  return undefined;
}

function trackStepCost(costTracker: CostTracker, stepId: string, result: WorkflowStepResult) {
  const json = result.json;
  if (!json || typeof json !== 'object') return;

  const items = Array.isArray(json) ? json : [json];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const usage = (item as Record<string, unknown>).usage;
    if (!usage || typeof usage !== 'object') continue;
    const modelValue = (item as Record<string, unknown>).model;
    const model = typeof modelValue === 'string' ? modelValue : null;
    costTracker.recordUsage(stepId, model, usage as Record<string, unknown>);
  }
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

const MAX_NEEDS_INPUT_SUBJECT_BYTES = 192_000;
const DEFAULT_TOOL_ENVELOPE_MAX_BYTES = 512_000;
const RESUME_TOKEN_PLACEHOLDER = 'x'.repeat(220);

function parseResponseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Input response must be valid JSON');
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
  return {
    truncated: true,
    bytes: byteLength,
    preview: serialized.slice(0, 2000),
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
  if (fitsNeedsInputEnvelope(request, params.maxEnvelopeBytes)) return request;

  subject = maybeTruncateInputSubject(subject);
  request = { ...base, subject };
  if (fitsNeedsInputEnvelope(request, params.maxEnvelopeBytes)) return request;

  request = {
    ...base,
    subject: {
      truncated: true,
      bytes: estimateSerializedBytes(params.subject),
      preview: '[subject omitted: envelope size limit]',
    },
  };
  if (fitsNeedsInputEnvelope(request, params.maxEnvelopeBytes)) return request;

  throw new Error(
    `Workflow input step ${params.stepId} needs_input envelope exceeds ${params.maxEnvelopeBytes} bytes even after subject truncation`,
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

type ConditionToken =
  | { type: 'lparen' | 'rparen' | 'and' | 'or' | 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'not' }
  | { type: 'step_ref'; value: { id: string; path: string } }
  | { type: 'string' | 'number' | 'boolean' | 'null' | 'identifier'; value: unknown };

function evaluateConditionExpression(
  expression: string,
  results: Record<string, WorkflowStepResult>,
) {
  const tokens = tokenizeCondition(expression);
  if (tokens.length === 0) {
    throw new Error(`Unsupported condition: ${expression}`);
  }
  let index = 0;

  function parseOr(): unknown {
    let left = parseAnd();
    while (match('or')) {
      const right = parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  function parseAnd(): unknown {
    let left = parseEquality();
    while (match('and')) {
      const right = parseEquality();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  function parseEquality(): unknown {
    const left = parseUnary(false);
    if (match('eq')) {
      return compareConditionValues(left, parseUnary(true));
    }
    if (match('neq')) {
      return !compareConditionValues(left, parseUnary(true));
    }
    if (match('lt')) {
      return numericCompare(left, parseUnary(true), (a, b) => a < b);
    }
    if (match('lte')) {
      return numericCompare(left, parseUnary(true), (a, b) => a <= b);
    }
    if (match('gt')) {
      return numericCompare(left, parseUnary(true), (a, b) => a > b);
    }
    if (match('gte')) {
      return numericCompare(left, parseUnary(true), (a, b) => a >= b);
    }
    return left;
  }

  function parseUnary(allowBareIdentifier: boolean): unknown {
    if (match('not')) {
      return !Boolean(parseUnary(allowBareIdentifier));
    }
    return parsePrimary(allowBareIdentifier);
  }

  function parsePrimary(allowBareIdentifier: boolean): unknown {
    const token = tokens[index];
    if (!token) {
      throw new Error(`Unsupported condition: ${expression}`);
    }
    index += 1;

    if (token.type === 'lparen') {
      const value = parseOr();
      expect('rparen');
      return value;
    }
    if (token.type === 'step_ref') {
      return getStepRefValue(token.value, results, true);
    }
    if (token.type === 'string' || token.type === 'number' || token.type === 'boolean' || token.type === 'null') {
      return token.value;
    }
    if (token.type === 'identifier' && allowBareIdentifier) {
      return token.value;
    }
    throw new Error(`Unsupported condition: ${expression}`);
  }

  function match(type: ConditionToken['type']) {
    if (tokens[index]?.type !== type) return false;
    index += 1;
    return true;
  }

  function expect(type: ConditionToken['type']) {
    if (!match(type)) {
      throw new Error(`Unsupported condition: ${expression}`);
    }
  }

  const value = parseOr();
  if (index !== tokens.length) {
    throw new Error(`Unsupported condition: ${expression}`);
  }
  return Boolean(value);
}

function compareConditionValues(left: unknown, right: unknown) {
  if (Array.isArray(left) || Array.isArray(right) || isPlainConditionObject(left) || isPlainConditionObject(right)) {
    return isDeepStrictEqual(left, right);
  }
  return Object.is(left, right);
}

function isStrictlyNumeric(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value === 'string') return value.trim() !== '' && !Number.isNaN(Number(value));
  return false;
}

function numericCompare(left: unknown, right: unknown, cmp: (a: number, b: number) => boolean): boolean {
  if (!isStrictlyNumeric(left) || !isStrictlyNumeric(right)) return false;
  return cmp(Number(left), Number(right));
}

function isPlainConditionObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tokenizeCondition(expression: string): ConditionToken[] {
  const tokens: ConditionToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const ch = expression[index];
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      index += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      index += 1;
      continue;
    }
    if (expression.startsWith('&&', index)) {
      tokens.push({ type: 'and' });
      index += 2;
      continue;
    }
    if (expression.startsWith('||', index)) {
      tokens.push({ type: 'or' });
      index += 2;
      continue;
    }
    if (expression.startsWith('==', index)) {
      tokens.push({ type: 'eq' });
      index += 2;
      continue;
    }
    if (expression.startsWith('!=', index)) {
      tokens.push({ type: 'neq' });
      index += 2;
      continue;
    }
    if (expression.startsWith('<=', index)) {
      tokens.push({ type: 'lte' });
      index += 2;
      continue;
    }
    if (expression.startsWith('>=', index)) {
      tokens.push({ type: 'gte' });
      index += 2;
      continue;
    }
    if (ch === '<') {
      tokens.push({ type: 'lt' });
      index += 1;
      continue;
    }
    if (ch === '>') {
      tokens.push({ type: 'gt' });
      index += 1;
      continue;
    }
    if (ch === '!') {
      tokens.push({ type: 'not' });
      index += 1;
      continue;
    }
    if (ch === '$') {
      const matched = matchConditionStepRef(expression, index);
      if (!matched) {
        throw new Error(`Unsupported condition: ${expression}`);
      }
      tokens.push({ type: 'step_ref', value: matched.ref });
      index = matched.nextIndex;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      const parsed = parseQuotedConditionString(expression, index, ch);
      tokens.push({ type: 'string', value: parsed.value });
      index = parsed.nextIndex;
      continue;
    }
    const numberMatch = expression.slice(index).match(/^-?\d+(?:\.\d+)?/);
    if (numberMatch) {
      tokens.push({ type: 'number', value: Number(numberMatch[0]) });
      index += numberMatch[0].length;
      continue;
    }
    const identMatch = expression.slice(index).match(/^[A-Za-z_][A-Za-z0-9_-]*/);
    if (identMatch) {
      const raw = identMatch[0];
      if (raw === 'true') {
        tokens.push({ type: 'boolean', value: true });
      } else if (raw === 'false') {
        tokens.push({ type: 'boolean', value: false });
      } else if (raw === 'null') {
        tokens.push({ type: 'null', value: null });
      } else {
        tokens.push({ type: 'identifier', value: raw });
      }
      index += raw.length;
      continue;
    }
    throw new Error(`Unsupported condition: ${expression}`);
  }

  return tokens;
}

function matchConditionStepRef(expression: string, startIndex: number) {
  const match = expression
    .slice(startIndex)
    .match(/^\$([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/);
  if (!match) return null;
  return {
    ref: { id: match[1], path: match[2] },
    nextIndex: startIndex + match[0].length,
  };
}

function parseQuotedConditionString(
  expression: string,
  startIndex: number,
  quoteChar: '"' | '\'',
) {
  let value = '';
  let index = startIndex + 1;
  while (index < expression.length) {
    const ch = expression[index];
    if (ch === '\\') {
      const next = expression[index + 1];
      if (next === undefined) break;
      value += next;
      index += 2;
      continue;
    }
    if (ch === quoteChar) {
      return { value, nextIndex: index + 1 };
    }
    value += ch;
    index += 1;
  }
  throw new Error(`Unsupported condition: ${expression}`);
}

async function runShellCommand({
  command,
  stdin,
  env,
  cwd,
  signal,
  killSignal,
}: {
  command: string;
  stdin: string | null;
  env: Record<string, string | undefined>;
  cwd?: string;
  signal?: AbortSignal;
  killSignal?: NodeJS.Signals;
}) {
  const { spawn } = await import('node:child_process');

  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const shell = resolveInlineShellCommand({ command, env });
    const child = spawn(shell.command, shell.argv, {
      env,
      cwd,
      signal,
      killSignal,
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
  if (step.parallel && typeof step.parallel === 'object' && !Array.isArray(step.parallel)) {
    return { kind: 'parallel' as const, value: step.parallel };
  }

  if (typeof step.workflow === 'string' && step.workflow.trim()) {
    return { kind: 'workflow' as const, value: step.workflow };
  }

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

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
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

type NormalizedApprovalConfig = {
  prompt?: string;
  items?: unknown[];
  preview?: string;
  initiatedBy?: string;
  requiredApprover?: string;
  requireDifferentApprover?: boolean;
};

function normalizeApprovalConfig(approval: WorkflowStep['approval']): NormalizedApprovalConfig {
  if (approval === true || approval === 'required' || approval === undefined || approval === false) {
    return {};
  }
  if (typeof approval === 'string') {
    return { prompt: approval };
  }
  if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
    const value = approval as Record<string, unknown>;
    return {
      ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : null),
      ...(Array.isArray(value.items) ? { items: value.items } : null),
      ...(typeof value.preview === 'string' ? { preview: value.preview } : null),
      ...(typeof value.initiatedBy === 'string'
        ? { initiatedBy: value.initiatedBy }
        : (typeof value.initiated_by === 'string' ? { initiatedBy: value.initiated_by } : null)),
      ...(typeof value.requiredApprover === 'string'
        ? { requiredApprover: value.requiredApprover }
        : (typeof value.required_approver === 'string' ? { requiredApprover: value.required_approver } : null)),
      ...(typeof value.requireDifferentApprover === 'boolean'
        ? { requireDifferentApprover: value.requireDifferentApprover }
        : (typeof value.require_different_approver === 'boolean'
          ? { requireDifferentApprover: value.require_different_approver }
          : null)),
    };
  }
  return {};
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
