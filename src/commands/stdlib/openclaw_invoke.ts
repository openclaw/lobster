export const openclawInvokeCommand = {
  name: 'openclaw.invoke',
  meta: {
    description: 'Call a local OpenClaw tool endpoint',
    argsSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'OpenClaw control URL (or OPENCLAW_URL)' },
        token: { type: 'string', description: 'Bearer token (or OPENCLAW_TOKEN)' },
        tool: { type: 'string', description: 'Tool name (e.g. message, cron, github, etc.)' },
        action: { type: 'string', description: 'Tool action' },
        'args-json': { type: 'string', description: 'JSON string of tool args' },
        sessionKey: { type: 'string', description: 'Optional session key attribution' },
        'session-key': { type: 'string', description: 'Alias for sessionKey' },
        dryRun: { type: 'boolean', description: 'Dry run' },
        'dry-run': { type: 'boolean', description: 'Alias for dryRun' },
        'merge-stdin': { type: 'boolean', description: 'Merge first stdin item fields into tool args (non-each mode)' },
        spread: { type: 'boolean', description: 'Spread item fields into args instead of nesting (each mode)' },
        _: { type: 'array', items: { type: 'string' } },
      },
      required: ['tool', 'action'],
    },
    sideEffects: ['calls_openclaw_tool'],
  },
  help() {
    return `openclaw.invoke — call a local OpenClaw tool endpoint\n\n` +
      `Usage:\n` +
      `  openclaw.invoke --tool message --action send --args-json '{"provider":"telegram","to":"...","message":"..."}'\n` +
      `  openclaw.invoke --tool message --action send --args-json '{...}' --dry-run\n` +
      `  ... | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'\n` +
      `  ... | openclaw.invoke --tool message --action send --merge-stdin --args-json '{"provider":"telegram","to":"..."}'\n` +
      `  ... | openclaw.invoke --tool message --action send --each --spread --args-json '{"provider":"telegram"}'\n\n` +
      `Config:\n` +
      `  - Uses OPENCLAW_URL env var by default (or pass --url). Falls back to CLAWD_URL.\n` +
      `  - Optional Bearer token via OPENCLAW_TOKEN env var (or pass --token). Falls back to CLAWD_TOKEN.\n` +
      `  - Optional attribution via --session-key <sessionKey>.\n\n` +
      `Flags:\n` +
      `  - --merge-stdin: In non-each mode, merge first stdin JSON object fields into tool args.\n` +
      `  - --spread: In each mode, spread item fields into args instead of nesting under item-key.\n\n` +
      `Notes:\n` +
      `  - This is a thin transport bridge. Lobster should not own OAuth/secrets.\n`;
  },
  async run({ input, args, ctx }) {
    const each = Boolean(args.each);
    const itemKey = String(args.itemKey ?? args['item-key'] ?? 'item');
    const mergeStdin = Boolean(args['merge-stdin']);
    const spread = Boolean(args.spread);

    // Try OPENCLAW_* first, fallback to CLAWD_* for compatibility
    const url = String(
      args.url ?? 
      ctx.env.OPENCLAW_URL ?? 
      ctx.env.CLAWD_URL ?? 
      ''
    ).trim();
    if (!url) throw new Error('openclaw.invoke requires --url, OPENCLAW_URL, or CLAWD_URL');

    const tool = args.tool;
    const action = args.action;
    if (!tool || !action) throw new Error('openclaw.invoke requires --tool and --action');

    const token = String(
      args.token ?? 
      ctx.env.OPENCLAW_TOKEN ?? 
      ctx.env.CLAWD_TOKEN ?? 
      ''
    ).trim();

    let toolArgs = {};
    if (args['args-json']) {
      try {
        toolArgs = JSON.parse(String(args['args-json']));
      } catch (_err) {
        throw new Error('openclaw.invoke --args-json must be valid JSON');
      }
    }

    if (each && (toolArgs === null || typeof toolArgs !== 'object' || Array.isArray(toolArgs))) {
      throw new Error('openclaw.invoke --each requires --args-json to be an object');
    }

    const endpoint = new URL('/tools/invoke', url);
    const sessionKey = args.sessionKey ?? args['session-key'] ?? null;
    const dryRun = args.dryRun ?? args['dry-run'] ?? null;

    const invokeOnce = async (argsValue) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : null),
        },
        body: JSON.stringify({
          tool: String(tool),
          action: String(action),
          args: argsValue,
          ...(sessionKey ? { sessionKey: String(sessionKey) } : null),
          ...(dryRun !== null ? { dryRun: Boolean(dryRun) } : null),
        }),
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`openclaw.invoke failed (${res.status}): ${text.slice(0, 400)}`);
      }

      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (_err) {
        throw new Error('openclaw.invoke expected JSON response');
      }

      // Preferred: { ok: true, result: ... }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'ok' in parsed) {
        if (parsed.ok !== true) {
          const msg = parsed?.error?.message ?? 'Unknown error';
          throw new Error(`openclaw.invoke tool error: ${msg}`);
        }
        const result = parsed.result;
        return Array.isArray(result) ? result : [result];
      }

      // Compatibility: raw JSON result
      return Array.isArray(parsed) ? parsed : [parsed];
    };

    if (!each) {
      // Handle stdin merging or draining
      if (mergeStdin) {
        for await (const item of input) {
          if (item && typeof item === 'object') {
            toolArgs = { ...toolArgs, ...item };
          }
          break; // only first item
        }
      } else {
        // Drain input: for now we don't stream input into openclaw calls.
        for await (const _item of input) {
          // no-op
        }
      }
      const items = await invokeOnce(toolArgs);
      return { output: asStream(items) };
    }

    return {
      output: (async function* () {
        for await (const item of input) {
          const argsValue = spread ? { ...toolArgs, ...item } : { ...toolArgs, [itemKey]: item };
          const items = await invokeOnce(argsValue);
          for (const outputItem of items) yield outputItem;
        }
      })(),
    };
  },
};

// Deprecated alias for backward compatibility
export const clawdInvokeCommand = {
  name: 'clawd.invoke',
  meta: {
    description: '[DEPRECATED] Use openclaw.invoke instead. Call a local OpenClaw tool endpoint',
    argsSchema: openclawInvokeCommand.meta.argsSchema,
    sideEffects: ['calls_openclaw_tool'],
    deprecated: true,
  },
  help() {
    return `clawd.invoke — [DEPRECATED] Use openclaw.invoke instead\n\n` +
      openclawInvokeCommand.help().replace(/openclaw\.invoke/g, 'clawd.invoke');
  },
  async run(context) {
    // Just delegate to the new command
    return openclawInvokeCommand.run(context);
  },
};

async function* asStream(items) {
  for (const item of items) yield item;
}