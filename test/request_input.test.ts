import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resumeToolRequest, runToolRequest } from "../src/core/tool_runtime.js";
import { runPipeline } from "../src/runtime.js";
import { decodeResumeToken } from "../src/resume.js";
import { readStateJson, writeStateJson } from "../src/state/store.js";

const responseSchema = {
  type: "object",
  properties: { choice: { type: "string", enum: ["red", "blue"] } },
  required: ["choice"],
};

function registry(commands: Record<string, any>) {
  return {
    get(name: string) {
      return commands[name];
    },
    list() {
      return Object.keys(commands);
    },
  };
}

function streamOf(items: unknown[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

function runCli(args: string[], env: Record<string, string | undefined>) {
  const bin = path.join(process.cwd(), "bin", "lobster.js");
  return spawnSync("node", [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("ctx.requestInput suspends and resumes the same tool command with state-backed metadata", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-"));
  const env = { LOBSTER_STATE_DIR: path.join(tmpDir, "state") };
  let calls = 0;
  const choose = {
    name: "choose",
    async run({ ctx }: any) {
      calls += 1;
      assert.equal("resumeInput" in ctx, false);
      assert.equal("requestInputResume" in ctx, false);
      const response = await ctx.requestInput({ prompt: "Pick one", responseSchema });
      return { output: streamOf([{ choice: response.choice, calls }]) };
    },
  };

  const first = await runToolRequest({
    pipeline: "choose",
    ctx: { env, registry: registry({ choose }) },
  });
  assert.equal(first.status, "needs_input");
  assert.ok(first.requiresInput?.resumeToken);

  const payload = decodeResumeToken(first.requiresInput.resumeToken);
  assert.deepEqual(Object.keys(payload).sort(), ["kind", "protocolVersion", "stateKey", "v"]);
  const state = (await readStateJson({ env, key: payload.stateKey })) as any;
  assert.equal(state.resumeMode, "same_stage");
  assert.equal(state.resumeAtIndex, 0);
  assert.deepEqual(state.items, []);
  assert.equal(state.commandInput.pending.requestIndex, 0);

  const resumed = await resumeToolRequest({
    token: first.requiresInput.resumeToken,
    response: { choice: "blue" },
    ctx: { env, registry: registry({ choose }) },
  });
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ choice: "blue", calls: 2 }]);
});

test("ctx.requestInput carries bounded prior responses across multiple suspensions", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-chain-"));
  const env = { LOBSTER_STATE_DIR: path.join(tmpDir, "state") };
  const choose = {
    name: "choose",
    async run({ ctx }: any) {
      const first = await ctx.requestInput({ prompt: "First", responseSchema });
      const second = await ctx.requestInput({
        prompt: `Second after ${first.choice}`,
        responseSchema,
      });
      return { output: streamOf([{ first: first.choice, second: second.choice }]) };
    },
  };

  const first = await runToolRequest({
    pipeline: "choose",
    ctx: { env, registry: registry({ choose }) },
  });
  assert.equal(first.status, "needs_input");
  const second = await resumeToolRequest({
    token: first.requiresInput!.resumeToken,
    response: { choice: "red" },
    ctx: { env, registry: registry({ choose }) },
  });
  assert.equal(second.status, "needs_input");
  const payload = decodeResumeToken(second.requiresInput!.resumeToken);
  const state = (await readStateJson({ env, key: payload.stateKey })) as any;
  assert.equal(state.commandInput.pending.requestIndex, 1);
  assert.equal(state.commandInput.history.length, 1);

  const done = await resumeToolRequest({
    token: second.requiresInput!.resumeToken,
    response: { choice: "blue" },
    ctx: { env, registry: registry({ choose }) },
  });
  assert.equal(done.status, "ok");
  assert.deepEqual(done.output, [{ first: "red", second: "blue" }]);
});

