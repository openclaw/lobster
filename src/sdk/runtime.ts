/**
 * SDK Runtime - Executes Lobster pipelines
 *
 * This is adapted from the CLI runtime but designed for SDK use.
 */

/**
 * @typedef {Object} StageResult
 * @property {AsyncIterable|any[]} [output] - Output items
 * @property {boolean} [halt] - Whether to halt the pipeline
 * @property {boolean} [rendered] - Whether output was rendered
 */

/**
 * @typedef {Object} PipelineResult
 * @property {any[]} items - Collected output items
 * @property {boolean} halted - Whether pipeline halted
 * @property {Object|null} haltedAt - Stage where halt occurred
 */

/**
 * Convert various inputs to an async iterable
 * @param {any} input
 * @returns {AsyncIterable}
 */
async function* toAsyncIterable(input) {
  if (input === null || input === undefined) {
    return;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      yield item;
    }
    return;
  }

  if (typeof input[Symbol.asyncIterator] === 'function') {
    yield* input;
    return;
  }

  if (typeof input[Symbol.iterator] === 'function') {
    for (const item of input) {
      yield item;
    }
    return;
  }

  // Single item
  yield input;
}

/**
 * Collect async iterable to array
 * @param {AsyncIterable} iterable
 * @returns {Promise<any[]>}
 */
async function collectItems(iterable) {
  const items = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

/**
 * Run a pipeline of stages
 *
 * @param {Object} options
 * @param {Array<Function|Object>} options.stages - Pipeline stages
 * @param {Object} options.ctx - Execution context
 * @param {any[]} [options.input] - Initial input items
 * @returns {Promise<PipelineResult>}
 */
export async function runPipelineInternal({ stages, ctx, input = [] }) {
  let stream = toAsyncIterable(input);
  let halted = false;
  let haltedAt = null;

  for (let idx = 0; idx < stages.length; idx++) {
    const stage = stages[idx];

    let result;

    if (typeof stage === 'function') {
      // Check if it's a generator function
      const isGenerator = stage.constructor?.name === 'AsyncGeneratorFunction' ||
                          stage.constructor?.name === 'GeneratorFunction';

      if (isGenerator) {
        // Generator function - pass the stream directly
        result = { output: stage(stream, ctx) };
      } else {
        // Regular function - collect items first, then call
        const items = await collectItems(stream);
        const output = await stage(items, ctx);
        result = { output: toAsyncIterable(output) };
      }
    } else if (typeof stage?.run === 'function') {
      // Stage object with run method (primitives)
      result = await stage.run({ input: stream, ctx });
    } else {
      throw new Error(`Invalid stage at index ${idx}: must be a function or have run() method`);
    }

    // Handle halt
    if (result?.halt) {
      halted = true;
      haltedAt = { index: idx, stage };
      stream = result.output ?? toAsyncIterable([]);
      break;
    }

    stream = result?.output ?? toAsyncIterable([]);
  }

  // Collect final output
  const items = await collectItems(stream);

  return { items, halted, haltedAt };
}

/**
 * Re-export for compatibility with CLI runtime
 */
export async function runPipeline({ pipeline, registry, stdin, stdout, stderr, env, mode = 'human', input }) {
  // This wraps the CLI-style pipeline execution
  // Convert pipeline stages to functions using registry

  const stages = pipeline.map((stage) => {
    const command = registry.get(stage.name);
    if (!command) {
      throw new Error(`Unknown command: ${stage.name}`);
    }

    return {
      run: async ({ input, ctx }) => {
        return command.run({ input, args: stage.args, ctx });
      },
    };
  });

  const ctx = {
    stdin,
    stdout,
    stderr,
    env,
    mode,
  };

  return runPipelineInternal({
    stages,
    ctx,
    input: input ? await collectItems(input) : [],
  });
}
