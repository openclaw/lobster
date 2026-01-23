export const pickCommand = {
  name: 'pick',
  meta: {
    description: 'Project fields from objects',
    argsSchema: {
      type: 'object',
      properties: {
        _: {
          type: 'array',
          items: { type: 'string' },
          description: 'First positional arg is a comma-separated list of fields',
        },
      },
      required: ['_'],
    },
    sideEffects: [],
  },
  help() {
    return `pick — project fields from objects\n\nUsage:\n  ... | pick id,subject,from\n`;
  },
  async run({ input, args }) {
    const spec = args._[0];
    if (!spec) throw new Error('pick requires a comma-separated field list');
    const fields = spec.split(',').map((s) => s.trim()).filter(Boolean);

    return {
      output: (async function* () {
        for await (const item of input) {
          if (item === null || typeof item !== 'object') {
            yield item;
            continue;
          }
          const out = {};
          for (const f of fields) out[f] = item[f];
          yield out;
        }
      })(),
    };
  },
};
