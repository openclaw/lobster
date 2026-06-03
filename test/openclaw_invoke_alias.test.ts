import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultRegistry } from "../src/commands/registry.js";

test("clawd.invoke remains available as an alias", async () => {
  const registry = createDefaultRegistry();
  const a = registry.get("openclaw.invoke");
  const b = registry.get("clawd.invoke");
  assert.ok(a, "expected openclaw.invoke to exist");
  assert.ok(b, "expected clawd.invoke to exist");
  assert.equal(typeof a.run, "function");
  assert.equal(typeof b.run, "function");
});
