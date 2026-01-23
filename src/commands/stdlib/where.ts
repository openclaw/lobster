function parsePredicate(expr) {
  const m = expr.match(/^([a-zA-Z0-9_.]+)\s*(==|=|!=|<=|>=|<|>)\s*(.+)$/);
  if (!m) throw new Error(`Invalid where expression: ${expr}`);
  const [, path, op, rawValue] = m;

  let value = rawValue;
  if (rawValue === 'true') value = true;
  else if (rawValue === 'false') value = false;
  else if (rawValue === 'null') value = null;
  else if (!Number.isNaN(Number(rawValue)) && rawValue.trim() !== '') value = Number(rawValue);

  return { path, op: op === '=' ? '==' : op, value };
}

function getPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function compare(left, op, right) {
  switch (op) {
    case '==': return left == right; // intentional loose equality for convenience
    case '!=': return left != right;
    case '<': return left < right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '>=': return left >= right;
    default: throw new Error(`Unsupported operator: ${op}`);
  }
}

export const whereCommand = {
  name: 'where',
  meta: {
    description: 'Filter objects by a simple predicate',
    argsSchema: {
      type: 'object',
      properties: {
        _: {
          type: 'array',
          items: { type: 'string' },
          description: 'First positional arg is an expression like field=value or minutes>=30',
        },
      },
      required: ['_'],
    },
    sideEffects: [],
  },
  help() {
    return `where — filter objects by a simple predicate\n\nUsage:\n  ... | where unread=true\n  ... | where minutes>=30\n  ... | where sender.domain==example.com\n`;
  },
  async run({ input, args }) {
    const expr = args._[0];
    if (!expr) throw new Error('where requires an expression (e.g. field=value)');
    const pred = parsePredicate(expr);

    return {
      output: (async function* () {
        for await (const item of input) {
          const left = getPath(item, pred.path);
          if (compare(left, pred.op, pred.value)) yield item;
        }
      })(),
    };
  },
};
