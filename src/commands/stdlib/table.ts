function stringifyCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export const tableCommand = {
  name: 'table',
  meta: {
    description: 'Render items as a simple table',
    argsSchema: { type: 'object', properties: {}, required: [] },
    sideEffects: [],
  },
  help() {
    return `table — render items as a simple table\n\nUsage:\n  ... | table\n\nNotes:\n  - If items are objects, columns are union of keys (first 20 items).\n`;
  },
  async run({ input, ctx }) {
    const items = [];
    for await (const item of input) items.push(item);

    if (items.length === 0) {
      ctx.stdout.write('(no results)\n');
      return { output: emptyStream(), rendered: true };
    }

    const sample = items.slice(0, 20);
    const objectItems = sample.filter((x) => x && typeof x === 'object' && !Array.isArray(x));

    if (objectItems.length === sample.length) {
      const cols = [];
      const seen = new Set();
      for (const obj of objectItems) {
        for (const k of Object.keys(obj)) {
          if (!seen.has(k)) {
            seen.add(k);
            cols.push(k);
          }
        }
      }

      const rows = [cols, ...items.map((it) => cols.map((c) => stringifyCell(it?.[c])))]
        .map((row) => row.map((cell) => cell.replace(/\n/g, ' ')));

      const widths = cols.map((_, i) => Math.max(...rows.map((r) => r[i].length), 3));

      const renderRow = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');
      ctx.stdout.write(renderRow(rows[0]) + '\n');
      ctx.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n');
      for (const row of rows.slice(1)) ctx.stdout.write(renderRow(row) + '\n');

      return { output: emptyStream(), rendered: true };
    }

    // Fallback: render each item on a line.
    for (const item of items) ctx.stdout.write(stringifyCell(item) + '\n');
    return { output: emptyStream(), rendered: true };
  },
};

async function* emptyStream() {}
