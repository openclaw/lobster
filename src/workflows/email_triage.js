import { spawn } from 'node:child_process';

function runProcess(command, argv, { env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (err?.code === 'ENOENT') {
        reject(new Error('gog not found on PATH (install steipete/gog from ClawdHub)'));
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`gog failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function classifyEmail({ subject, snippet }) {
  const text = `${subject} ${snippet}`.toLowerCase();
  if (/(unsubscribe|newsletter|promo|sale|discount)/.test(text)) return { bucket: 'fyi', reason: 'newsletter/promo-ish' };
  if (/(invoice|receipt|payment|charged|billing)/.test(text)) return { bucket: 'needs_action', reason: 'finance keyword' };
  if (/(asap|urgent|action required|deadline|due)/.test(text)) return { bucket: 'needs_action', reason: 'urgency keyword' };
  if (/[?]/.test(text)) return { bucket: 'needs_reply', reason: 'question mark' };
  return { bucket: 'fyi', reason: 'default' };
}

function normalizeString(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function parseEmailAddress(from) {
  const s = String(from ?? '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
}

export async function runEmailTriageWorkflow({ args, ctx }) {
  const query = args.query ?? 'newer_than:1d';
  const max = args.max ?? 20;
  const account = args.account;

  const env = { ...ctx.env };
  if (account) env.GOG_ACCOUNT = String(account);

  const argv = ['gmail', 'search', String(query), '--max', String(max), '--json', '--no-input'];
  const { stdout } = await runProcess('gog', argv, { env, cwd: process.cwd() });

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim() || '[]');
  } catch {
    throw new Error('gog gmail search returned non-JSON output');
  }

  const rawItems = Array.isArray(parsed) ? parsed : [parsed];

  const items = rawItems.map((raw) => {
    const subject = normalizeString(raw.subject ?? raw.Subject);
    const from = normalizeString(raw.from ?? raw.From);
    const snippet = normalizeString(raw.snippet ?? raw.Snippet);
    const classification = classifyEmail({ subject, snippet });

    return {
      id: raw.id ?? raw.Id,
      threadId: raw.threadId ?? raw.ThreadId,
      from,
      fromEmail: parseEmailAddress(from),
      subject,
      snippet,
      date: raw.date ?? raw.Date,
      bucket: classification.bucket,
      reason: classification.reason,
      raw,
    };
  });

  const buckets = {
    needs_reply: items.filter((x) => x.bucket === 'needs_reply'),
    needs_action: items.filter((x) => x.bucket === 'needs_action'),
    fyi: items.filter((x) => x.bucket === 'fyi'),
  };

  return {
    kind: 'email.triage',
    query,
    max,
    summary: {
      total: items.length,
      needs_reply: buckets.needs_reply.length,
      needs_action: buckets.needs_action.length,
      fyi: buckets.fyi.length,
    },
    items,
    buckets,
  };
}
