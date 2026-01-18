export const jsonCommand = {
  name: 'json',
  help() {
    return `json — render pipeline output as JSON\n\nUsage:\n  ... | json\n`;
  },
  async run({ input, ctx }) {
    const items = [];
    for await (const item of input) items.push(item);
    ctx.render.json(items);
    return { output: emptyStream(), rendered: true };
  },
};

async function* emptyStream() {}
