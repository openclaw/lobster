import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createOpenClawAgentCommand,
  runOpenClawAgentCli,
} from "../src/commands/stdlib/openclaw_agent.js";

function streamOf(items: unknown[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test("openclaw.agent delegates agent, session, and model selection to OpenClaw", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const cmd = createOpenClawAgentCommand(async (params) => {
    calls.push(params);
    return {
      runId: "run-1",
      status: "ok",
      result: { payloads: [{ text: "done" }] },
    };
  });

  const result = await cmd.run({
    input: streamOf([{ path: "src/index.ts" }, "plain text"]),
    args: {
      _: [],
      agent: "ops",
      prompt: "Review this",
      model: "openai/gpt-5.4",
      "session-key": "incident-42",
      thinking: "high",
      timeout: 45,
    },
    ctx: { env: {}, cwd: "/tmp" },
  });

  const items: unknown[] = [];
  for await (const item of result.output) items.push(item);
  assert.deepEqual(items, [
    {
      runId: "run-1",
      status: "ok",
      result: { payloads: [{ text: "done" }] },
    },
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.argv, [
    "agent",
    "--json",
    "--message",
    'Review this\n\nPipeline input (JSONL):\n{"path":"src/index.ts"}\n"plain text"',
    "--agent",
    "ops",
    "--model",
    "openai/gpt-5.4",
    "--session-key",
    "incident-42",
    "--thinking",
    "high",
    "--timeout",
    "45",
  ]);
});

test("openclaw.agent requires a message and agent or session target", async () => {
  const cmd = createOpenClawAgentCommand(async () => ({}));
  const ctx = { env: {}, cwd: "/tmp" };

  await assert.rejects(
    cmd.run({ input: streamOf([]), args: { _: [], agent: "main" }, ctx }),
    /requires --prompt/,
  );
  await assert.rejects(
    cmd.run({ input: streamOf([]), args: { _: [], prompt: "hello" }, ctx }),
    /requires --agent/,
  );
  await assert.rejects(
    cmd.run({
      input: streamOf([]),
      args: { _: [], agent: "main", prompt: "hello", timeout: 1.5 },
      ctx,
    }),
    /non-negative integer/,
  );
});

test("OpenClaw CLI runner parses structured JSON output", async () => {
  const fixturePath = path.join(process.cwd(), "test", "fixtures", "mock-openclaw-agent.mjs");
  const output = await runOpenClawAgentCli({
    executable: process.execPath,
    argv: [fixturePath, "agent", "--json", "--message", "hello"],
    cwd: process.cwd(),
    env: process.env,
  });

  assert.deepEqual(output, {
    runId: "fixture-run",
    status: "ok",
    result: { payloads: [{ text: "fixture reply" }] },
  });
});

test("OpenClaw CLI runner preserves workflow cancellation", async () => {
  const fixturePath = path.join(process.cwd(), "test", "fixtures", "mock-openclaw-agent.mjs");
  const controller = new AbortController();
  const pending = runOpenClawAgentCli({
    executable: process.execPath,
    argv: [fixturePath, "--sleep"],
    cwd: process.cwd(),
    env: process.env,
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
});
