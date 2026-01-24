import fs from 'node:fs/promises';

function getByPath(obj: any, path: string): any {
  if (path === '.' || path === 'this') return obj;
  const parts = path.split('.').filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function renderTemplate(tpl: string, ctx: any): string {
  return tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr) => {
    const key = String(expr ?? '').trim();
    const val = getByPath(ctx, key);
    if (val === undefined || val === null) return '';
    if (typeof val === 'string') return val;
    return JSON.stringify(val);
  });
}

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
