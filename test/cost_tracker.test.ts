import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { CostTracker } from "../src/core/cost_tracker.js";
import { runWorkflowFile } from "../src/workflows/file.js";

test("CostTracker records usage and computes totals", () => {
  const tracker = new CostTracker();
  tracker.recordUsage("step1", "gpt-4o", { inputTokens: 1000, outputTokens: 500 });
  const summary = tracker.getSummary();
  assert.equal(summary.totalInputTokens, 1000);
  assert.equal(summary.totalOutputTokens, 500);
  assert.equal(summary.estimatedCostUsd, 0.0075);
  assert.equal(summary.byStep.length, 1);
  assert.equal(summary.byStep[0].stepId, "step1");
});

test("CostTracker handles OpenAI token field names", () => {
  const tracker = new CostTracker();
  tracker.recordUsage("step1", "gpt-4o", { prompt_tokens: 1000, completion_tokens: 500 });
  const summary = tracker.getSummary();
  assert.equal(summary.totalInputTokens, 1000);
  assert.equal(summary.totalOutputTokens, 500);
});

function captureWritable() {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (d: Buffer | string) => {
    output += String(d);
  });
  return { stream, output: () => output };
}

test("CostTracker uses zero cost for unknown models and warns once", () => {
  const stderr = captureWritable();
  const tracker = new CostTracker(undefined, stderr.stream);
  tracker.recordUsage("step1", "unknown-model", { inputTokens: 1000, outputTokens: 500 });
  tracker.recordUsage("step2", "unknown-model", { inputTokens: 1000, outputTokens: 500 });
  const summary = tracker.getSummary();
  assert.equal(summary.estimatedCostUsd, 0);
  assert.equal(
    stderr.output().match(/No LLM pricing configured for model "unknown-model"/g)?.length,
    1,
  );
});

test("CostTracker warns when usage omits the model id", () => {
  const stderr = captureWritable();
  const tracker = new CostTracker({ "": { input: 100, output: 100 } }, stderr.stream);
  tracker.recordUsage("step1", null, { inputTokens: 1000, outputTokens: 500 });
  tracker.recordUsage("step2", "", { inputTokens: 1000, outputTokens: 500 });
  tracker.recordUsage("step3", "   ", { inputTokens: 1000, outputTokens: 500 });
  const summary = tracker.getSummary();
  assert.equal(summary.estimatedCostUsd, 0);
  assert.equal(stderr.output().match(/model "<missing>"/g)?.length, 1);
});

test("CostTracker treats inherited object keys as unknown model ids", () => {
  const stderr = captureWritable();
  const tracker = new CostTracker(undefined, stderr.stream);
  tracker.recordUsage("step1", "constructor", { inputTokens: 1000, outputTokens: 500 });
  const summary = tracker.getSummary();
  assert.equal(summary.estimatedCostUsd, 0);
  assert.equal(Number.isNaN(summary.byStep[0].costUsd), false);
  assert.match(stderr.output(), /No LLM pricing configured for model "constructor"/);
});

test("CostTracker warns when pricing env json is invalid", () => {
  const stderr = captureWritable();
  const pricing = CostTracker.parsePricingFromEnv(
    {
      LOBSTER_LLM_PRICING_JSON: "{not-json",
    },
    stderr.stream,
  );
  assert.equal(pricing, undefined);
  assert.match(stderr.output(), /Ignoring invalid LOBSTER_LLM_PRICING_JSON/);
});

test("CostTracker rejects structurally invalid pricing env json", () => {
  const stderr = captureWritable();
  const pricing = CostTracker.parsePricingFromEnv(
    {
      LOBSTER_LLM_PRICING_JSON: '{"my-model":{"input":1.0}}',
    },
    stderr.stream,
  );
  assert.equal(pricing, undefined);
  assert.match(stderr.output(), /Ignoring invalid LOBSTER_LLM_PRICING_JSON/);
});

test("CostTracker rejects blank pricing model keys", () => {
  const stderr = captureWritable();
  const pricing = CostTracker.parsePricingFromEnv(
    {
      LOBSTER_LLM_PRICING_JSON: '{"":{"input":1.0,"output":2.0}}',
    },
    stderr.stream,
  );
  assert.equal(pricing, undefined);
  assert.match(stderr.output(), /Ignoring invalid LOBSTER_LLM_PRICING_JSON/);
});

test("CostTracker supports custom pricing from env json", () => {
  const pricing = CostTracker.parsePricingFromEnv({
    LOBSTER_LLM_PRICING_JSON: '{"my-model":{"input":1.0,"output":2.0}}',
  });
  const tracker = new CostTracker(pricing);
  tracker.recordUsage("step1", "my-model", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(tracker.getSummary().estimatedCostUsd, 3);
});

test("CostTracker checkLimit throws when action=stop and limit exceeded", () => {
  const tracker = new CostTracker();
  tracker.recordUsage("step1", "gpt-4o", { inputTokens: 10_000_000, outputTokens: 10_000_000 });
  assert.throws(() => tracker.checkLimit({ max_usd: 0.01, action: "stop" }), /Cost limit exceeded/);
});

test("CostTracker checkLimit warns when action=warn and limit exceeded", () => {
  const tracker = new CostTracker();
  tracker.recordUsage("step1", "gpt-4o", { inputTokens: 10_000_000, outputTokens: 10_000_000 });
  const stderr = new PassThrough();
  let out = "";
  stderr.on("data", (d: Buffer | string) => {
    out += String(d);
  });
  tracker.checkLimit({ max_usd: 0.01, action: "warn" }, stderr);
  assert.match(out, /\[WARN\] Cost/);
});

async function runWorkflow(workflow: unknown, envOverride?: Record<string, string>) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-"));
  const stateDir = path.join(tmpDir, "state");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");
  const stderr = new PassThrough();
  let stderrOutput = "";
  stderr.on("data", (d: Buffer | string) => {
    stderrOutput += String(d);
  });

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir, ...envOverride },
      mode: "tool",
    },
  });

  return { result, stderrOutput };
}

