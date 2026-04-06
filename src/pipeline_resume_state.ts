import { randomUUID } from 'node:crypto';

import { encodeToken } from './token.js';
import {
  cleanupApprovalIndexByStateKey,
  createApprovalIndex,
  deleteStateJson,
  readStateJson,
  writeStateJson,
} from './state/store.js';
import { sharedAjv } from './validation.js';

export type PipelineResumeState = {
  pipeline: Array<{ name: string; args: Record<string, unknown>; raw: string }>;
  resumeAtIndex: number;
  items: unknown[];
  haltType?: 'approval_request' | 'input_request';
  inputSchema?: unknown;
  prompt?: string;
  createdAt: string;
};

export type PipelineApprovalRequest = {
  type: 'approval_request';
  prompt: string;
  items: unknown[];
  preview?: string;
};

export type PipelineInputRequest = {
  type: 'input_request';
  prompt: string;
  responseSchema: unknown;
  defaults?: unknown;
  subject?: unknown;
  items?: unknown[];
};

export type PipelineRunOutput = {
  items: unknown[];
  halted?: boolean;
  haltedAt?: { index: number } | null;
};

export type PipelineToolRunResolution =
  | {
    status: 'needs_approval';
    output: [];
    requiresApproval: {
      type: 'approval_request';
      prompt: string;
      items: unknown[];
      preview?: string;
      resumeToken: string;
      approvalId: string;
    };
    requiresInput: null;
  }
  | {
    status: 'needs_input';
    output: [];
    requiresApproval: null;
    requiresInput: {
      type: 'input_request';
      prompt: string;
      responseSchema: unknown;
      defaults?: unknown;
      subject?: unknown;
      resumeToken: string;
    };
  }
  | {
    status: 'ok';
    output: unknown[];
    requiresApproval: null;
    requiresInput: null;
  };

export function extractPipelineHalt(output: {
  halted?: boolean;
  items: unknown[];
}) {
  const halted = output.halted && output.items.length === 1
    ? output.items[0] as Record<string, unknown>
    : null;
  const approval = halted?.type === 'approval_request'
    ? halted as unknown as PipelineApprovalRequest
    : null;
  const inputRequest = halted?.type === 'input_request'
    ? halted as unknown as PipelineInputRequest
    : null;
  return { approval, inputRequest };
}

export async function finalizePipelineToolRun(params: {
  env: Record<string, string | undefined>;
  pipeline: PipelineResumeState['pipeline'];
  output: PipelineRunOutput;
  previousStateKey?: string;
}): Promise<PipelineToolRunResolution> {
  const { approval, inputRequest } = extractPipelineHalt(params.output);
  if (approval) {
    const nextStateKey = await savePipelineResumeState(params.env, {
      pipeline: params.pipeline,
      resumeAtIndex: (params.output.haltedAt?.index ?? -1) + 1,
      items: approval.items,
      haltType: 'approval_request',
      prompt: approval.prompt,
      createdAt: new Date().toISOString(),
    });
    if (params.previousStateKey) {
      await cleanupApprovalIndexByStateKey({ env: params.env, stateKey: params.previousStateKey });
      await deleteStateJson({ env: params.env, key: params.previousStateKey });
    }
    let approvalId: string;
    try {
      approvalId = await createApprovalIndex({ env: params.env, stateKey: nextStateKey });
    } catch (err) {
      await deleteStateJson({ env: params.env, key: nextStateKey }).catch(() => {});
      throw err;
    }
    const resumeToken = encodeToken({
      protocolVersion: 1,
      v: 1,
      kind: 'pipeline-resume',
      stateKey: nextStateKey,
    });
    return {
      status: 'needs_approval',
      output: [],
      requiresApproval: {
        ...approval,
        resumeToken,
        approvalId,
      },
      requiresInput: null,
    };
  }

  if (inputRequest) {
    const nextStateKey = await savePipelineResumeState(params.env, {
      pipeline: params.pipeline,
      resumeAtIndex: (params.output.haltedAt?.index ?? -1) + 1,
      items: [],
      haltType: 'input_request',
      inputSchema: inputRequest.responseSchema,
      prompt: inputRequest.prompt,
      createdAt: new Date().toISOString(),
    });
    if (params.previousStateKey) {
      await cleanupApprovalIndexByStateKey({ env: params.env, stateKey: params.previousStateKey });
      await deleteStateJson({ env: params.env, key: params.previousStateKey });
    }
    const resumeToken = encodeToken({
      protocolVersion: 1,
      v: 1,
      kind: 'pipeline-resume',
      stateKey: nextStateKey,
    });
    return {
      status: 'needs_input',
      output: [],
      requiresApproval: null,
      requiresInput: {
        type: 'input_request',
        prompt: inputRequest.prompt,
        responseSchema: inputRequest.responseSchema,
        ...(inputRequest.defaults !== undefined ? { defaults: inputRequest.defaults } : null),
        ...(inputRequest.subject !== undefined ? { subject: inputRequest.subject } : null),
        resumeToken,
      },
    };
  }

  if (params.previousStateKey) {
    await cleanupApprovalIndexByStateKey({ env: params.env, stateKey: params.previousStateKey });
    await deleteStateJson({ env: params.env, key: params.previousStateKey });
  }
  return {
    status: 'ok',
    output: params.output.items,
    requiresApproval: null,
    requiresInput: null,
  };
}

export async function savePipelineResumeState(
  env: Record<string, string | undefined>,
  state: PipelineResumeState,
) {
  const stateKey = `pipeline_resume_${randomUUID()}`;
  await writeStateJson({ env, key: stateKey, value: state });
  return stateKey;
}

export async function loadPipelineResumeState(
  env: Record<string, string | undefined>,
  stateKey: string,
) {
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

export function validatePipelineInputResponse(schema: unknown, response: unknown) {
  if (schema === undefined) {
    throw new Error('pipeline input response schema is missing');
  }
  let validator;
  try {
    validator = sharedAjv.compile(schema as any);
  } catch {
    throw new Error('pipeline input response schema is invalid');
  }
  const ok = validator(response);
  if (ok) return;
  const first = validator.errors?.[0];
  const pathValue = first?.instancePath || '/';
  const reason = first?.message ? ` ${first.message}` : '';
  throw new Error(`pipeline input response failed schema validation at ${pathValue}:${reason}`);
}
