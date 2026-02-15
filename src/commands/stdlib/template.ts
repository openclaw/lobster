import fs from 'node:fs/promises';
import { renderTemplate } from './template_utils.js';

export const templateCommand = {
  name: 'template',
  meta: {
    description: 'Render a simple {{path}} template against each input item',
    argsSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Template text (supports {{path}}; {{.}} for the whole item)' },
        file: { type: 'string', description: 'Template file path' },
        _: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
    sideEffects: [],
  },
  help() {
    return (
      `template — render a simple template against each item\n\n` +
      `Usage:\n` +
      `  ... | template --text 'PR {{number}}: {{title}}'\n` +
      `  ... | template --file ./draft.txt\n\n` +
      `Template syntax:\n` +
      `  - {{field}} or {{nested.field}}\n` +
      `  - {{.}} for the whole item\n` +
      `  - Missing values render as empty string\n`
    );
  },
  async run({ input, args }: any) {
    let tpl = typeof args.text === 'string' ? args.text : undefined;
    const file = typeof args.file === 'string' ? args.file : undefined;

    if (!tpl && file) {
      tpl = await fs.readFile(file, 'utf8');
    }

    if (!tpl) {
      const positional = Array.isArray(args._) ? args._ : [];
      if (positional.length) tpl = positional.join(' ');
    }

    if (!tpl) throw new Error('template requires --text or --file (or positional text)');

    return {
      output: (async function* () {
        for await (const item of input) {
          yield renderTemplate(String(tpl), item);
        }
      })(),
    };
  },
};
