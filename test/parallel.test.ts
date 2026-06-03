import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { loadWorkflowFile, runWorkflowFile } from "../src/workflows/file.js";

async function runWorkflow(workflow: unknown) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-parallel-"));
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

test("parallel wait=all runs all branches and merges output", async () => {
  const result = await runWorkflow({
    steps: [
      {
        id: "fetch",
        parallel: {
          wait: "all",
          branches: [
            { id: "a", command: 'node -e "process.stdout.write(JSON.stringify({src:\\"a\\"}))"' },
            { id: "b", command: 'node -e "process.stdout.write(JSON.stringify({src:\\"b\\"}))"' },
            { id: "c", command: 'node -e "process.stdout.write(JSON.stringify({src:\\"c\\"}))"' },
          ],
        },
      },
    ],
  });

  assert.equal(result.status, "ok");
  const output = result.output as any[];
  assert.equal(output[0].a.src, "a");
  assert.equal(output[0].b.src, "b");
  assert.equal(output[0].c.src, "c");
});

test("parallel wait=any returns first branch result", async () => {
  const result = await runWorkflow({
    steps: [
      {
        id: "race",
        parallel: {
          wait: "any",
          branches: [
            {
              id: "fast",
              command: 'node -e "process.stdout.write(JSON.stringify({winner:true}))"',
            },
            {
              id: "slow",
              command:
                'node -e "setTimeout(() => process.stdout.write(JSON.stringify({winner:false})), 5000)"',
            },
          ],
        },
      },
    ],
  });
  assert.equal(result.status, "ok");
  const output = result.output as any[];
  assert.equal(Object.keys(output[0]).length, 1);
  assert.equal(output[0].fast.winner, true);
});

test("parallel branch results are available to later steps by branch id", async () => {
  const result = await runWorkflow({
    steps: [
      {
        id: "fetch",
        parallel: {
          wait: "all",
          branches: [
            { id: "x", command: 'node -e "process.stdout.write(JSON.stringify({val:10}))"' },
            { id: "y", command: 'node -e "process.stdout.write(JSON.stringify({val:20}))"' },
          ],
        },
      },
      {
        id: "use",
        command: 'node -e "process.stdout.write(JSON.stringify({x:$x.json.val,y:$y.json.val}))"',
      },
    ],
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ x: 10, y: 20 }]);
});

test("parallel wait=all propagates branch failure", async () => {
  await assert.rejects(
    () =>
      runWorkflow({
        steps: [
          {
            id: "p",
            parallel: {
              wait: "all",
              branches: [
                { id: "ok", command: "echo ok" },
                { id: "fail", command: 'node -e "process.exit(1)"' },
              ],
            },
          },
        ],
      }),
    /Parallel branch failed/,
  );
});

test("parallel validation rejects empty branches", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-parallel-"));
  const filePath = path.join(tmpDir, "bad.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [{ id: "p", parallel: { branches: [] } }],
    }),
    "utf8",
  );
  await assert.rejects(() => loadWorkflowFile(filePath), /non-empty branches/);
});

test("parallel validation rejects duplicate branch ids", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-parallel-"));
  const filePath = path.join(tmpDir, "bad.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [
        {
          id: "p",
          parallel: {
            branches: [
              { id: "dup", command: "echo a" },
              { id: "dup", command: "echo b" },
            ],
          },
        },
      ],
    }),
    "utf8",
  );
  await assert.rejects(() => loadWorkflowFile(filePath), /duplicate parallel branch id/);
});

test("parallel validation rejects branch without execution", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-parallel-"));
  const filePath = path.join(tmpDir, "bad.lobster");
  await fsp.writeFile(
    filePath,
    JSON.stringify({
      steps: [
        {
          id: "p",
          parallel: {
            branches: [{ id: "empty" }],
          },
        },
      ],
    }),
    "utf8",
  );
  await assert.rejects(() => loadWorkflowFile(filePath), /requires run, command, or pipeline/);
});

test("parallel timeout aborts block", async () => {
  await assert.rejects(
    () =>
      runWorkflow({
        steps: [
          {
            id: "p",
            parallel: {
              wait: "all",
              timeout_ms: 100,
              branches: [
                {
                  id: "slow",
                  command: "node -e \"setTimeout(() => process.stdout.write('ok'), 5000)\"",
                },
              ],
            },
          },
        ],
      }),
    /Parallel step p timed out after 100ms/,
  );
});
