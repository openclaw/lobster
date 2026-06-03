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

test("CostTracker uses zero cost for unknown models", () => {
  const tracker = new CostTracker();
  tracker.recordUsage("step1", "unknown-model", { inputTokens: 1000, outputTokens: 500 });
  const summary = tracker.getSummary();
  assert.equal(summary.estimatedCostUsd, 0);
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
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir, ...(envOverride ?? {}) },
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
