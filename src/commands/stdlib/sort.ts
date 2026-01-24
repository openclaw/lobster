function getByPath(obj: any, path: string): any {
  if (!path) return undefined;
  const parts = path.split('.').filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function defaultCompare(a: any, b: any): number {
  // Treat undefined/null as last
  const aU = a === undefined || a === null;
  const bU = b === undefined || b === null;
  if (aU && bU) return 0;
  if (aU) return 1;
  if (bU) return -1;

  // number compare if both numbers
  if (typeof a === 'number' && typeof b === 'number') return a - b;

  // date-ish compare if both look like ISO/date strings?
  // Keep it simple: string compare for everything else.
  return String(a).localeCompare(String(b));
}

export const sortCommand = {
  name: 'sort',
  meta: {
    description: 'Sort items (stable) by a key or by stringified value',
    argsSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Dot-path key to sort by (e.g. updatedAt, pr.number)' },
        desc: { type: 'boolean', description: 'Sort descending' },
        _: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
    sideEffects: [],
  },
  help() {
    return (
      `sort — sort items (stable) by a key\n\n` +
      `Usage:\n` +
      `  ... | sort\n` +
      `  ... | sort --key updatedAt\n` +
      `  ... | sort --key prNumber --desc\n\n` +
      `Notes:\n` +
      `  - Sorting is stable (preserves order for equal keys).\n` +
      `  - undefined/null keys sort last.\n`
    );
  },
  async run({ input, args }: any) {
    const key = typeof args.key === 'string' ? args.key : undefined;
    const desc = Boolean(args.desc);

    const items: any[] = [];
    let idx = 0;
    for await (const item of input) {
      items.push({ item, idx });
      idx++;
    }

    items.sort((a, b) => {
      const av = key ? getByPath(a.item, key) : a.item;
      const bv = key ? getByPath(b.item, key) : b.item;
      const c = defaultCompare(av, bv);
      if (c !== 0) return desc ? -c : c;
      // stable tie-break
      return a.idx - b.idx;
    });

    return {
      output: (async function* () {
        for (const x of items) yield x.item;
      })(),
    };
  },
};
