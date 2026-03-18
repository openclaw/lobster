import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import path from 'node:path';
import { Ajv } from 'ajv';

import { createDefaultRegistry } from '../commands/registry.js';
import { parsePipeline } from '../parser.js';
import { decodeResumeToken } from '../resume.js';
import { runPipeline } from '../runtime.js';
import { encodeToken } from '../token.js';
import { readStateJson, writeStateJson, deleteStateJson } from '../state/store.js';
import { WorkflowResumeArgumentError, runWorkflowFile } from '../workflows/file.js';

type PipelineResumeState = {
  pipeline: Array<{ name: string; args: Record<string, unknown>; raw: string }>;
  resumeAtIndex: number;
  items: unknown[];
  haltType?: 'approval_request' | 'input_request';
  inputSchema?: unknown;
  prompt?: string;
  createdAt: string;
};

const pipelineInputAjv = new Ajv({ allErrors: false, strict: false });

type ToolRunContext = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  mode?: 'tool' | 'human' | 'sdk';
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  signal?: AbortSignal;
  registry?: any;
  llmAdapters?: Record<string, any>;
};

type ToolEnvelope = {
  protocolVersion: 1;
  ok: boolean;
  status?: 'ok' | 'needs_approval' | 'needs_input' | 'cancelled';
  output?: unknown[];
  requiresApproval?: {
    type?: 'approval_request';
    prompt: string;
    items: unknown[];
    preview?: string;
    resumeToken?: string;
  } | null;
  requiresInput?: {
    type?: 'input_request';
    prompt: string;
    responseSchema: unknown;
    defaults?: unknown;
    subject: unknown;
    resumeToken?: string;
  } | null;
  error?: {
    type: string;
    message: string;
  };
};

