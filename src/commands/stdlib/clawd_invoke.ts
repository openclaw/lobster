export const clawdInvokeCommand = {
  name: 'clawd.invoke',
  help() {
    return `clawd.invoke — call a local Clawdbot tool endpoint\n\n` +
      `Usage:\n` +
      `  clawd.invoke --tool message --action send --args-json '{"provider":"telegram","to":"...","message":"..."}'\n` +
      `  clawd.invoke --tool message --action send --args-json '{...}' --dry-run\n\n` +
      `Config:\n` +
      `  - Uses CLAWD_URL env var by default (or pass --url).\n` +
      `  - Optional Bearer token via CLAWD_TOKEN env var (or pass --token).\n` +
      `  - Optional attribution via --session-key <sessionKey>.\n\n` +
      `Notes:\n` +
      `  - This is a thin transport bridge. Lobster should not own OAuth/secrets.\n`;
  },
  async run({ input, args, ctx }) {
    // Drain input: for now we don't stream input into clawd calls.
    for await (const _item of input) {
      // no-op
    }

    const url = String(args.url ?? ctx.env.CLAWD_URL ?? '').trim();
    if (!url) throw new Error('clawd.invoke requires --url or CLAWD_URL');

    const tool = args.tool;
    const action = args.action;
    if (!tool || !action) throw new Error('clawd.invoke requires --tool and --action');

    const token = String(args.token ?? ctx.env.CLAWD_TOKEN ?? '').trim();

    let toolArgs = {};
    if (args['args-json']) {
      try {
        toolArgs = JSON.parse(String(args['args-json']));
      } catch (_err) {
        throw new Error('clawd.invoke --args-json must be valid JSON');
      }
    }

    const endpoint = new URL('/tools/invoke', url);
    const sessionKey = args.sessionKey ?? args['session-key'] ?? null;
    const dryRun = args.dryRun ?? args['dry-run'] ?? null;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : null),
      },
      body: JSON.stringify({
        tool: String(tool),
        action: String(action),
        args: toolArgs,
        ...(sessionKey ? { sessionKey: String(sessionKey) } : null),
        ...(dryRun !== null ? { dryRun: Boolean(dryRun) } : null),
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`clawd.invoke failed (${res.status}): ${text.slice(0, 400)}`);
    }

    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (_err) {
      throw new Error('clawd.invoke expected JSON response');
    }

    // Preferred: { ok: true, result: ... }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'ok' in parsed) {
      if (parsed.ok !== true) {
        const msg = parsed?.error?.message ?? 'Unknown error';
        throw new Error(`clawd.invoke tool error: ${msg}`);
      }
      const result = parsed.result;
      const items = Array.isArray(result) ? result : [result];
      return { output: asStream(items) };
    }

    // Compatibility: raw JSON result
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return { output: asStream(items) };
  },
};

async function* asStream(items) {
  for (const item of items) yield item;
}
