import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { loadWorkflowFile, runWorkflowFile } from "../src/workflows/file.js";

async function runWorkflow(workflow: unknown) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-onerror-"));
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
      registry: createDefaultRegistry(),
    },
  });
}

test("on_error defaults to stop and propagates errors", async () => {
  await assert.rejects(
    () =>
      runWorkflow({
        steps: [
          { id: "fail", command: 'node -e "process.exit(1)"' },
          { id: "after", command: "echo should-not-run" },
        ],
      }),
    /workflow command failed/,
  );
});

test("on_error: stop explicit also propagates errors", async () => {
  await assert.rejects(
    () =>
      runWorkflow({
        steps: [
          { id: "fail", command: 'node -e "process.exit(1)"', on_error: "stop" },
          { id: "after", command: "echo should-not-run" },
        ],
      }),
    /workflow command failed/,
  );
});

test("on_error: continue records error and proceeds", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "fail", command: 'node -e "process.exit(1)"', on_error: "continue" },
      { id: "after", command: 'echo "ran"' },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, ["ran\n"]);
});

test("on_error: continue exposes error marker to later steps", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "fail", command: 'node -e "process.exit(1)"', on_error: "continue" },
      {
        id: "check",
        command: 'node -e "process.stdout.write(JSON.stringify({saw: process.env.SAW}))"',
        env: { SAW: "$fail.error" },
      },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ saw: "true" }]);
});

test("on_error: skip_rest stops remaining steps and keeps prior output", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "good", command: 'node -e "process.stdout.write(JSON.stringify({kept:true}))"' },
      { id: "fail", command: 'node -e "process.exit(1)"', on_error: "skip_rest" },
      { id: "after", command: "echo should-not-run" },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ kept: true }]);
});

test("on_error: continue supports condition branching on error state", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "risky", command: 'node -e "process.exit(1)"', on_error: "continue" },
      { id: "success_path", command: "echo success", when: "$risky.error != true" },
      { id: "failure_path", command: "echo failure", when: "$risky.error == true" },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, ["failure\n"]);
});

test("on_error validation rejects invalid values", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-onerror-"));
  const filePath = path.join(tmpDir, "bad.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [{ id: "x", command: "echo hi", on_error: "invalid" }],
    }),
    "utf8",
  );
  await assert.rejects(
    () => loadWorkflowFile(filePath),
    /on_error must be "stop", "continue", or "skip_rest"/,
  );
});

test("multiple continue failures preserve both error markers", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "a", command: 'node -e "process.exit(1)"', on_error: "continue" },
      { id: "b", command: 'node -e "process.exit(1)"', on_error: "continue" },
      {
        id: "report",
        command:
          'node -e "process.stdout.write(JSON.stringify({a:process.env.A,b:process.env.B}))"',
        env: { A: "$a.error", B: "$b.error" },
      },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ a: "true", b: "true" }]);
});

test("on_error: continue preserves output when final step fails", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "good", command: 'node -e "process.stdout.write(JSON.stringify({ok:true}))"' },
      { id: "fail_last", command: 'node -e "process.exit(1)"', on_error: "continue" },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ ok: true }]);
});

test("pipeline approval halts bypass on_error handling", async () => {
  await assert.rejects(
    () =>
      runWorkflow({
        steps: [
          { id: "gate", pipeline: "approve --prompt 'Proceed?'", on_error: "continue" },
          { id: "after", command: "echo should-not-run" },
        ],
      }),
    /halted for approval inside pipeline/,
  );
});

test("external abort propagates even with on_error: continue", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-onerror-abort-"));
  const stateDir = path.join(tmpDir, "state");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [
        { id: "slow", command: 'node -e "setTimeout(() => {}, 5000)"', on_error: "continue" },
      ],
    }),
    "utf8",
  );

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
          mode: "tool",
          signal: controller.signal,
        },
      }),
    (err: any) => err?.name === "AbortError" || err?.code === "ABORT_ERR",
  );
});