export async function runToolRequest({
  pipeline,
  filePath,
  args,
  ctx = {},
}: {
  pipeline?: string;
  filePath?: string;
  args?: Record<string, unknown>;
  ctx?: ToolRunContext;
}): Promise<ToolEnvelope> {
  const runtime = createToolContext(ctx);
  const hasPipeline = typeof pipeline === 'string' && pipeline.trim().length > 0;
  const hasFile = typeof filePath === 'string' && filePath.trim().length > 0;

  if (!hasPipeline && !hasFile) {
    return errorEnvelope('parse_error', 'run requires either pipeline or filePath');
  }
  if (hasPipeline && hasFile) {
    return errorEnvelope('parse_error', 'run accepts either pipeline or filePath, not both');
  }

  if (hasFile) {
    let resolvedFilePath: string;
    try {
      resolvedFilePath = await resolveWorkflowFile(filePath!, runtime.cwd);
    } catch (err: any) {
      return errorEnvelope('parse_error', err?.message ?? String(err));
    }

    try {
      const output = await runWorkflowFile({
        filePath: resolvedFilePath,
        args,
        ctx: runtime,
      });

      if (output.status === 'needs_approval') {
        return okEnvelope('needs_approval', [], output.requiresApproval ?? null, null);
      }
      if (output.status === 'needs_input') {
        return okEnvelope('needs_input', [], null, output.requiresInput ?? null);
      }
      if (output.status === 'cancelled') {
        return okEnvelope('cancelled', [], null, null);
      }
      return okEnvelope('ok', output.output, null, null);
    } catch (err: any) {
      return errorEnvelope('runtime_error', err?.message ?? String(err));
    }
  }

  let parsed;
  try {
    parsed = parsePipeline(String(pipeline));
  } catch (err: any) {
    return errorEnvelope('parse_error', err?.message ?? String(err));
  }

  try {
    const output = await runPipeline({
      pipeline: parsed,
      registry: runtime.registry,
      input: [],
      stdin: runtime.stdin,
      stdout: runtime.stdout,
      stderr: runtime.stderr,
      env: runtime.env,
      mode: 'tool',
      cwd: runtime.cwd,
      llmAdapters: runtime.llmAdapters,
      signal: runtime.signal,
    });

    const halted = output.halted && output.items.length === 1 ? output.items[0] : null;
    const approval = halted?.type === 'approval_request' ? halted : null;
    const inputRequest = halted?.type === 'input_request' ? halted : null;

    if (approval) {
      const stateKey = await savePipelineResumeState(runtime.env, {
        pipeline: parsed,
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

      return okEnvelope('needs_approval', [], {
        ...approval,
        resumeToken,
      }, null);
    }

    if (inputRequest) {
      const stateKey = await savePipelineResumeState(runtime.env, {
        pipeline: parsed,
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

      return okEnvelope('needs_input', [], null, {
        type: 'input_request',
        prompt: inputRequest.prompt,
        responseSchema: inputRequest.responseSchema,
        defaults: inputRequest.defaults,
        subject: inputRequest.subject,
        resumeToken,
      });
    }

    return okEnvelope('ok', output.items, null, null);
  } catch (err: any) {
    return errorEnvelope('runtime_error', err?.message ?? String(err));
  }
}

export async function resumeToolRequest({
  token,
  approved,
  response,
  ctx = {},
}: {
  token: string;
  approved?: boolean;
  response?: unknown;
  ctx?: ToolRunContext;
}): Promise<ToolEnvelope> {
  const runtime = createToolContext(ctx);
  let payload: any;

  try {
    payload = decodeResumeToken(token);
  } catch (err: any) {
    return errorEnvelope('parse_error', err?.message ?? String(err));
  }

  if (typeof approved === 'boolean' && response !== undefined) {
    return errorEnvelope('parse_error', 'resume accepts either approved or response, not both');
  }

  if (approved === undefined && response === undefined) {
    return errorEnvelope('parse_error', 'resume requires approved or response');
  }

  if (payload.kind === 'workflow-file') {
    try {
      const output = await runWorkflowFile({
        filePath: payload.filePath,
        ctx: runtime,
        resume: payload,
        approved,
        response,
      });

      if (output.status === 'needs_approval') {
        return okEnvelope('needs_approval', [], output.requiresApproval ?? null, null);
      }
      if (output.status === 'needs_input') {
        return okEnvelope('needs_input', [], null, output.requiresInput ?? null);
      }
      if (output.status === 'cancelled') {
        return okEnvelope('cancelled', [], null, null);
      }
      return okEnvelope('ok', output.output, null, null);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (err instanceof WorkflowResumeArgumentError) {
        return errorEnvelope('parse_error', message);
      }
      return errorEnvelope('runtime_error', message);
    }
  }

  let resumeState: PipelineResumeState;
  try {
    resumeState = await loadPipelineResumeState(runtime.env, payload.stateKey);
  } catch (err: any) {
    return errorEnvelope('runtime_error', err?.message ?? String(err));
  }

  if (resumeState.haltType === 'approval_request') {
    if (response !== undefined) {
      return errorEnvelope('parse_error', 'pipeline approval resumes require approved=true|false');
    }
    if (typeof approved !== 'boolean') {
      return errorEnvelope('parse_error', 'pipeline approval resumes require approved=true|false');
    }
    if (approved === false) {
      await deleteStateJson({ env: runtime.env, key: payload.stateKey });
      return okEnvelope('cancelled', [], null, null);
    }
  }

  if (resumeState.haltType === 'input_request') {
    if (approved !== undefined) {
      return errorEnvelope('parse_error', 'pipeline input resumes require response');
    }
    if (response === undefined) {
      return errorEnvelope('parse_error', 'pipeline input resumes require response');
    }
    try {
      validatePipelineInputResponse(resumeState.inputSchema, response);
    } catch (err: any) {
      return errorEnvelope('parse_error', err?.message ?? String(err));
    }
  }

  if (!resumeState.haltType) {
    if (response !== undefined) {
      return errorEnvelope('parse_error', 'legacy pipeline resumes require approved=true|false');
    }
    if (typeof approved !== 'boolean') {
      return errorEnvelope('parse_error', 'legacy pipeline resumes require approved=true|false');
    }
    if (approved === false) {
      await deleteStateJson({ env: runtime.env, key: payload.stateKey });
      return okEnvelope('cancelled', [], null, null);
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
      registry: runtime.registry,
      stdin: runtime.stdin,
      stdout: runtime.stdout,
      stderr: runtime.stderr,
      env: runtime.env,
      mode: 'tool',
      cwd: runtime.cwd,
      llmAdapters: runtime.llmAdapters,
      signal: runtime.signal,
      input,
    });

    const halted2 = output.halted && output.items.length === 1 ? output.items[0] : null;
    const approval = halted2?.type === 'approval_request' ? halted2 : null;
    const inputRequest = halted2?.type === 'input_request' ? halted2 : null;

    if (approval) {
      const nextStateKey = await savePipelineResumeState(runtime.env, {
        pipeline: remaining,
        resumeAtIndex: (output.haltedAt?.index ?? -1) + 1,
        items: approval.items,
        haltType: 'approval_request',
        prompt: approval.prompt,
        createdAt: new Date().toISOString(),
      });
      await deleteStateJson({ env: runtime.env, key: payload.stateKey });

      const resumeToken = encodeToken({
        protocolVersion: 1,
        v: 1,
        kind: 'pipeline-resume',
        stateKey: nextStateKey,
      });

      return okEnvelope('needs_approval', [], {
        ...approval,
        resumeToken,
      }, null);
    }

    if (inputRequest) {
      const nextStateKey = await savePipelineResumeState(runtime.env, {
        pipeline: remaining,
        resumeAtIndex: (output.haltedAt?.index ?? -1) + 1,
        items: inputRequest.items ?? [],
        haltType: 'input_request',
        inputSchema: inputRequest.responseSchema,
        prompt: inputRequest.prompt,
        createdAt: new Date().toISOString(),
      });
      await deleteStateJson({ env: runtime.env, key: payload.stateKey });

      const resumeToken = encodeToken({
        protocolVersion: 1,
        v: 1,
        kind: 'pipeline-resume',
        stateKey: nextStateKey,
      });

      return okEnvelope('needs_input', [], null, {
        type: 'input_request',
        prompt: inputRequest.prompt,
        responseSchema: inputRequest.responseSchema,
        defaults: inputRequest.defaults,
        subject: inputRequest.subject,
        resumeToken,
      });
    }

    await deleteStateJson({ env: runtime.env, key: payload.stateKey });
    return okEnvelope('ok', output.items, null, null);
  } catch (err: any) {
    return errorEnvelope('runtime_error', err?.message ?? String(err));
  }
}

export function createToolContext(ctx: ToolRunContext = {}) {
  return {
    cwd: ctx.cwd ?? process.cwd(),
    env: { ...process.env, ...ctx.env },
    mode: 'tool' as const,
    stdin: ctx.stdin ?? process.stdin,
    stdout: ctx.stdout ?? createCaptureStream(),
    stderr: ctx.stderr ?? createCaptureStream(),
    signal: ctx.signal,
    registry: ctx.registry ?? createDefaultRegistry(),
    llmAdapters: ctx.llmAdapters,
  };
}

export function createCaptureStream() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

function okEnvelope(
  status: 'ok' | 'needs_approval' | 'needs_input' | 'cancelled',
  output: unknown[],
  requiresApproval: ToolEnvelope['requiresApproval'],
  requiresInput: ToolEnvelope['requiresInput'],
) {
  return {
    protocolVersion: 1 as const,
    ok: true,
    status,
    output,
    requiresApproval,
    requiresInput,
  };
}

function errorEnvelope(type: string, message: string): ToolEnvelope {
  return {
    protocolVersion: 1,
    ok: false,
    error: { type, message },
  };
}

function streamFromItems(items: unknown[]) {
  return (async function* () {
    for (const item of items) {
      yield item;
    }
  })();
}

async function savePipelineResumeState(env: Record<string, string | undefined>, state: PipelineResumeState) {
  const stateKey = `pipeline_resume_${randomUUID()}`;
  await writeStateJson({ env, key: stateKey, value: state });
  return stateKey;
}

async function loadPipelineResumeState(env: Record<string, string | undefined>, stateKey: string) {
  const stored = await readStateJson({ env, key: stateKey });
  if (!stored || typeof stored !== 'object') {
    throw new Error('Pipeline resume state not found');
  }
  const data = stored as Partial<PipelineResumeState>;
  if (!Array.isArray(data.pipeline)) throw new Error('Invalid pipeline resume state');
  if (typeof data.resumeAtIndex !== 'number') throw new Error('Invalid pipeline resume state');
  if (!Array.isArray(data.items)) throw new Error('Invalid pipeline resume state');
  if (data.haltType !== undefined && !['approval_request', 'input_request'].includes(data.haltType)) {
    throw new Error('Invalid pipeline resume state');
  }
  return data as PipelineResumeState;
}

function validatePipelineInputResponse(schema: unknown, response: unknown) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return;
  }
  const validator = pipelineInputAjv.compile(schema as object);
  const ok = validator(response);
  if (ok) return;
  const first = validator.errors?.[0];
  const pathValue = first?.instancePath || '/';
  const reason = first?.message ? ` ${first.message}` : '';
  throw new Error(`pipeline input response failed schema validation at ${pathValue}:${reason}`);
}

async function resolveWorkflowFile(candidate: string, cwd: string) {
  const { stat } = await import('node:fs/promises');
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) throw new Error('Workflow path is not a file');
  const ext = path.extname(resolved).toLowerCase();
  if (!['.lobster', '.yaml', '.yml', '.json'].includes(ext)) {
    throw new Error('Workflow file must end in .lobster, .yaml, .yml, or .json');
  }
  return resolved;
}
