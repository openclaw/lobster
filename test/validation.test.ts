import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";

import { createCompileCached } from "../src/validation.js";

test("compileCached reuses validators for structurally equivalent schemas", () => {
  const ajv = new Ajv({ strict: false });
  const compile = ajv.compile.bind(ajv);
  let compileCount = 0;

  ajv.compile = ((schema) => {
    compileCount += 1;
    return compile(schema);
  }) as typeof ajv.compile;

  const compileCached = createCompileCached(ajv);
  const first = compileCached({
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  });
  const second = compileCached({
    required: ["value"],
    properties: { value: { type: "string" } },
    type: "object",
  });

  assert.equal(second, first);
  assert.equal(compileCount, 1);
  assert.equal(first({ value: "ok" }), true);
});
