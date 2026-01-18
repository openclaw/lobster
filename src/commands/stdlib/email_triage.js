function getField(obj, path, fallback = undefined) {
  if (!obj || typeof obj !== 'object') return fallback;
  if (!path) return fallback;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return fallback;
    cur = cur[p];
  }
  return cur ?? fallback;
}

function normalizeString(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function parseEmailAddress(from) {
  // Handles "Name <email@x.com>" or "email@x.com".
  const s = String(from ?? '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
}

function classifyEmail({ subject, snippet }) {
  const text = `${subject} ${snippet}`.toLowerCase();
  if (/(unsubscribe|newsletter|promo|sale|discount)/.test(text)) return { bucket: 'fyi', reason: 'newsletter/promo-ish' };
  if (/(invoice|receipt|payment|charged|billing)/.test(text)) return { bucket: 'needs_action', reason: 'finance keyword' };
  if (/(asap|urgent|action required|deadline|due)/.test(text)) return { bucket: 'needs_action', reason: 'urgency keyword' };
  if (/[?]/.test(text)) return { bucket: 'needs_reply', reason: 'question mark' };
  return { bucket: 'fyi', reason: 'default' };
}

export const emailTriageCommand = {
  name: 'email.triage',
  help() {
    return `email.triage — deterministic email triage report\n\n` +
      `Usage:\n` +
      `  <emails> | email.triage [--subject-field subject] [--from-field from] [--snippet-field snippet] [--id-field id]\n\n` +
      `Output:\n` +
      `  Single object: { summary, items, buckets }\n\n` +
      `Notes:\n` +
      `  - This is intentionally non-LLM: rule-based classification (fast, predictable).\n` +
      `  - Use --*-field flags to map provider-specific JSON into the triage schema.\n`;
  },
  async run({ input, args }) {
    const idField = args['id-field'] ?? 'id';
    const threadField = args['thread-field'] ?? 'threadId';
    const subjectField = args['subject-field'] ?? 'subject';
    const fromField = args['from-field'] ?? 'from';
    const snippetField = args['snippet-field'] ?? 'snippet';
    const dateField = args['date-field'] ?? 'date';

    const items = [];
    for await (const raw of input) {
      const subject = normalizeString(getField(raw, subjectField, getField(raw, 'Subject')));
      const from = normalizeString(getField(raw, fromField, getField(raw, 'From')));
      const snippet = normalizeString(getField(raw, snippetField, getField(raw, 'Snippet')));

      const classification = classifyEmail({ subject, snippet });

      items.push({
        id: getField(raw, idField),
        threadId: getField(raw, threadField),
        from,
        fromEmail: parseEmailAddress(from),
        subject,
        snippet,
        date: getField(raw, dateField),
        bucket: classification.bucket,
        reason: classification.reason,
        raw,
      });
    }

    const buckets = {
      needs_reply: items.filter((x) => x.bucket === 'needs_reply'),
      needs_action: items.filter((x) => x.bucket === 'needs_action'),
      fyi: items.filter((x) => x.bucket === 'fyi'),
    };

    const summary = {
      total: items.length,
      needs_reply: buckets.needs_reply.length,
      needs_action: buckets.needs_action.length,
      fyi: buckets.fyi.length,
    };

    const report = { summary, items, buckets };

    return { output: (async function* () { yield report; })() };
  },
};
