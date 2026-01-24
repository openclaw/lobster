function getByPath(obj: any, path: string): any {
  if (!path) return obj;
  const parts = path.split('.').filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export const dedupeCommand = {
  name: 'dedupe',
  meta: {
    description: 'Remove duplicate items, keeping first occurrence (stable)',
    argsSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Dot-path key used for identity (defaults to whole item)' },
        _: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
    sideEffects: [],
  },
  help() {
    return (
      `dedupe — remove duplicate items (stable)\n\n` +
      `Usage:\n` +
      `  ... | dedupe\n` +
      `  ... | dedupe --key id\n\n` +
      `Notes:\n` +
      `  - Keeps the first occurrence.\n`
    );
  },
  async run({ input, args }: any) {
    const key = typeof args.key === 'string' ? args.key : undefined;
    const seen = new Set<string>();

    return {
      output: (async function* () {
        for await (const item of input) {
          const id = key ? getByPath(item, key) : item;
          const k = JSON.stringify(id);
          if (seen.has(k)) continue;
          seen.add(k);
          yield item;
        }
      })(),
    };
  },
};