test("ctx.requestInput does not leak consumed suspended state into later requests", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-state-leak-"));
  const env = { LOBSTER_STATE_DIR: path.join(tmpDir, "state") };
  const choose = {
    name: "choose",
    async run({ ctx }: any) {
      const firstState = ctx.requestInput.getSuspendedState?.() ?? { phase: "first" };
      const first = await ctx.requestInput({
        prompt: "First",
        responseSchema,
        suspendedState: firstState,
      });
      assert.equal(ctx.requestInput.getSuspendedState?.(), undefined);
      const second = await ctx.requestInput({
        prompt: `Second after ${first.choice}`,
        responseSchema,
      });
      return { output: streamOf([{ first: first.choice, second: second.choice }]) };
    },
  };

  const first = await runToolRequest({
    pipeline: "choose",
    ctx: { env, registry: registry({ choose }) },
  });
  const second = await resumeToolRequest({
    token: first.requiresInput!.resumeToken,
    response: { choice: "red" },
    ctx: { env, registry: registry({ choose }) },
  });
  assert.equal(second.status, "needs_input");
  const payload = decodeResumeToken(second.requiresInput!.resumeToken);
  const state = (await readStateJson({ env, key: payload.stateKey })) as any;
  assert.equal(state.commandInput.pending.suspendedState, undefined);
});

test("ctx.requestInput snapshots response history before command mutation", async () => {
  const countSchema = {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-response-copy-"));
  const env = { LOBSTER_STATE_DIR: path.join(tmpDir, "state") };
  const choose = {
    name: "choose",
    async run({ ctx }: any) {
      const first = await ctx.requestInput({ prompt: "First", responseSchema: countSchema });
      first.count += 1;
      const second = await ctx.requestInput({
        prompt: `Second after ${first.count}`,
        responseSchema,
      });
      return { output: streamOf([{ count: first.count, choice: second.choice }]) };
    },
  };

  const first = await runToolRequest({
    pipeline: "choose",
    ctx: { env, registry: registry({ choose }) },
  });
  const second = await resumeToolRequest({
    token: first.requiresInput!.resumeToken,
    response: { count: 0 },
    ctx: { env, registry: registry({ choose }) },
  });
  assert.equal(second.status, "needs_input");

  const done = await resumeToolRequest({
    token: second.requiresInput!.resumeToken,
    response: { choice: "blue" },
    ctx: { env, registry: registry({ choose }) },
  });
  assert.equal(done.status, "ok");
  assert.deepEqual(done.output, [{ count: 1, choice: "blue" }]);
});

test("ctx.requestInput rejects a response rebound to changed request metadata", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-rebind-"));
  const env = { LOBSTER_STATE_DIR: path.join(tmpDir, "state") };
  let prompt = "Pick one";
  const choose = {
    name: "choose",
    async run({ ctx }: any) {
      const response = await ctx.requestInput({ prompt, responseSchema });
      return { output: streamOf([response]) };
    },
  };

  const first = await runToolRequest({
    pipeline: "choose",
    ctx: { env, registry: registry({ choose }) },
  });
  assert.equal(first.status, "needs_input");
  prompt = "Different prompt";

  const resumed = await resumeToolRequest({
    token: first.requiresInput!.resumeToken,
    response: { choice: "red" },
    ctx: { env, registry: registry({ choose }) },
  });
  assert.equal(resumed.ok, false);
  assert.match(resumed.error?.message ?? "", /does not match suspended request/);
});

test("malformed same-stage requestInput state is rejected before resume execution", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-corrupt-"));
  const env = { LOBSTER_STATE_DIR: path.join(tmpDir, "state") };
  let calls = 0;
  const choose = {
    name: "choose",
    async run({ ctx }: any) {
      calls += 1;
      await ctx.requestInput({ prompt: "Pick", responseSchema });
      return { output: streamOf([]) };
    },
  };

  const first = await runToolRequest({
    pipeline: "choose",
    ctx: { env, registry: registry({ choose }) },
  });
  const payload = decodeResumeToken(first.requiresInput!.resumeToken);
  const state = (await readStateJson({ env, key: payload.stateKey })) as any;
  state.commandInput.pending.requestIndex = 5;
  await writeStateJson({ env, key: payload.stateKey, value: state });

  const resumed = await resumeToolRequest({
    token: first.requiresInput!.resumeToken,
    response: { choice: "red" },
    ctx: { env, registry: registry({ choose }) },
  });
  assert.equal(resumed.ok, false);
  assert.match(resumed.error?.message ?? "", /Invalid pipeline resume state/);
  assert.equal(calls, 1);
});

