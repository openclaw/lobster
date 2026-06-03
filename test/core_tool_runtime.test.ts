import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

import { resumeToolRequest, runToolRequest } from "../src/core/index.js";

function createDirectAdapter(resultText: string) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    adapter: {
      source: "test",
      async invoke({ payload }: { payload: Record<string, unknown> }) {
        calls.push(payload);
        return {
          ok: true,
          result: {
            runId: "adapter_1",
            model: "test/model",
            prompt: payload.prompt,
            status: "completed",
            output: {
              format: "json",
              text: resultText,
              data: JSON.parse(resultText),
            },
          },
        };
      },
    },
  };
}

test("runToolRequest executes pipeline with injected llm adapter", async () => {
  const { adapter, calls } = createDirectAdapter('{"recommendation":"no jacket"}');
  const envelope = await runToolRequest({
    pipeline:
      'exec --json=true node -e "process.stdout.write(JSON.stringify({location:\'Phoenix\',temp_f:73.8}))" | llm.invoke --provider pi --prompt "Should I wear a jacket?" --disable-cache',
    ctx: {
      env: {
        ...process.env,
        LOBSTER_LLM_PROVIDER: "pi",
        LOBSTER_LLM_MODEL: "test/model",
      },
      llmAdapters: {
        pi: adapter,
      },
    },
  });

  assert.equal(envelope.ok, true);
  assert.equal(envelope.status, "ok");
  assert.equal(envelope.output?.length, 1);
  assert.equal((envelope.output![0] as any).output.data.recommendation, "no jacket");
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as any).model, "test/model");
});

test("resumeToolRequest completes approval-gated workflow with injected llm adapter", async () => {
  const { adapter, calls } = createDirectAdapter('{"recommendation":"no","reason":"warm"}');
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-tool-runtime-"));
  const filePath = path.join(tmpDir, "workflow.lobster");

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: "fetch",
            run: "node -e \"process.stdout.write(JSON.stringify({location:'Phoenix',temp_f:73.8}))\"",
          },
          {
            id: "confirm",
            approval: "Want jacket advice?",
            stdin: "$fetch.json",
          },
          {
            id: "advice",
            pipeline: 'llm.invoke --provider pi --prompt "Return JSON." --disable-cache',
            stdin: "$fetch.json",
            when: "$confirm.approved",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
    LOBSTER_LLM_PROVIDER: "pi",
    LOBSTER_LLM_MODEL: "test/model",
  };

  const first = await runToolRequest({
    filePath,
    ctx: {
      cwd: tmpDir,
      env,
      llmAdapters: { pi: adapter },
    },
  });

  assert.equal(first.ok, true);
  assert.equal(first.status, "needs_approval");
  assert.ok(first.requiresApproval?.resumeToken);

  const resumed = await resumeToolRequest({
    token: first.requiresApproval?.resumeToken ?? "",
    approved: true,
    ctx: {
      cwd: tmpDir,
      env,
      llmAdapters: { pi: adapter },
    },
  });

  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, "ok");
  assert.equal((resumed.output![0] as any).output.data.reason, "warm");
  assert.equal(calls.length, 1);
});

test("runToolRequest/resumeToolRequest handles needs_input workflow pauses", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-core-tool-input-"));
  const filePath = path.join(tmpDir, "workflow.lobster");

  await fsp.writeFile(
    filePath,
    JSON.stringify(
      {
        steps: [
          {
            id: "draft",
            run: "node -e \"process.stdout.write(JSON.stringify({text:'hello'}))\"",
          },
          {
            id: "review",
            input: {
              prompt: "Review draft?",
              responseSchema: {
                type: "object",
                properties: { decision: { type: "string" } },
                required: ["decision"],
              },
            },
          },
          {
            id: "finish",
            run: 'node -e "process.stdout.write(JSON.stringify({decision:process.env.DECISION,subject:process.env.SUBJECT}))"',
            env: {
              DECISION: "$review.response.decision",
              SUBJECT: "$review.subject.text",
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
  };

  const first = await runToolRequest({
    filePath,
    ctx: { cwd: tmpDir, env },
  });

  assert.equal(first.ok, true);
  assert.equal(first.status, "needs_input");
  assert.deepEqual(first.requiresInput?.subject, { text: "hello" });
  assert.ok(first.requiresInput?.resumeToken);

  const resumed = await resumeToolRequest({
    token: first.requiresInput?.resumeToken ?? "",
    response: { decision: "approve" },
    ctx: { cwd: tmpDir, env },
  });

  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ decision: "approve", subject: "hello" }]);
});
