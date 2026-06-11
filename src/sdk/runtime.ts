/**
 * SDK Runtime - Executes Lobster pipelines
 *
 * This adapts SDK stages to the core runtime so command-level suspension rules
 * stay identical across CLI, tool mode, and SDK entry points.
 */

import { runPipeline as runCorePipeline } from "../runtime.js";

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

function normalizeSdkOutput(output) {
  if (output === null || output === undefined) return [];
  if (Array.isArray(output)) return output;
  if (
    typeof output?.[Symbol.asyncIterator] === "function" ||
    typeof output?.[Symbol.iterator] === "function"
  ) {
    return output;
  }
  return [output];
}

function createNullWritable() {
  return {
    write() {
      return true;
    },
    end() {
      return undefined;
    },
  };
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
export async function runPipelineInternal({
  stages,
  ctx,
  input = [],
  requestInputResume = undefined,
}) {
  const runtimeCtx = ctx ?? {};
  const pipeline = stages.map((_stage, index) => ({
    name: `sdk.stage.${index}`,
    args: {},
    raw: `sdk.stage.${index}`,
  }));
  const commands = new Map(
    stages.map((stage, index) => [
      `sdk.stage.${index}`,
      {
        async run({ input, ctx }) {
          const stageCtx = { ...runtimeCtx, ...ctx };
          if (typeof stage === "function") {
            const isGenerator =
              stage.constructor?.name === "AsyncGeneratorFunction" ||
              stage.constructor?.name === "GeneratorFunction";

            if (isGenerator) {
              return { output: normalizeSdkOutput(stage(input, stageCtx)) };
            }

            const items = await collectItems(input);
            return { output: normalizeSdkOutput(await stage(items, stageCtx)) };
          }

          if (typeof stage?.run === "function") {
            const result = await stage.run({ input, ctx: stageCtx });
            return result && "output" in result
              ? { ...result, output: normalizeSdkOutput(result.output) }
              : result;
          }

          throw new Error(
            `Invalid stage at index ${index}: must be a function or have run() method`,
          );
        },
      },
    ]),
  );
  const stdout = runtimeCtx.stdout ?? createNullWritable();
  const stderr = runtimeCtx.stderr ?? createNullWritable();

  return runCorePipeline({
    pipeline,
    registry: {
      get(name) {
        return commands.get(name);
      },
    },
    stdin: runtimeCtx.stdin ?? { isTTY: false },
    stdout,
    stderr,
    env: runtimeCtx.env ?? process.env,
    mode: runtimeCtx.mode ?? "sdk",
    cwd: runtimeCtx.cwd,
    llmAdapters: runtimeCtx.llmAdapters,
    signal: runtimeCtx.signal,
    input: normalizeSdkOutput(input),
    requestInputResume,
  });
}

/**
 * Re-export for compatibility with CLI runtime
 */
export async function runPipeline({
  pipeline,
  registry,
  stdin,
  stdout,
  stderr,
  env,
  mode = "human",
  input,
  requestInputResume = undefined,
  requestInputEnabled = true,
}) {
  return runCorePipeline({
    pipeline,
    registry,
    stdin,
    stdout,
    stderr,
    env,
    mode,
    input,
    requestInputResume,
    requestInputEnabled,
  });
}