test("unconsumed requestInput resume fails before downstream side effects", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-side-effect-"));
  const env = { LOBSTER_STATE_DIR: path.join(tmpDir, "state") };
  let calls = 0;
  let sideEffects = 0;
  const choose = {
    name: "choose",
    async run({ ctx }: any) {
      calls += 1;
      if (calls > 1) return { output: streamOf([{ skipped: true }]) };
      await ctx.requestInput({ prompt: "Pick", responseSchema });
      return { output: streamOf([]) };
    },
  };
  const side = {
    name: "side",
    async run({ input }: any) {
      for await (const _ of input) sideEffects += 1;
      return { output: streamOf([{ sideEffects }]) };
    },
  };

  const first = await runToolRequest({
    pipeline: "choose | side",
    ctx: { env, registry: registry({ choose, side }) },
  });
  const resumed = await resumeToolRequest({
    token: first.requiresInput!.resumeToken,
    response: { choice: "red" },
    ctx: { env, registry: registry({ choose, side }) },
  });
  assert.equal(resumed.ok, false);
  assert.match(resumed.error?.message ?? "", /not consumed/);
  assert.equal(sideEffects, 0);
});

test("unconsumed requestInput resume wins over rerun errors", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-rerun-error-"));
  const env = { LOBSTER_STATE_DIR: path.join(tmpDir, "state") };
  let calls = 0;
  const choose = {
    name: "choose",
    async run({ ctx }: any) {
      calls += 1;
      if (calls > 1) throw new Error("boom before request");
      await ctx.requestInput({ prompt: "Pick", responseSchema });
      return { output: streamOf([]) };
    },
  };

  const first = await runToolRequest({
    pipeline: "choose",
    ctx: { env, registry: registry({ choose }) },
  });
  const resumed = await resumeToolRequest({
    token: first.requiresInput!.resumeToken,
    response: { choice: "red" },
    ctx: { env, registry: registry({ choose }) },
  });
  assert.equal(resumed.ok, false);
  assert.match(resumed.error?.message ?? "", /not consumed/);
});

test("unconsumed requestInput resume wins over lazy output errors", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-lazy-error-"));
  const env = { LOBSTER_STATE_DIR: path.join(tmpDir, "state") };
  let calls = 0;
  const choose = {
    name: "choose",
    async run({ ctx }: any) {
      calls += 1;
      if (calls > 1) {
        return {
          output: {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  throw new Error("boom before request");
                },
              };
            },
          },
        };
      }
      await ctx.requestInput({ prompt: "Pick", responseSchema });
      return { output: streamOf([]) };
    },
  };

  const first = await runToolRequest({
    pipeline: "choose",
    ctx: { env, registry: registry({ choose }) },
  });
  const resumed = await resumeToolRequest({
    token: first.requiresInput!.resumeToken,
    response: { choice: "red" },
    ctx: { env, registry: registry({ choose }) },
  });
  assert.equal(resumed.ok, false);
  assert.match(resumed.error?.message ?? "", /not consumed/);
});

test("consumed requestInput resume token is invalid after downstream failure", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-consumed-"));
  const env = { LOBSTER_STATE_DIR: path.join(tmpDir, "state") };
  let sideEffects = 0;
  const choose = {
    name: "choose",
    async run({ ctx }: any) {
      const response = await ctx.requestInput({ prompt: "Pick", responseSchema });
      sideEffects += 1;
      return { output: streamOf([{ choice: response.choice }]) };
    },
  };
  const fail = {
    name: "fail",
    async run() {
      throw new Error("downstream failed");
    },
  };

  const first = await runToolRequest({
    pipeline: "choose | fail",
    ctx: { env, registry: registry({ choose, fail }) },
  });
  const resumed = await resumeToolRequest({
    token: first.requiresInput!.resumeToken,
    response: { choice: "red" },
    ctx: { env, registry: registry({ choose, fail }) },
  });
  assert.equal(resumed.ok, false);
  assert.match(resumed.error?.message ?? "", /downstream failed/);
  assert.equal(sideEffects, 1);

  const replay = await resumeToolRequest({
    token: first.requiresInput!.resumeToken,
    response: { choice: "red" },
    ctx: { env, registry: registry({ choose, fail }) },
  });
  assert.equal(replay.ok, false);
  assert.match(replay.error?.message ?? "", /Pipeline resume state not found/);
  assert.equal(sideEffects, 1);
});

