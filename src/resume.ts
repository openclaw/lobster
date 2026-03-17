import { decodeToken } from './token.js';
import { decodeWorkflowResumePayload } from './workflows/file.js';

export type PipelineResumePayload = {
  protocolVersion: 1;
  v: 1;
  kind: 'pipeline-resume';
  stateKey: string;
};

export function parseResumeArgs(argv) {
  const args = { decision: null, token: null, responseJson: null };

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
    if (tok === '--response-json') {
      args.responseJson = argv[i + 1];
      i++;
      continue;
    }
    if (tok.startsWith('--response-json=')) {
      args.responseJson = tok.slice('--response-json='.length);
      continue;
    }
  }

  if (!args.token) throw new Error('resume requires --token');
  if (args.decision && args.responseJson) {
    throw new Error('resume accepts either --approve or --response-json');
  }
  if (!args.decision && !args.responseJson) {
    throw new Error('resume requires --approve yes|no or --response-json');
  }

  if (args.decision) {
    const decision = String(args.decision).toLowerCase();
    if (!['yes', 'y', 'no', 'n'].includes(decision)) throw new Error('resume --approve must be yes or no');
    return { token: String(args.token), approved: decision === 'yes' || decision === 'y' };
  }

  try {
    return { token: String(args.token), response: JSON.parse(String(args.responseJson)) };
  } catch {
    throw new Error('resume --response-json must be valid JSON');
  }
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
