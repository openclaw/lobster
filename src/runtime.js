import { createJsonRenderer } from './renderers/json.js';

export async function runPipeline({ pipeline, registry, stdin, stdout, stderr, env }) {
  let stream = emptyStream();
  let rendered = false;

  const ctx = {
    stdin,
    stdout,
    stderr,
    env,
    registry,
    render: createJsonRenderer(stdout),
  };

  for (const stage of pipeline) {
    const command = registry.get(stage.name);
    if (!command) {
      throw new Error(`Unknown command: ${stage.name}`);
    }

    const result = await command.run({ input: stream, args: stage.args, ctx });

    if (result && result.rendered) {
      rendered = true;
    }

    stream = result?.output ?? emptyStream();
  }

  const items = [];
  for await (const item of stream) items.push(item);

  return { items, rendered };
}

async function* emptyStream() {}