test("ctx.requestInput rejects lazy input replay without suspended state and closes it", async () => {
  let closed = false;
  const input = {
    async *[Symbol.asyncIterator]() {
      try {
        yield { value: 1 };
        yield { value: 2 };
      } finally {
        closed = true;
      }
    },
  };
  const choose = {
    name: "choose",
    async run({ input, ctx }: any) {
      const iterator = input[Symbol.asyncIterator]();
      await iterator.next();
      await ctx.requestInput({ prompt: "Partial", responseSchema });
      return { output: streamOf([]) };
    },
  };

  await assert.rejects(
    () =>
      runPipeline({
        pipeline: [{ name: "choose", args: {}, raw: "choose" }],
        registry: registry({ choose }),
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
        mode: "tool",
        input,
      }),
    /suspendedState when command input is streaming/,
  );
  assert.equal(closed, true);
});

test("ctx.requestInput propagates cleanup errors on normal early close", async () => {
  const input = {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          index += 1;
          return index === 1 ? { done: false, value: { value: 1 } } : { done: true };
        },
        async return() {
          throw new Error("cleanup failed");
        },
      };
    },
  };
  const take = {
    name: "take",
    async run({ input }: any) {
      for await (const item of input) {
        return { output: streamOf([item]) };
      }
      return { output: streamOf([]) };
    },
  };

  await assert.rejects(
    runPipeline({
      pipeline: [{ name: "take", args: {}, raw: "take" }],
      registry: registry({ take }),
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      mode: "tool",
      input,
    }),
    /cleanup failed/,
  );
});

test("ctx.requestInput closes early-consumed input only once", async () => {
  let closeCount = 0;
  const input = {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          index += 1;
          return index === 1 ? { done: false, value: { value: 1 } } : { done: true };
        },
        async return() {
          closeCount += 1;
          if (closeCount > 1) throw new Error("closed twice");
          return { done: true, value: undefined };
        },
      };
    },
  };
  const take = {
    name: "take",
    async run({ input }: any) {
      for await (const item of input) {
        return { output: [item] };
      }
      return { output: [] };
    },
  };

  const result = await runPipeline({
    pipeline: [{ name: "take", args: {}, raw: "take" }],
    registry: registry({ take }),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: "tool",
    input,
  });

  assert.deepEqual(result.items, [{ value: 1 }]);
  assert.equal(closeCount, 1);
});

test("ctx.requestInput snapshots array replay input before command mutation", async () => {
  const choose = {
    name: "choose",
    async run({ input, ctx }: any) {
      const items = [];
      for await (const item of input) items.push(item);
      items[0].count += 1;
      const response = await ctx.requestInput({ prompt: "Pick", responseSchema });
      return { output: streamOf([{ count: items[0].count, choice: response.choice }]) };
    },
  };
  const pipeline = [{ name: "choose", args: {}, raw: "choose" }];
  const first = await runPipeline({
    pipeline,
    registry: registry({ choose }),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: "tool",
    input: [{ count: 0 }],
  });

  assert.equal(first.halted, true);
  const request = first.items[0] as any;
  assert.deepEqual(request.items, [{ count: 0 }]);

  const resumed = await runPipeline({
    pipeline,
    registry: registry({ choose }),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: "tool",
    input: request.items,
    requestInputResume: {
      state: request.commandInput,
      response: { choice: "red" },
    },
  });

  assert.deepEqual(resumed.items, [{ count: 1, choice: "red" }]);
});

