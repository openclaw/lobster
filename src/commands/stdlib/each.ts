import { runPipeline } from '../../runtime.js';
import { renderTemplate } from './template_utils.js';

function interpolateStages(stages: any[], item: any): any[] {
  return stages.map((stage) => {
    const args = interpolateArgs(stage.args, item);
    return { ...stage, args };
  });
}

function interpolateArgs(args: any, item: any): any {
  const out: any = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === '_body') {
      out._body = interpolateStages(value as any[], item);
    } else if (key === '_bodyRaw') {
      out._bodyRaw = value;  // raw text, not a template
    } else if (key === '_') {
      out._ = (value as any[]).map((v) =>
        typeof v === 'string' ? renderTemplate(v, item) : v,
      );
    } else if (typeof value === 'string') {
      out[key] = renderTemplate(value, item);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const eachCommand = {
  name: 'each',
  meta: {
    description: 'Run a sub-pipeline for each input item',
    argsSchema: {
      type: 'object',
      properties: {
        _body: { description: 'Parsed sub-pipeline stages (injected by parser)' },
      },
      required: [],
    },
    sideEffects: ['delegates_to_sub_pipeline'],
  },
  help() {
    return (
      `each — run a sub-pipeline for each input item\n\n` +
      `Usage:\n` +
      `  ... | each { template --text "hello {{.name}}" }\n` +
      `  ... | each { map --unwrap url | exec curl "{{.}}" }\n\n` +
      `Notes:\n` +
      `  - Each item is fed into the sub-pipeline as a single-element stream.\n` +
      `  - {{.field}} interpolation is applied to all string args per item.\n` +
      `  - Template patterns ({{...}}) in item field values will be interpolated.\n` +
      `  - Errors in any iteration propagate immediately (fail-fast).\n` +
      `  - Items are processed sequentially.\n`
    );
  },
  async run({ input, args, ctx }: any) {
    const bodyStages = args._body;
    if (!Array.isArray(bodyStages) || bodyStages.length === 0) {
      throw new Error('each requires a { sub-pipeline } body');
    }

    return {
      output: (async function* () {
        for await (const item of input) {
          const interpolated = interpolateStages(bodyStages, item);
          const result = await runPipeline({
            pipeline: interpolated,
            registry: ctx.registry,
            stdin: ctx.stdin,
            stdout: ctx.stdout,
            stderr: ctx.stderr,
            env: ctx.env,
            mode: ctx.mode,
            input: (async function* () { yield item; })(),
          });
          for (const out of result.items) {
            yield out;
          }
        }
      })(),
    };
  },
};
