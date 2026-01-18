import { diffAndStore } from '../../state/store.js';

export const diffLastCommand = {
  name: 'diff.last',
  help() {
    return `diff.last — compare current items to last stored snapshot\n\nUsage:\n  <items> | diff.last --key <stateKey>\n\nOutput:\n  { changed, key, before, after }\n`;
  },
  async run({ input, args, ctx }) {
    const key = args.key ?? args._[0];
    if (!key) throw new Error('diff.last requires --key');

    const afterItems = [];
    for await (const item of input) afterItems.push(item);

    const after = afterItems.length === 1 ? afterItems[0] : afterItems;
    const { before, changed } = await diffAndStore({ env: ctx.env, key, value: after });

    return {
      output: (async function* () {
        yield { kind: 'diff.last', key, changed, before, after };
      })(),
    };
  },
};
