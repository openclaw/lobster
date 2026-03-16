import { decodeToken } from './token.js';
import { decodeWorkflowResumePayload } from './workflows/file.js';

export type PipelineResumePayload = {
  protocolVersion: 1;
  v: 1;
  kind: 'pipeline-resume';
  stateKey: string;
};

export function parseResumeArgs(argv) {
  const args = { decision: null, token: null };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--token') {
      args.token = argv[i + 1];
      i++;
      continue;
    }
    if (tok.startsWith('--token=')) {
      args.token = tok.slice('--token='.length);
      continue;
    }
    if (tok === '--approve' || tok === '--decision') {
      args.decision = argv[i + 1];
      i++;
      continue;
    }
    if (tok.startsWith('--approve=')) {
      args.decision = tok.slice('--approve='.length);
      continue;
    }
    if (tok.startsWith('--decision=')) {
      args.decision = tok.slice('--decision='.length);
      continue;
    }
  }

  if (!args.token) throw new Error('resume requires --token');
  if (!args.decision) throw new Error('resume requires --approve yes|no');

  const decision = String(args.decision).toLowerCase();
  if (!['yes', 'y', 'no', 'n'].includes(decision)) throw new Error('resume --approve must be yes or no');

  return { token: String(args.token), approved: decision === 'yes' || decision === 'y' };
}

export function decodeResumeToken(token) {
  const payload = decodeToken(token);
  if (!payload || typeof payload !== 'object') throw new Error('Invalid token');
  if (payload.protocolVersion !== 1) throw new Error('Unsupported protocol version');
  if (payload.v !== 1) throw new Error('Unsupported token version');
  const workflowPayload = decodeWorkflowResumePayload(payload);
  if (workflowPayload) return workflowPayload;
  const pipelinePayload = decodePipelineResumePayload(payload);
  if (pipelinePayload) return pipelinePayload;
  throw new Error('Invalid token');
}

function decodePipelineResumePayload(payload: unknown): PipelineResumePayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Partial<PipelineResumePayload>;
  if (data.kind !== 'pipeline-resume') return null;
  if (data.protocolVersion !== 1 || data.v !== 1) throw new Error('Unsupported token version');
  if (!data.stateKey || typeof data.stateKey !== 'string') throw new Error('Invalid token');
  return {
    protocolVersion: 1,
    v: 1,
    kind: 'pipeline-resume',
    stateKey: data.stateKey,
  };
}
