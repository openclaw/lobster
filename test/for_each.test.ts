import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { loadWorkflowFile, runWorkflowFile } from "../src/workflows/file.js";

async function runWorkflow(workflow: unknown) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-foreach-"));
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

test("for_each iterates items and collects per-iteration results", async () => {
  const result = await runWorkflow({
    steps: [
      {
        id: "data",
        command: 'node -e "process.stdout.write(JSON.stringify([{name:\\"a\\"},{name:\\"b\\"}]))"',
      },
      {
        id: "loop",
        for_each: "$data.json",
        steps: [
          {
            id: "transform",
            command:
              'node -e "process.stdout.write(JSON.stringify({upper: process.env.NAME.toUpperCase()}))"',
            env: { NAME: "$item.json.name" },
          },
        ],
      },
    ],
  });
  assert.equal(result.status, "ok");
  const output = result.output as any[];
  assert.equal(output.length, 2);
  assert.equal(output[0].index, 0);
  assert.equal(output[1].index, 1);
  assert.equal(output[0].transform.upper, "A");
  assert.equal(output[1].transform.upper, "B");
});

test("for_each supports custom item_var and index_var", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "vals", command: 'node -e "process.stdout.write(JSON.stringify([10,20]))"' },
      {
        id: "loop",
        for_each: "$vals.json",
        item_var: "num",
        index_var: "idx",
        steps: [
          {
            id: "emit",
            command:
              'node -e "process.stdout.write(JSON.stringify({num:$num.json,idx:$idx.json}))"',
          },
        ],
      },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [
    { num: 10, idx: 0, emit: { num: 10, idx: 0 } },
    { num: 20, idx: 1, emit: { num: 20, idx: 1 } },
  ]);
});

test("for_each throws when source is not an array", async () => {
  await assert.rejects(
    () =>
      runWorkflow({
        steps: [
          { id: "data", command: 'node -e "process.stdout.write(JSON.stringify({x:1}))"' },
          { id: "loop", for_each: "$data.json", steps: [{ id: "x", command: "echo hi" }] },
        ],
      }),
    /for_each: expected array/,
  );
});

test("for_each validation rejects empty sub-step list", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-foreach-"));
  const filePath = path.join(tmpDir, "bad.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [{ id: "loop", for_each: "$x.json", steps: [] }],
    }),
    "utf8",
  );
  await assert.rejects(
    () => loadWorkflowFile(filePath),
    /for_each requires a non-empty steps array/,
  );
});

test("for_each validation rejects run/command/pipeline/workflow/parallel on loop step", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-foreach-"));
  const filePath = path.join(tmpDir, "bad.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [
        {
          id: "loop",
          for_each: "$x.json",
          run: "echo no",
          steps: [{ id: "s", command: "echo hi" }],
        },
      ],
    }),
    "utf8",
  );
  await assert.rejects(
    () => loadWorkflowFile(filePath),
    /for_each cannot also define run, command, pipeline, workflow, or parallel/,
  );
});

test("for_each validation rejects approval/input in sub-steps", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-foreach-"));
  const filePath = path.join(tmpDir, "bad.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [
        {
          id: "loop",
          for_each: "$x.json",
          steps: [{ id: "s", command: "echo hi", approval: true }],
        },
      ],
    }),
    "utf8",
  );
  await assert.rejects(() => loadWorkflowFile(filePath), /cannot contain approval or input/);
});

test("for_each validation rejects duplicate sub-step ids", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-foreach-"));
  const filePath = path.join(tmpDir, "bad.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [
        {
          id: "loop",
          for_each: "$x.json",
          steps: [
            { id: "dup", command: "echo a" },
            { id: "dup", command: "echo b" },
          ],
        },
      ],
    }),
    "utf8",
  );
  await assert.rejects(() => loadWorkflowFile(filePath), /duplicate for_each sub-step id/);
});

test("for_each validation rejects item_var/index_var collisions", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-foreach-"));
  const filePath = path.join(tmpDir, "bad.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [
        {
          id: "loop",
          for_each: "$x.json",
          item_var: "x",
          index_var: "x",
          steps: [{ id: "s", command: "echo hi" }],
        },
      ],
    }),
    "utf8",
  );
  await assert.rejects(
    () => loadWorkflowFile(filePath),
    /item_var and index_var cannot be the same/,
  );
});

test("for_each pause_ms and batch_size are accepted and executable", async () => {
  const result = await runWorkflow({
    steps: [
      { id: "vals", command: 'node -e "process.stdout.write(JSON.stringify([1,2,3]))"' },
      {
        id: "loop",
        for_each: "$vals.json",
        batch_size: 2,
        pause_ms: 10,
        steps: [
          { id: "emit", command: 'node -e "process.stdout.write(JSON.stringify({v:$item.json}))"' },
        ],
      },
    ],
  });
  assert.equal(result.status, "ok");
  assert.equal((result.output as any[]).length, 3);
});

test("for_each dry-run renders loop structure", async () => {
  const workflow = {
    steps: [
      { id: "vals", command: 'node -e "process.stdout.write(JSON.stringify([1,2]))"' },
      {
        id: "loop",
        for_each: "$vals.json",
        batch_size: 2,
        steps: [{ id: "emit", command: "echo hi" }],
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-foreach-"));
  const stateDir = path.join(tmpDir, "state");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const stderr = new PassThrough();
  let out = "";
  stderr.on("data", (d: Buffer | string) => {
    out += String(d);
  });

  await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: "tool",
      dryRun: true,
      registry: createDefaultRegistry(),
    },
  });

  assert.match(out, /\[for_each\]/);
  assert.match(out, /sub-steps: 1/);
  assert.match(out, /batch_size: 2/);
});
