import { createJsonRenderer } from './renderers/json.js';

export async function runPipeline({ pipeline, registry, stdin, stdout, stderr, env, mode = 'human', input }) {
  let stream = input ?? emptyStream();
  let rendered = false;
  let halted = false;
  let haltedAt = null;

  const ctx = {
    stdin,
    stdout,
    stderr,
    env,
    registry,
    mode,
    render: createJsonRenderer(stdout),
  };

  for (let idx = 0; idx < pipeline.length; idx++) {
    const stage = pipeline[idx];
    const command = registry.get(stage.name);
    if (!command) {
      throw new Error(`Unknown command: ${stage.name}`);
    }

    const result = await command.run({ input: stream, args: stage.args, ctx });

    if (result?.rendered) {
      rendered = true;
    }

    if (result?.halt) {
      halted = true;
      haltedAt = { index: idx, stage };
      stream = result.output ?? emptyStream();
      break;
    }

    stream = result?.output ?? emptyStream();
  }

  const items = [];
  for await (const item of stream) items.push(item);

  return { items, rendered, halted, haltedAt };
}

async function* emptyStream() {}
