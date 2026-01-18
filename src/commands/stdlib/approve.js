function isInteractive(stdin) {
  return Boolean(stdin.isTTY);
}

export const approveCommand = {
  name: 'approve',
  help() {
    return `approve — require confirmation to continue\n\nUsage:\n  ... | approve --prompt "Send these emails?"\n  ... | approve --emit --prompt "Send these emails?"\n\nModes:\n  - Interactive (default): prompts on TTY and passes items through if approved.\n  - Emit (--emit): returns an approval request object and stops the pipeline.\n\nNotes:\n  - Default behavior fails closed in non-interactive mode.\n`;
  },
  async run({ input, args, ctx }) {
    const prompt = args.prompt ?? 'Approve?';

    const items = [];
    for await (const item of input) items.push(item);

    if (args.emit) {
      return {
        output: (async function* () {
          yield {
            type: 'approval_request',
            prompt,
            items,
          };
        })(),
      };
    }

    if (!isInteractive(ctx.stdin)) {
      throw new Error('approve requires an interactive TTY (or pass --emit)');
    }

    ctx.stdout.write(`${prompt} [y/N] `);
    const answer = await readLine(ctx.stdin);

    if (!/^y(es)?$/i.test(String(answer).trim())) {
      throw new Error('Not approved');
    }

    return { output: asStream(items) };
  },
};

function readLine(stdin) {
  return new Promise((resolve) => {
    let buf = '';

    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        stdin.off('data', onData);
        resolve(buf.slice(0, idx));
      }
    };

    stdin.on('data', onData);
  });
}

async function* asStream(items) {
  for (const item of items) yield item;
}
