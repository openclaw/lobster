import { promises as fsp } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

export const fileReadCommand = {
  name: 'file.read',
  meta: {
    description: 'Read a file and yield its contents into the pipeline',
    argsSchema: {
      type: 'object',
      properties: {
        _: { type: 'array', items: { type: 'string' }, description: 'File path' },
        path: { type: 'string', description: 'File path (alternative to positional)' },
        format: { type: 'string', enum: ['auto', 'text', 'json', 'jsonl'], description: 'Parse format (default: auto)' },
      },
      required: ['_'],
    },
    sideEffects: ['reads_fs'],
  },
  help() {
    return `file.read — read a file and yield its contents\n\n` +
      `Usage:\n` +
      `  file.read <path> [--format auto|text|json|jsonl]\n\n` +
      `Formats:\n` +
      `  auto (default): try JSON parse; if array yield elements; else try JSONL; else text\n` +
      `  json:  parse as JSON; yield elements if array, else single item\n` +
      `  jsonl: split lines, parse each as JSON\n` +
      `  text:  yield entire content as a single string\n\n` +
      `Notes:\n` +
      `  - Replaces the pipeline stream; upstream items are discarded.\n\n` +
      `Security:\n` +
      `  Paths are unrestricted (same as exec). This command can read any file\n` +
      `  accessible to the process.\n`;
  },
  async run({ input, args }) {
    // Drain input (file replaces pipeline input).
    for await (const _item of input) { /* no-op */ }

    const filePath = args._[0] || args.path;
    if (!filePath) throw new Error('file.read requires a path');

    const resolved = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
    const format = (args.format ?? 'auto').toLowerCase();
    const VALID_FORMATS = ['auto', 'text', 'json', 'jsonl'];
    if (!VALID_FORMATS.includes(format)) {
      throw new Error(`file.read: unknown format '${format}'`);
    }

    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
    const stat = await fsp.stat(resolved);
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(`file.read: file exceeds maximum size (${stat.size} bytes > ${MAX_FILE_SIZE} bytes)`);
    }
    const content = await fsp.readFile(resolved, 'utf8');

    if (format === 'text') {
      return { output: asStream([content]) };
    }

    if (format === 'json') {
      const parsed = JSON.parse(content);
      return { output: asStream(Array.isArray(parsed) ? parsed : [parsed]) };
    }

    if (format === 'jsonl') {
      const items = content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      return { output: asStream(items) };
    }

    // auto: try JSON, then JSONL, then text.
    try {
      const parsed = JSON.parse(content);
      return { output: asStream(Array.isArray(parsed) ? parsed : [parsed]) };
    } catch { /* not JSON */ }

    const lines = content.split(/\r?\n/).filter(Boolean);
    if (lines.length > 0 && lines.every((line) => { try { JSON.parse(line); return true; } catch { return false; } })) {
      return { output: asStream(lines.map((line) => JSON.parse(line))) };
    }

    return { output: asStream([content]) };
  },
};

async function* asStream(items) {
  for (const item of items) yield item;
}