test("ctx.requestInput preserves array replay when suspended state is supplied", async () => {
  const input = [{ value: 1 }];
  const choose = {
    name: "choose",
    async run({ input, ctx }: any) {
      const items = [];
      for await (const item of input) items.push(item);
      const response = await ctx.requestInput({
        prompt: "Pick",
        responseSchema,
        suspendedState: { seen: items.length },
      });
      return { output: streamOf([{ items, choice: response.choice }]) };
    },
  };
  const pipeline = [{ name: "choose", args: {}, raw: "choose" }];

  const first = await runPipeline({
    pipeline,
    registry: registry({ choose }),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: "tool",
    input,
  });
  assert.equal(first.halted, true);
  const request = first.items[0] as any;
  assert.deepEqual(request.items, [{ value: 1 }]);
  assert.deepEqual(request.commandInput.pending.suspendedState, { seen: 1 });

  const resumed = await runPipeline({
    pipeline,
    registry: registry({ choose }),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: "tool",
    input: request.items,
    requestInputResume: {
      state: request.commandInput,
      response: { choice: "red" },
    },
  });
  assert.deepEqual(resumed.items, [{ items: [{ value: 1 }], choice: "red" }]);
});

test("ctx.requestInput preserves eager array output as replayable input", async () => {
  const produce = {
    name: "produce",
    async run() {
      return { output: [{ value: 1 }] };
    },
  };
  const choose = {
    name: "choose",
    async run({ ctx }: any) {
      await ctx.requestInput({ prompt: "Pick", responseSchema });
      return { output: streamOf([]) };
    },
  };

  const result = await runPipeline({
    pipeline: [
      { name: "produce", args: {}, raw: "produce" },
      { name: "choose", args: {}, raw: "choose" },
    ],
    registry: registry({ produce, choose }),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: "tool",
  });
  assert.equal(result.halted, true);
  assert.deepEqual((result.items[0] as any).items, [{ value: 1 }]);
});

test("ctx.requestInput treats omitted pipeline input as replayable empty input", async () => {
  const choose = {
    name: "choose",
    async run({ ctx }: any) {
      await ctx.requestInput({ prompt: "Pick", responseSchema });
      return { output: streamOf([]) };
    },
  };

  const result = await runPipeline({
    pipeline: [{ name: "choose", args: {}, raw: "choose" }],
    registry: registry({ choose }),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: "tool",
  });
  assert.equal(result.halted, true);
  assert.deepEqual((result.items[0] as any).items, []);
});

test("ctx.requestInput accepts compact suspended state without buffering unread lazy input", async () => {
  let yielded = 0;
  let closed = false;
  const input = {
    async *[Symbol.asyncIterator]() {
      try {
        yielded += 1;
        yield { value: 1 };
        yielded += 1;
        yield { value: 2 };
      } finally {
        closed = true;
      }
    },
  };
  const choose = {
    name: "choose",
    async run({ input, ctx }: any) {
      const iterator = input[Symbol.asyncIterator]();
      const first = await iterator.next();
      await ctx.requestInput({
        prompt: "Partial",
        responseSchema,
        suspendedState: { first: first.value },
      });
      return { output: streamOf([]) };
    },
  };

  const result = await runPipeline({
    pipeline: [{ name: "choose", args: {}, raw: "choose" }],
    registry: registry({ choose }),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: "tool",
    input,
  });
  assert.equal(result.halted, true);
  assert.equal(yielded, 1);
  assert.equal(closed, true);
  assert.deepEqual((result.items[0] as any).items, []);
  assert.deepEqual((result.items[0] as any).commandInput.pending.suspendedState, {
    first: { value: 1 },
  });
});

