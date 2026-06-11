import { createJsonRenderer } from "./renderers/json.js";
import {
  InputRequestSuspension,
  RequestInputResumeError,
  assertRequestInputResumeConsumed,
  createInputTracker,
  createStageRequestInput,
  type CommandInputResume,
} from "./input_request.js";

export async function runPipeline({
  pipeline,
  registry,
  stdin,
  stdout,
  stderr,
  env,
  mode = "human",
  input,
  cwd = undefined,
  llmAdapters = undefined,
  signal = undefined,
  dryRun = false,
  requestInputResume = undefined,
  requestInputEnabled = true,
}: {
  pipeline: any[];
  registry: any;
  stdin: any;
  stdout: any;
  stderr: any;
  env: any;
  mode?: string;
  input?: any;
  cwd?: string | undefined;
  llmAdapters?: Record<string, any> | undefined;
  signal?: AbortSignal | undefined;
  dryRun?: boolean;
  requestInputResume?: CommandInputResume | undefined;
  requestInputEnabled?: boolean;
}) {
  if (dryRun) {
    return dryRunPipeline({ pipeline, registry, stderr });
  }

  let stream = input ?? [];
  let rendered = false;
  let halted = false;
  let haltedAt = null;
  let pipelineOutputStarted = false;

  const baseCtx = {
    stdin,
    stdout,
    stderr,
    env,
    registry,
    mode,
    cwd,
    llmAdapters,
    signal,
  };

  for (let idx = 0; idx < pipeline.length; idx++) {
    const stage = pipeline[idx];
    const command = registry.get(stage.name);
    if (!command) {
      throw new Error(`Unknown command: ${stage.name}`);
    }

    const inputTracker = createInputTracker(stream);
    const stageResume = idx === 0 ? requestInputResume : undefined;
    let commandActive = true;
    let inactiveReason: string | undefined;
    let commandOutputStarted = false;
    let stageFinished = false;
    async function finishStage({ assertResume = true, suppressCloseErrors = false } = {}) {
      if (stageFinished) return;
      stageFinished = true;
      commandActive = false;
      inputTracker.disableReplay();
      await inputTracker.close({ suppressErrors: suppressCloseErrors });
      if (assertResume) assertRequestInputResumeConsumed(stageResume);
    }
    const stageStdout = trackWritableOutput(stdout, () => {
      pipelineOutputStarted = true;
    });
    const ctx = {
      ...baseCtx,
      stdout: stageStdout,
      render: createJsonRenderer(stageStdout),
    };
    const stageCtx = {
      ...ctx,
      requestInput: requestInputEnabled
        ? createStageRequestInput({
            ctx,
            stageIndex: idx,
            mode,
            inputTracker,
            isCommandActive: () => commandActive,
            getInactiveReason: () => inactiveReason,
            isOutputStarted: () => pipelineOutputStarted || commandOutputStarted,
            resume: stageResume,
          })
        : createUnsupportedRequestInput(),
    };

    let result;
    try {
      result = await command.run({ input: inputTracker.iterable, args: stage.args, ctx: stageCtx });
    } catch (err) {
      await finishStage({ assertResume: false, suppressCloseErrors: true });
      if (haltForInputRequest(err)) break;
      assertNoUnconsumedResumeAfterError(stageResume, err);
      throw err;
    }

    if (result?.rendered) {
      rendered = true;
    }

    const output = result?.output;
    if (Array.isArray(output)) {
      stream = output;
      await finishStage();
    } else if (output && !result?.halt && idx < pipeline.length - 1) {
      commandActive = false;
      inactiveReason = "requestInput cannot suspend from lazy output before downstream stages";
      assertRequestInputResumeConsumed(stageResume);
      stream = trackCommandOutput(
        output,
        () => {
          commandOutputStarted = true;
        },
        () => assertRequestInputResumeConsumed(stageResume),
        (err) => assertNoUnconsumedResumeAfterError(stageResume, err),
        finishStage,
      );
    } else {
      stream = output
        ? trackCommandOutput(
            output,
            () => {
              commandOutputStarted = true;
            },
            () => assertRequestInputResumeConsumed(stageResume),
            (err) => assertNoUnconsumedResumeAfterError(stageResume, err),
            finishStage,
          )
        : [];
      if (!output) await finishStage();
    }

    if (result?.halt) {
      halted = true;
      haltedAt = { index: idx, stage };
      break;
    }
  }

  const items = [];
  try {
    for await (const item of stream) items.push(item);
  } catch (err) {
    if (haltForInputRequest(err)) {
      items.length = 0;
      for await (const item of stream) items.push(item);
    } else {
      throw err;
    }
  }
  assertRequestInputResumeConsumed(requestInputResume);

  return { items, rendered, halted, haltedAt };

  function haltForInputRequest(err: unknown) {
    if (!(err instanceof InputRequestSuspension)) return false;
    const stageIndex = err.stageIndex;
    halted = true;
    haltedAt = {
      index: stageIndex,
      stage: pipeline[stageIndex],
      inPlace: true,
    };
    stream = streamFromItems([err.request]);
    return true;
  }
}

