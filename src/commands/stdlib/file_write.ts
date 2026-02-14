import { promises as fsp } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';

export const fileWriteCommand = {
  name: 'file.write',
  meta: {
    description: 'Write pipeline items to a file and pass them through',
    argsSchema: {
      type: 'object',
      properties: {
        _: { type: 'array', items: { type: 'string' }, description: 'File path' },
        path: { type: 'string', description: 'File path (alternative to positional)' },
        format: { type: 'string', enum: ['json', 'jsonl', 'text'], description: 'Output format (default: json)' },
        mkdir: { type: 'boolean', description: 'Create parent directories (default: true)' },
      },
      required: ['_'],
    },
    sideEffects: ['writes_fs'],
  },
  help() {
    return `file.write — write pipeline items to a file\n\n` +
      `Usage:\n` +
      `  <items> | file.write <path> [--format json|jsonl|text] [--mkdir true|false]\n\n` +
      `Formats:\n` +
      `  json (default): JSON with 2-space indent; single item unwrapped, multiple as array\n` +
      `  jsonl: one JSON-serialized item per line\n` +
      `  text:  items joined with newline; non-strings JSON-serialized\n\n` +
      `Notes:\n` +
      `  - Tee semantics: all collected items are yielded downstream after write.\n` +
      `  - --mkdir (default true) creates parent directories if needed.\n`;
  },
  async run({ input, args }) {
    const filePath = args._[0] || args.path;
    if (!filePath) throw new Error('file.write requires a path');

    const resolved = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
    const format = (args.format ?? 'json').toLowerCase();
    const mkdirEnabled = args.mkdir !== false;

    const items = [];
    for await (const item of input) items.push(item);

    let content;
    if (format === 'json') {
      const value = items.length === 1 ? items[0] : items;
      content = JSON.stringify(value, null, 2) + '\n';
    } else if (format === 'jsonl') {
      content = items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
    } else if (format === 'text') {
      content = items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n') + (items.length ? '\n' : '');
    } else {
      throw new Error(`file.write: unknown format '${format}'`);
    }

    if (mkdirEnabled) {
      await fsp.mkdir(dirname(resolved), { recursive: true });
    }

    await fsp.writeFile(resolved, content, 'utf8');

    return { output: asStream(items) };
  },
};

async function* asStream(items) {
  for (const item of items) yield item;
}
