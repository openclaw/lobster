import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { loadWorkflowFile, runWorkflowFile } from "../src/workflows/file.js";

async function setupWorkflows(files: Record<string, unknown>) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-compose-"));
  const stateDir = path.join(tmpDir, "state");
  const paths: Record<string, string> = {};

  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(tmpDir, name);
    await fsp.writeFile(filePath, JSON.stringify(content, null, 2), "utf8");
    paths[name] = filePath;
  }

  return { tmpDir, stateDir, paths };
}

async function runWorkflow(filePath: string, stateDir: string, args?: Record<string, unknown>) {
  return runWorkflowFile({
    filePath,
    args,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: "tool",
    },
  });
}

test("workflow step calls sub-workflow and receives output", async () => {
  const { stateDir, paths } = await setupWorkflows({
    "child.lobster": {
      steps: [
        {
          id: "greet",
          command: 'node -e "process.stdout.write(JSON.stringify({msg:\\"hello from child\\"}))"',
        },
      ],
    },
    "parent.lobster": {
      steps: [
        { id: "sub", workflow: "child.lobster" },
        {
          id: "use",
          command:
            'node -e "process.stdout.write(JSON.stringify({got: process.env.LOBSTER_ARG_MSG}))"',
          env: { LOBSTER_ARG_MSG: "$sub.json.msg" },
        },
      ],
    },
  });

  const result = await runWorkflow(paths["parent.lobster"], stateDir);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ got: "hello from child" }]);
});

test("workflow step passes workflow_args to sub-workflow args", async () => {
  const { stateDir, paths } = await setupWorkflows({
    "child.lobster": {
      args: { name: { default: "world" } },
      steps: [
        {
          id: "greet",
          command:
            "node -e \"process.stdout.write(JSON.stringify({greeting: 'hi ' + process.env.LOBSTER_ARG_NAME}))\"",
        },
      ],
    },
    "parent.lobster": {
      steps: [{ id: "sub", workflow: "child.lobster", workflow_args: { name: "lobster" } }],
    },
  });

  const result = await runWorkflow(paths["parent.lobster"], stateDir);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ greeting: "hi lobster" }]);
});

test("workflow_args can reference parent step outputs", async () => {
  const { stateDir, paths } = await setupWorkflows({
    "child.lobster": {
      args: { val: { default: "0" } },
      steps: [
        {
          id: "echo",
          command:
            'node -e "process.stdout.write(JSON.stringify({val: process.env.LOBSTER_ARG_VAL}))"',
        },
      ],
    },
    "parent.lobster": {
      steps: [
        { id: "data", command: 'node -e "process.stdout.write(JSON.stringify({num: 42}))"' },
        { id: "sub", workflow: "child.lobster", workflow_args: { val: "$data.json.num" } },
      ],
    },
  });

  const result = await runWorkflow(paths["parent.lobster"], stateDir);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ val: "42" }]);
});

test("workflow validation rejects workflow combined with run", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-compose-"));
  const filePath = path.join(tmpDir, "bad.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [{ id: "x", workflow: "child.lobster", run: "echo hi" }],
    }),
    "utf8",
  );
  await assert.rejects(
    () => loadWorkflowFile(filePath),
    /can only define one of run, command, pipeline, workflow, parallel, or for_each/,
  );
});

test("workflow validation rejects workflow combined with pipeline", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-compose-"));
  const filePath = path.join(tmpDir, "bad.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [{ id: "x", workflow: "child.lobster", pipeline: "json" }],
    }),
    "utf8",
  );
  await assert.rejects(
    () => loadWorkflowFile(filePath),
    /can only define one of run, command, pipeline, workflow, parallel, or for_each/,
  );
});

test("workflow validation rejects blank workflow path", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-compose-"));
  const filePath = path.join(tmpDir, "bad.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [{ id: "x", workflow: "   " }],
    }),
    "utf8",
  );
  await assert.rejects(() => loadWorkflowFile(filePath), /workflow path cannot be blank/);
});

