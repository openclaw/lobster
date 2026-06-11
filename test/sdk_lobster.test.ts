import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Lobster } from "../src/sdk/Lobster.js";
import { stateSet } from "../src/sdk/primitives/state.js";
import { decodeToken, encodeToken } from "../src/token.js";

test("sdk Lobster.resume accepts structured input responses", async () => {
  const workflow = new Lobster().pipe({
    async run() {
      return {
        halt: true,
        output: (async function* () {
          yield {
            type: "input_request",
            prompt: "Decision?",
            responseSchema: {
              type: "object",
              properties: { decision: { type: "string", enum: ["approve", "reject"] } },
              required: ["decision"],
            },
            subject: { text: "draft v1" },
          };
        })(),
      };
    },
  });

  const first = await workflow.run();
  assert.equal(first.ok, true);
  assert.equal(first.status, "needs_input");
  assert.ok(first.requiresInput?.resumeToken);

  const resumed = await workflow.resume(first.requiresInput!.resumeToken, {
    response: { decision: "approve" },
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ decision: "approve" }]);
});

test("sdk Lobster.resume rejects invalid structured input responses", async () => {
  const workflow = new Lobster().pipe({
    async run() {
      return {
        halt: true,
        output: (async function* () {
          yield {
            type: "input_request",
            prompt: "Decision?",
            responseSchema: {
              type: "object",
              properties: { decision: { type: "string", enum: ["approve", "reject"] } },
              required: ["decision"],
            },
            subject: { text: "draft v1" },
          };
        })(),
      };
    },
  });

  const first = await workflow.run();
  assert.equal(first.status, "needs_input");
  await assert.rejects(
    () => workflow.resume(first.requiresInput!.resumeToken, { response: { decision: "maybe" } }),
    /does not match schema/i,
  );
});

test("sdk Lobster.resume replays command-level requestInput with a fresh instance", async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-sdk-input-"));
  let runs = 0;
  const schema = {
    type: "object",
    properties: { choice: { type: "string", enum: ["red", "blue"] } },
    required: ["choice"],
  };
  const choose = {
    async run({ input, ctx }: any) {
      runs += 1;
      const items = [];
      for await (const item of input) items.push(item);
      const response = await ctx.requestInput({
        prompt: "Pick a color",
        responseSchema: schema,
        suspendedState: { count: items.length },
      });
      return { output: [{ runs, items, choice: response.choice }] };
    },
  };
  const createWorkflow = () => new Lobster({ stateDir }).pipe(choose);

  const first = await createWorkflow().run([{ id: 1 }]);
  assert.equal(first.ok, true);
  assert.equal(first.status, "needs_input");
  assert.ok(first.requiresInput?.resumeToken);

  const payload = decodeToken(first.requiresInput.resumeToken) as any;
  assert.equal(payload.resumeMode, "same_stage");
  assert.equal(payload.resumeAtIndex, 0);
  assert.match(payload.stateKey, /^sdk_resume_/);
  assert.equal(payload.commandInput, undefined);

  const resumed = await createWorkflow().resume(first.requiresInput.resumeToken, {
    response: { choice: "red" },
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ runs: 2, items: [{ id: 1 }], choice: "red" }]);
});

test("sdk Lobster.resume rejects command-level requestInput tampering and metadata drift", async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-sdk-input-tamper-"));
  const schema = {
    type: "object",
    properties: { choice: { type: "string" } },
    required: ["choice"],
  };
  let prompt = "Original";
  const workflow = new Lobster({ stateDir }).pipe({
    async run({ ctx }: any) {
      const response = await ctx.requestInput({ prompt, responseSchema: schema });
      return { output: [response] };
    },
  });

  const first = await workflow.run();
  assert.equal(first.status, "needs_input");
  const payload = decodeToken(first.requiresInput!.resumeToken) as any;
  payload.stateKey = "sdk_resume_forged";
  const forged = encodeToken(payload);

  await assert.rejects(
    () => workflow.resume(forged, { response: { choice: "red" } }),
    /SDK resume state not found/,
  );

  prompt = "Changed";
  const resumed = await workflow.resume(first.requiresInput!.resumeToken, {
    response: { choice: "red" },
  });
  assert.equal(resumed.ok, false);
  assert.equal(resumed.status, "error");
  assert.match(resumed.error?.message ?? "", /does not match suspended request/);
});

test("sdk Lobster stores chained requestInput history outside the resume token", async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-sdk-input-chain-"));
  const schema = {
    type: "object",
    properties: { choice: { type: "string", enum: ["red", "blue"] } },
    required: ["choice"],
  };
  const createWorkflow = () =>
    new Lobster({ stateDir }).pipe({
      async run({ ctx }: any) {
        const first = await ctx.requestInput({ prompt: "First", responseSchema: schema });
        const second = await ctx.requestInput({
          prompt: `Second after ${first.choice}`,
          responseSchema: schema,
        });
        return { output: [{ first: first.choice, second: second.choice }] };
      },
    });

  const first = await createWorkflow().run();
  assert.equal(first.status, "needs_input");
  const second = await createWorkflow().resume(first.requiresInput!.resumeToken, {
    response: { choice: "red" },
  });
  assert.equal(second.status, "needs_input");

  const payload = decodeToken(second.requiresInput!.resumeToken) as any;
  assert.equal(payload.resumeMode, "same_stage");
  assert.match(payload.stateKey, /^sdk_resume_/);
  assert.equal(payload.commandInput, undefined);
  assert.equal(payload.items, undefined);

  const final = await createWorkflow().resume(second.requiresInput!.resumeToken, {
    response: { choice: "blue" },
  });
  assert.equal(final.ok, true);
  assert.equal(final.status, "ok");
  assert.deepEqual(final.output, [{ first: "red", second: "blue" }]);
});

test("sdk Lobster preserves custom stateDir while using core runtime", async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-sdk-state-dir-"));
  const workflow = new Lobster({ stateDir })
    .pipe(() => ({ saved: true }))
    .pipe(stateSet("custom-key"));

  const result = await workflow.run();

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ saved: true }]);
  assert.equal(
    await fsp.readFile(path.join(stateDir, "custom-key.json"), "utf8"),
    '{\n  "saved": true\n}\n',
  );
});
