export const headCommand = {
  name: 'head',
  meta: {
    description: 'Take first N items',
    argsSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'Number of items to take', default: 10 },
        _: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
    sideEffects: [],
  },
  help() {
    return `head — take first N items\n\nUsage:\n  head --n 10\n`;
  },
  async run({ input, args }) {
    const n = args.n === undefined ? 10 : Number(args.n);
    if (!Number.isFinite(n) || n < 0) throw new Error('head --n must be a non-negative number');

    return {
      output: (async function* () {
        let i = 0;
        for await (const item of input) {
          if (i++ >= n) break;
          yield item;
        }
      })(),
    };
  },
};
