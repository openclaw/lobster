import { decodeToken } from './token.js';

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
  if (payload.v !== 1) throw new Error('Unsupported token version');
  if (!Array.isArray(payload.pipeline)) throw new Error('Invalid token');
  if (typeof payload.resumeAtIndex !== 'number') throw new Error('Invalid token');
  if (!Array.isArray(payload.items)) throw new Error('Invalid token');

  return payload;
}
