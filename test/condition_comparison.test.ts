import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWorkflowFile } from "../src/workflows/file.js";

async function runWorkflow(workflow: unknown) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cond-"));
  const stateDir = path.join(tmpDir, "state");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  return runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: "tool",
    },
  });
}

test("condition > works with numbers", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "data", command: 'node -e "process.stdout.write(JSON.stringify({count:5}))"' },
      { id: "check", command: 'echo "big"', when: "$data.json.count > 3" },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, ["big\n"]);
});

test("condition > skips when false", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "data", command: 'node -e "process.stdout.write(JSON.stringify({count:1}))"' },
      { id: "check", command: 'echo "big"', when: "$data.json.count > 3" },
      { id: "fallback", command: 'echo "small"' },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, ["small\n"]);
});

test("condition < works", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "data", command: 'node -e "process.stdout.write(JSON.stringify({val:2}))"' },
      { id: "check", command: 'echo "low"', when: "$data.json.val < 10" },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, ["low\n"]);
});

test("condition >= works at boundary", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "data", command: 'node -e "process.stdout.write(JSON.stringify({val:5}))"' },
      { id: "check", command: 'echo "yes"', when: "$data.json.val >= 5" },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, ["yes\n"]);
});

test("condition <= works at boundary", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "data", command: 'node -e "process.stdout.write(JSON.stringify({val:5}))"' },
      { id: "check", command: 'echo "yes"', when: "$data.json.val <= 5" },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, ["yes\n"]);
});

test("comparison operators combine with boolean operators", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "data", command: 'node -e "process.stdout.write(JSON.stringify({a:5,b:20}))"' },
      { id: "check", command: 'echo "in range"', when: "$data.json.a >= 1 && $data.json.b < 100" },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, ["in range\n"]);
});

test("comparison with non-numeric string returns false", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "data", command: 'node -e "process.stdout.write(JSON.stringify({val:\\"hello\\"}))"' },
      { id: "check", command: 'echo "yes"', when: "$data.json.val > 3" },
      { id: "fallback", command: 'echo "no"' },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, ["no\n"]);
});

test("comparison rejects boolean as non-numeric", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "data", command: 'node -e "process.stdout.write(JSON.stringify({val:true}))"' },
      { id: "check", command: 'echo "yes"', when: "$data.json.val > 0" },
      { id: "fallback", command: 'echo "no"' },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, ["no\n"]);
});

test("comparison rejects null as non-numeric", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "data", command: 'node -e "process.stdout.write(JSON.stringify({val:null}))"' },
      { id: "check", command: 'echo "yes"', when: "$data.json.val >= 0" },
      { id: "fallback", command: 'echo "no"' },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, ["no\n"]);
});

test("existing == and != still work with new operators", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "data", command: 'node -e "process.stdout.write(JSON.stringify({status:\\"ok\\"}))"' },
      { id: "check", command: 'echo "good"', when: '$data.json.status == "ok"' },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, ["good\n"]);
});