test("workflow validation rejects non-object workflow_args", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-compose-"));
  const filePath = path.join(tmpDir, "bad.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [{ id: "x", workflow: "child.lobster", workflow_args: "nope" }],
    }),
    "utf8",
  );
  await assert.rejects(() => loadWorkflowFile(filePath), /workflow_args must be a plain object/);
});

test("workflow validation rejects array workflow_args", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-compose-"));
  const filePath = path.join(tmpDir, "bad.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [{ id: "x", workflow: "child.lobster", workflow_args: ["a", "b"] }],
    }),
    "utf8",
  );
  await assert.rejects(() => loadWorkflowFile(filePath), /workflow_args must be a plain object/);
});

test("direct cycle is detected", async () => {
  const { stateDir, paths } = await setupWorkflows({
    "self.lobster": { steps: [{ id: "loop", workflow: "self.lobster" }] },
  });
  await assert.rejects(() => runWorkflow(paths["self.lobster"], stateDir), /creates a cycle/);
});

test("indirect cycle is detected", async () => {
  const { stateDir, paths } = await setupWorkflows({
    "a.lobster": { steps: [{ id: "callB", workflow: "b.lobster" }] },
    "b.lobster": { steps: [{ id: "callA", workflow: "a.lobster" }] },
  });
  await assert.rejects(() => runWorkflow(paths["a.lobster"], stateDir), /creates a cycle/);
});

test("sub-workflow string output remains raw in stdout", async () => {
  const { stateDir, paths } = await setupWorkflows({
    "child.lobster": {
      steps: [{ id: "out", command: 'echo "plain text"' }],
    },
    "parent.lobster": {
      steps: [
        { id: "sub", workflow: "child.lobster" },
        {
          id: "check",
          command:
            'node -e "process.stdout.write(JSON.stringify({got: process.env.LOBSTER_ARG_VAL}))"',
          env: { LOBSTER_ARG_VAL: "$sub.stdout" },
        },
      ],
    },
  });

  const result = await runWorkflow(paths["parent.lobster"], stateDir);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ got: "plain text\n" }]);
});

test("dry-run renders workflow steps and workflow_args keys", async () => {
  const { stateDir, paths } = await setupWorkflows({
    "child.lobster": { steps: [{ id: "out", command: "echo hi" }] },
    "parent.lobster": {
      steps: [{ id: "sub", workflow: "child.lobster", workflow_args: { key: "value" } }],
    },
  });

  const stderr = new PassThrough();
  const chunks: string[] = [];
  stderr.on("data", (d: Buffer | string) => chunks.push(String(d)));

  await runWorkflowFile({
    filePath: paths["parent.lobster"],
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
      mode: "tool",
      dryRun: true,
    },
  });

  const out = chunks.join("");
  assert.match(out, /\[workflow\]/);
  assert.match(out, /workflow: child\.lobster/);
  assert.match(out, /args: key/);
});

test("nested workflow composition works", async () => {
  const { stateDir, paths } = await setupWorkflows({
    "leaf.lobster": {
      steps: [
        { id: "out", command: 'node -e "process.stdout.write(JSON.stringify({leaf:true}))"' },
      ],
    },
    "middle.lobster": {
      steps: [
        { id: "callLeaf", workflow: "leaf.lobster" },
        {
          id: "wrap",
          command:
            'node -e "process.stdout.write(JSON.stringify({middle:true, leaf:$callLeaf.json.leaf}))"',
        },
      ],
    },
    "top.lobster": {
      steps: [{ id: "callMiddle", workflow: "middle.lobster" }],
    },
  });

  const result = await runWorkflow(paths["top.lobster"], stateDir);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ middle: true, leaf: true }]);
});

test("sub-workflow approval gates are rejected in composition", async () => {
  const { stateDir, paths } = await setupWorkflows({
    "child.lobster": {
      steps: [
        {
          id: "x",
          command: 'node -e "process.stdout.write(JSON.stringify({v:1}))"',
          approval: true,
        },
      ],
    },
    "parent.lobster": {
      steps: [{ id: "sub", workflow: "child.lobster" }],
    },
  });

  await assert.rejects(
    () => runWorkflow(paths["parent.lobster"], stateDir),
    /Sub-workflow approval\/input gates are not supported in composition/,
  );
});
