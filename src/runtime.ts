import { createJsonRenderer } from "./renderers/json.js";

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
}) {
  if (dryRun) {
    return dryRunPipeline({ pipeline, registry, stderr });
  }

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
    cwd,
    llmAdapters,
    signal,
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

async function* emptyStream() {}
