export const commandsListCommand = {
  name: 'commands.list',
  help() {
    return (
      `commands.list — list available Lobster pipeline commands\n\n` +
      `Usage:\n` +
      `  commands.list\n\n` +
      `Notes:\n` +
      `  - Intended for agents (e.g. Clawdbot) to discover available pipeline stages dynamically.\n` +
      `  - Output includes the command name and a short description extracted from help().\n`
    );
  },
  async run({ input, ctx }) {
    // Drain input
    for await (const _ of input) {
      // no-op
    }

    const names = ctx.registry.list();
    const output = names.map((name) => {
      const cmd = ctx.registry.get(name);
      const help = typeof cmd?.help === 'function' ? String(cmd.help()) : '';
      const firstLine = help.split('\n').find((l) => l.trim().length > 0) ?? '';

      // Expected pattern: "name — description" but fall back to the line as-is.
      const desc = firstLine.includes('—') ? firstLine.split('—').slice(1).join('—').trim() : firstLine.trim();

      return {
        name,
        description: desc,
      };
    });

    return {
      output: (async function* () {
        for (const item of output) yield item;
      })(),
    };
  },
};