test("ctx.requestInput restores compact suspended state before lazy input is read on resume", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-restore-"));
  const env = { LOBSTER_STATE_DIR: path.join(tmpDir, "state") };
  let produced = 0;
  let chooseRuns = 0;
  const produce = {
    name: "produce",
    async run() {
      return {
        output: (async function* () {
          produced += 1;
          yield { value: 1 };
          produced += 1;
          yield { value: 2 };
        })(),
      };
    },
  };
  const choose = {
    name: "choose",
    async run({ input, ctx }: any) {
      chooseRuns += 1;
      let state = ctx.requestInput.getSuspendedState?.();
      if (!state) {
        const iterator = input[Symbol.asyncIterator]();
        const first = await iterator.next();
        state = { first: first.value };
      }
      const response = await ctx.requestInput({
        prompt: "Pick",
        responseSchema,
        suspendedState: state,
      });
      return { output: streamOf([{ first: state.first, choice: response.choice, chooseRuns }]) };
    },
  };

  const first = await runToolRequest({
    pipeline: "produce | choose",
    ctx: { env, registry: registry({ produce, choose }) },
  });
  assert.equal(first.status, "needs_input");
  assert.equal(produced, 1);
  const payload = decodeResumeToken(first.requiresInput!.resumeToken);
  const state = (await readStateJson({ env, key: payload.stateKey })) as any;
  assert.equal(state.resumeMode, "same_stage");
  assert.equal(state.resumeAtIndex, 1);
  assert.deepEqual(state.items, []);
  assert.deepEqual(state.commandInput.pending.suspendedState, { first: { value: 1 } });

  const resumed = await resumeToolRequest({
    token: first.requiresInput!.resumeToken,
    response: { choice: "blue" },
    ctx: { env, registry: registry({ produce, choose }) },
  });
  assert.equal(resumed.status, "ok");
  assert.equal(produced, 1);
  assert.deepEqual(resumed.output, [{ first: { value: 1 }, choice: "blue", chooseRuns: 2 }]);
});

test("ctx.requestInput cleanup accepts direct async iterator return results", async () => {
  let closed = false;
  const input = {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          index += 1;
          if (index === 1) return { done: false, value: { value: 1 } };
          return { done: false, value: { value: 2 } };
        },
        return() {
          closed = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const choose = {
    name: "choose",
    async run({ input, ctx }: any) {
      const iterator = input[Symbol.asyncIterator]();
      const first = await iterator.next();
      await ctx.requestInput({
        prompt: "Partial",
        responseSchema,
        suspendedState: { first: first.value },
      });
      return { output: streamOf([]) };
    },
  };

  const result = await runPipeline({
    pipeline: [{ name: "choose", args: {}, raw: "choose" }],
    registry: registry({ choose }),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: "tool",
    input,
  });
  assert.equal(result.halted, true);
  assert.equal(closed, true);
});

test("ctx.requestInput rejects suspension after command stdout output", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-output-"));
  const env = { LOBSTER_STATE_DIR: path.join(tmpDir, "state") };
  const choose = {
    name: "choose",
    async run({ ctx }: any) {
      ctx.stdout.write("already wrote\n");
      await ctx.requestInput({ prompt: "Pick", responseSchema });
      return { output: streamOf([]) };
    },
  };

  const result = await runToolRequest({
    pipeline: "choose",
    ctx: { env, registry: registry({ choose }) },
  });
  assert.equal(result.ok, false);
  assert.match(
    result.error?.message ?? "",
    /cannot suspend after this command has produced output/,
  );
});

test("ctx.requestInput rejects suspension after an earlier stage wrote stdout", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-prior-output-"));
  const env = { LOBSTER_STATE_DIR: path.join(tmpDir, "state") };
  const write = {
    name: "write",
    async run({ ctx }: any) {
      ctx.stdout.write("already wrote\n");
      return { output: streamOf([{ ok: true }]) };
    },
  };
  const choose = {
    name: "choose",
    async run({ ctx }: any) {
      await ctx.requestInput({ prompt: "Pick", responseSchema });
      return { output: streamOf([]) };
    },
  };

  const result = await runToolRequest({
    pipeline: "write | choose",
    ctx: { env, registry: registry({ write, choose }) },
  });
  assert.equal(result.ok, false);
  assert.match(
    result.error?.message ?? "",
    /cannot suspend after this command has produced output/,
  );
});

