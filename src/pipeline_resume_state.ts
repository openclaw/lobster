import { randomUUID } from 'node:crypto';

import { readStateJson, writeStateJson } from './state/store.js';
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
  subject: unknown;
  items?: unknown[];
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
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return;
  }
  const validator = sharedAjv.compile(schema as object);
  const ok = validator(response);
  if (ok) return;
  const first = validator.errors?.[0];
  const pathValue = first?.instancePath || '/';
  const reason = first?.message ? ` ${first.message}` : '';
  throw new Error(`pipeline input response failed schema validation at ${pathValue}:${reason}`);
}