test("workflow result includes _meta.cost when usage is present", async () => {
  const { result } = await runWorkflow({
    steps: [
      {
        id: "llm",
        command:
          "node -e \"process.stdout.write(JSON.stringify({model:'gpt-4o',usage:{inputTokens:100,outputTokens:50},output:{text:'hi'}}))\"",
      },
    ],
  });

  assert.equal(result.status, "ok");
  assert.ok(result._meta?.cost);
  assert.equal(result._meta!.cost!.totalInputTokens, 100);
  assert.equal(result._meta!.cost!.totalOutputTokens, 50);
  assert.equal(result._meta!.cost!.byStep[0].model, "gpt-4o");
});

test("workflow result omits _meta.cost when no usage exists", async () => {
  const { result } = await runWorkflow({
    steps: [{ id: "plain", command: 'echo "hello"' }],
  });
  assert.equal(result.status, "ok");
  assert.equal(result._meta, undefined);
});

test("cost_limit warn logs warning and continues", async () => {
  const { result, stderrOutput } = await runWorkflow({
    cost_limit: { max_usd: 0.00001, action: "warn" },
    steps: [
      {
        id: "llm",
        command:
          "node -e \"process.stdout.write(JSON.stringify({model:'gpt-4o',usage:{inputTokens:1000,outputTokens:1000}}))\"",
      },
      { id: "after", command: "echo done" },
    ],
  });
  assert.equal(result.status, "ok");
  assert.match(stderrOutput, /\[WARN\] Cost/);
  assert.deepEqual(result.output, ["done\n"]);
});

test("cost_limit stop throws when exceeded", async () => {
  await assert.rejects(
    () =>
      runWorkflow({
        cost_limit: { max_usd: 0.00001, action: "stop" },
        steps: [
          {
            id: "llm",
            command:
              "node -e \"process.stdout.write(JSON.stringify({model:'gpt-4o',usage:{inputTokens:1000,outputTokens:1000}}))\"",
          },
        ],
      }).then((x) => x.result),
    /Cost limit exceeded/,
  );
});

test("workflow cost tracking warns for unknown model ids", async () => {
  const { result, stderrOutput } = await runWorkflow({
    cost_limit: { max_usd: 0.00001, action: "warn" },
    steps: [
      {
        id: "llm",
        command:
          "node -e \"process.stdout.write(JSON.stringify({model:'unknown-model',usage:{inputTokens:1000,outputTokens:1000}}))\"",
      },
    ],
  });

  assert.equal(result.status, "ok");
  assert.equal(result._meta?.cost?.estimatedCostUsd, 0);
  assert.match(stderrOutput, /No LLM pricing configured for model "unknown-model"/);
});

test("workflow cost tracking warns for invalid pricing env json", async () => {
  const { result, stderrOutput } = await runWorkflow(
    {
      steps: [
        {
          id: "llm",
          command:
            "node -e \"process.stdout.write(JSON.stringify({model:'gpt-4o',usage:{inputTokens:1000,outputTokens:1000}}))\"",
        },
      ],
    },
    { LOBSTER_LLM_PRICING_JSON: "{not-json" },
  );

  assert.equal(result.status, "ok");
  assert.match(stderrOutput, /Ignoring invalid LOBSTER_LLM_PRICING_JSON/);
});

test("workflow cost tracking warns when usage omits the model id", async () => {
  const { result, stderrOutput } = await runWorkflow({
    steps: [
      {
        id: "llm",
        command:
          'node -e "process.stdout.write(JSON.stringify({usage:{inputTokens:1000,outputTokens:1000}}))"',
      },
    ],
  });

  assert.equal(result.status, "ok");
  assert.equal(result._meta?.cost?.estimatedCostUsd, 0);
  assert.match(stderrOutput, /No LLM pricing configured for model "<missing>"/);
});

test("CostTracker escapes unknown model ids in warnings", () => {
  const stderr = captureWritable();
  const tracker = new CostTracker(undefined, stderr.stream);
  tracker.recordUsage("step1", "bad\n\u001b[31m\u009b31m\u2028next\u2029line", {
    inputTokens: 1,
    outputTokens: 1,
  });
  assert.ok(stderr.output().includes('"bad\\n\\u001b[31m\\u009b31m\\u2028next\\u2029line"'));
  assert.equal(stderr.output().includes("\u009b"), false);
  assert.equal(stderr.output().includes("\u2028"), false);
  assert.equal(stderr.output().includes("\u2029"), false);
});
