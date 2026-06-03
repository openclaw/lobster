import test from "node:test";
import assert from "node:assert/strict";

import { Lobster } from "../src/sdk/Lobster.js";

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