test("ctx.requestInput suspends from terminal lazy output", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-lazy-output-"));
  const env = { LOBSTER_STATE_DIR: path.join(tmpDir, "state") };
  const lazy = {
    name: "lazy",
    async run({ ctx }: any) {
      return {
        output: (async function* () {
          const response = await ctx.requestInput({ prompt: "Pick", responseSchema });
          yield { choice: response.choice };
        })(),
      };
    },
  };

  const first = await runToolRequest({
    pipeline: "lazy",
    ctx: { env, registry: registry({ lazy }) },
  });
  assert.equal(first.status, "needs_input");
  const payload = decodeResumeToken(first.requiresInput!.resumeToken);
  const state = (await readStateJson({ env, key: payload.stateKey })) as any;
  assert.equal(state.resumeAtIndex, 0);

  const resumed = await resumeToolRequest({
    token: first.requiresInput!.resumeToken,
    response: { choice: "blue" },
    ctx: { env, registry: registry({ lazy }) },
  });
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ choice: "blue" }]);
});

test("ctx.requestInput rejects non-terminal lazy output suspension", async () => {
  const lazy = {
    name: "lazy",
    async run({ ctx }: any) {
      return {
        output: (async function* () {
          await ctx.requestInput({ prompt: "Pick", responseSchema });
          yield { ok: true };
        })(),
      };
    },
  };
  const pass = {
    name: "pass",
    async run({ input }: any) {
      return { output: input };
    },
  };

  const result = await runToolRequest({
    pipeline: "lazy | pass",
    ctx: { registry: registry({ lazy, pass }) },
  });
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /lazy output before downstream stages/);
});

test("ctx.requestInput rejects lazy suspension after pipeline item output", async () => {
  const late = {
    name: "late",
    async run({ ctx }: any) {
      return {
        output: (async function* () {
          yield { choice: "red" };
          await ctx.requestInput({ prompt: "Pick", responseSchema });
        })(),
      };
    },
  };

  const run = runPipeline({
    pipeline: [{ name: "late", args: {} }],
    registry: registry({ late }),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: {},
    input: [],
    mode: "tool",
  });
  await assert.rejects(run, /requestInput cannot suspend after this command has produced output/);
});

test("built CLI ask restores subject state across processes", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-request-input-cli-"));
  const stateDir = path.join(tmpDir, "state");
  const schema = JSON.stringify({
    type: "object",
    properties: { decision: { type: "string", enum: ["approve", "reject"] } },
    required: ["decision"],
  });
  const producer = `node -e 'process.stdout.write(JSON.stringify([{draft:"hello"}]))'`;
  const pipeline = `exec --json --shell ${JSON.stringify(producer)} | ask --subject-from-stdin --prompt 'Review?' --schema ${JSON.stringify(schema)} | pick decision`;

  const first = runCli(["run", "--mode", "tool", pipeline], { LOBSTER_STATE_DIR: stateDir });
  assert.equal(first.status, 0, first.stderr);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.status, "needs_input");
  assert.ok(firstJson.requiresInput.resumeToken);
  assert.deepEqual(firstJson.requiresInput.subject, { text: '{"draft":"hello"}' });

  const payload = decodeResumeToken(firstJson.requiresInput.resumeToken);
  const state = (await readStateJson({
    env: { LOBSTER_STATE_DIR: stateDir },
    key: payload.stateKey,
  })) as any;
  assert.equal(state.resumeMode, "same_stage");
  assert.equal(state.resumeAtIndex, 1);
  assert.deepEqual(state.items, []);
  assert.deepEqual(state.commandInput.pending.suspendedState, {
    type: "ask",
    subject: { text: '{"draft":"hello"}' },
  });

  const resumed = runCli(
    [
      "resume",
      "--token",
      firstJson.requiresInput.resumeToken,
      "--response-json",
      '{"decision":"approve"}',
    ],
    { LOBSTER_STATE_DIR: stateDir },
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  const resumedJson = JSON.parse(resumed.stdout);
  assert.equal(resumedJson.status, "ok");
  assert.deepEqual(resumedJson.output, [{ decision: "approve" }]);
});

test("human CLI ask --emit prints public input request", async () => {
  const schema = JSON.stringify({
    type: "object",
    properties: { decision: { type: "string" } },
    required: ["decision"],
  });
  const result = runCli(
    ["run", `ask --emit --prompt 'Review?' --schema ${JSON.stringify(schema)}`],
    {},
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output[0].type, "input_request");
  assert.equal(output[0].prompt, "Review?");
  assert.equal(output[0].commandInput, undefined);
});