function dryRunPipeline({
  pipeline,
  registry,
  stderr,
}: {
  pipeline: any[];
  registry: any;
  stderr: any;
}) {
  const lines: string[] = [];
  lines.push(`[DRY RUN] Pipeline (${pipeline.length} stage${pipeline.length !== 1 ? "s" : ""}):`);

  for (let idx = 0; idx < pipeline.length; idx++) {
    const stage = pipeline[idx];
    const command = registry.get(stage.name);
    if (!command) {
      throw new Error(`Unknown command: ${stage.name}`);
    }
    const formattedArgs = stage.args ? formatStageArgs(stage.args) : "";
    const argsStr = formattedArgs ? `  args: ${formattedArgs}` : "";
    lines.push(`  ${idx + 1}. ${stage.name}${argsStr}`);
  }

  lines.push("");
  stderr.write(lines.join("\n"));
  // Return rendered:true so the CLI does not print an empty JSON array to stdout.
  return { items: [], rendered: true, halted: false, haltedAt: null };
}

function formatStageArgs(args: Record<string, unknown>) {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (key === "_") {
      const positional = Array.isArray(value) ? value : [value];
      for (const v of positional) {
        if (v !== undefined && v !== null) parts.push(String(v));
      }
    } else {
      parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  }
  return parts.join(", ");
}

function streamFromItems(items: unknown[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

function trackCommandOutput(
  output: AsyncIterable<unknown> | Iterable<unknown>,
  markOutput: () => void,
  assertResumeConsumed: () => void,
  assertNoUnconsumedResumeAfterError: (err: unknown) => void,
  finishStage: (options?: {
    assertResume?: boolean;
    suppressCloseErrors?: boolean;
  }) => Promise<void>,
) {
  return (async function* () {
    let completed = false;
    try {
      for await (const item of output) {
        assertResumeConsumed();
        markOutput();
        yield item;
      }
      completed = true;
    } catch (err) {
      await finishStage({ assertResume: false, suppressCloseErrors: true });
      assertNoUnconsumedResumeAfterError(err);
      throw err;
    } finally {
      await finishStage({ assertResume: completed });
    }
  })();
}

function assertNoUnconsumedResumeAfterError(resume: CommandInputResume | undefined, err: unknown) {
  if (err instanceof RequestInputResumeError) return;
  assertRequestInputResumeConsumed(resume);
}

function trackWritableOutput(stdout: any, markOutput: () => void) {
  return new Proxy(stdout, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "write" || prop === "end") {
        return (...args: unknown[]) => {
          markOutput();
          return value.apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createUnsupportedRequestInput() {
  const requestInput = async function requestInput() {
    throw new Error("requestInput is not supported in this pipeline context");
  };
  requestInput.getSuspendedState = function getSuspendedState() {
    return undefined;
  };
  return requestInput;
}
