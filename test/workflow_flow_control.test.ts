import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { decodeResumeToken } from "../src/resume.js";
import {
  loadWorkflowFile,
  parseLobsterRunCommand,
  resolveWorkflowByName,
  runWorkflowFile,
} from "../src/workflows/file.js";
import type { WorkflowResumePayload } from "../src/workflows/file.js";

async function makeEnv(prefix = "lobster-flow-") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    env: { ...process.env, LOBSTER_STATE_DIR: path.join(dir, "state") },
  };
}

async function writeWorkflow(dir: string, name: string, workflow: object) {
  const filePath = path.join(dir, `${name}.lobster`);
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");
  return filePath;
}

function ctx(env: Record<string, string | undefined> = {}) {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: { ...process.env, ...env },
    mode: "tool" as const,
  };
}

function asWorkflowResume(payload: unknown): WorkflowResumePayload {
  assert.equal((payload as { kind?: string })?.kind, "workflow-file");
  return payload as WorkflowResumePayload;
}

test("workflow flow can jump forward", async () => {
  const { dir, env } = await makeEnv();
  const filePath = await writeWorkflow(dir, "flow-forward", {
    steps: [
      {
        id: "start",
        run: 'node -e "process.stdout.write(JSON.stringify({jump:true}))"',
        flow: [{ when: "$start.json.jump == true", goto: "finish" }],
      },
      { id: "skipped", run: 'node -e "process.stdout.write(JSON.stringify({bad:true}))"' },
      { id: "finish", run: 'node -e "process.stdout.write(JSON.stringify({done:true}))"' },
    ],
  });

  const result = await runWorkflowFile({ filePath, ctx: ctx(env) });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ done: true }]);
});

test("workflow flow can loop with max_iterations protection", async () => {
  const { dir, env } = await makeEnv();
  const countFile = path.join(dir, "count.txt");
  await fsp.writeFile(countFile, "0", "utf8");
  const filePath = await writeWorkflow(dir, "flow-loop", {
    steps: [
      {
        id: "tick",
        run: `node -e "const fs=require('fs'); const fp='${countFile}'; const next=(Number(fs.readFileSync(fp,'utf8'))||0)+1; fs.writeFileSync(fp,String(next)); process.stdout.write(JSON.stringify({done: next == 3}))"`,
        max_iterations: 5,
        flow: [{ when: "$tick.json.done == true", goto: "finish" }, { default: "tick" }],
      },
      { id: "finish", run: 'node -e "process.stdout.write(JSON.stringify({finished:true}))"' },
    ],
  });

  const result = await runWorkflowFile({ filePath, ctx: ctx(env) });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ finished: true }]);

  const infinitePath = await writeWorkflow(dir, "flow-limit", {
    steps: [
      {
        id: "loop",
        run: 'node -e "process.stdout.write(JSON.stringify({again:true}))"',
        max_iterations: 2,
        flow: [{ default: "loop" }],
      },
    ],
  });
  await assert.rejects(
    () => runWorkflowFile({ filePath: infinitePath, ctx: ctx(env) }),
    /max_iterations/i,
  );
});

test("workflow flow falls through when no rule matches", async () => {
  const { dir, env } = await makeEnv();
  const markerFile = path.join(dir, "next-ran.txt");
  const filePath = await writeWorkflow(dir, "flow-no-match", {
    steps: [
      {
        id: "start",
        run: 'node -e "process.stdout.write(JSON.stringify({route:false}))"',
        flow: [{ when: "$start.json.route == true", goto: "finish" }],
      },
      {
        id: "next",
        run: `node -e 'require("fs").writeFileSync(${JSON.stringify(markerFile)}, "1"); process.stdout.write(JSON.stringify({fellThrough:true}))'`,
      },
      { id: "finish", run: 'node -e "process.stdout.write(JSON.stringify({finished:true}))"' },
    ],
  });

  const result = await runWorkflowFile({ filePath, ctx: ctx(env) });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ finished: true }]);
  await fsp.access(markerFile);
});

test("workflow flow does not run for skipped steps", async () => {
  const { dir, env } = await makeEnv();
  const markerFile = path.join(dir, "middle-ran.txt");
  const filePath = await writeWorkflow(dir, "flow-skipped", {
    steps: [
      {
        id: "skipped",
        when: false,
        run: 'node -e "process.stdout.write(JSON.stringify({skipped:false}))"',
        flow: [{ default: "finish" }],
      },
      {
        id: "middle",
        run: `node -e 'require("fs").writeFileSync(${JSON.stringify(markerFile)}, "1"); process.stdout.write(JSON.stringify({middle:true}))'`,
      },
      { id: "finish", run: 'node -e "process.stdout.write(JSON.stringify({finished:true}))"' },
    ],
  });

  const result = await runWorkflowFile({ filePath, ctx: ctx(env) });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ finished: true }]);
  await fsp.access(markerFile);
});

test("workflow flow visit counts persist across approval resume", async () => {
  const { dir, env } = await makeEnv();
  const filePath = await writeWorkflow(dir, "flow-approval-visit-count", {
    steps: [
      {
        id: "gate",
        run: "node -e \"process.stdout.write(JSON.stringify({requiresApproval:{prompt:'Approve loop?',items:[]}}))\"",
        approval: "required",
        max_iterations: 2,
        flow: [{ default: "gate" }],
      },
    ],
  });

  const first = await runWorkflowFile({ filePath, ctx: ctx(env) });
  assert.equal(first.status, "needs_approval");

  const second = await runWorkflowFile({
    filePath,
    ctx: ctx(env),
    resume: asWorkflowResume(decodeResumeToken(first.requiresApproval?.resumeToken ?? "")),
    approved: true,
  });
  assert.equal(second.status, "needs_approval");

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: ctx(env),
        resume: asWorkflowResume(decodeResumeToken(second.requiresApproval?.resumeToken ?? "")),
        approved: true,
      }),
    /max_iterations/i,
  );
});

test("workflow flow validation rejects bad rules", async () => {
  const { dir } = await makeEnv();
  const badTarget = await writeWorkflow(dir, "bad-target", {
    steps: [{ id: "start", run: "echo start", flow: [{ default: "missing" }] }],
  });
  await assert.rejects(
    () => loadWorkflowFile(badTarget),
    /goto target "missing" does not match any step id/,
  );

  const badDefault = await writeWorkflow(dir, "bad-default", {
    steps: [
      { id: "start", run: "echo start" },
      {
        id: "route",
        run: "echo route",
        flow: [{ default: "start" }, { when: "true", goto: "start" }],
      },
    ],
  });
  await assert.rejects(() => loadWorkflowFile(badDefault), /default rule must be the last/i);
});

test("lobster.run parses quoted child workflow invocations", () => {
  assert.deepEqual(parseLobsterRunCommand("lobster.run --name child --args-json '{\"x\":1}'"), {
    name: "child",
    file: undefined,
    argsJson: '{"x":1}',
  });
  assert.deepEqual(
    parseLobsterRunCommand('lobster.run --file "./child flow.lobster" --args-json "{\\"x\\": 2}"'),
    { name: undefined, file: "./child flow.lobster", argsJson: '{"x": 2}' },
  );
  assert.equal(parseLobsterRunCommand("echo lobster.run"), null);
  assert.throws(() => parseLobsterRunCommand("lobster.run --name child --file child.lobster"));
});

test("lobster.run resolves named workflows from LOBSTER_WORKFLOW_PATH", async () => {
  const { dir } = await makeEnv("lobster-search-");
  const parentDir = path.join(dir, "parent");
  const searchDir = path.join(dir, "workflows");
  await fsp.mkdir(parentDir);
  await fsp.mkdir(searchDir);
  const childPath = await writeWorkflow(searchDir, "child", {
    steps: [{ id: "done", run: "echo done" }],
  });

  const resolved = await resolveWorkflowByName("child", parentDir, {
    LOBSTER_WORKFLOW_PATH: searchDir,
  });
  assert.equal(resolved, childPath);
});

test("lobster.run child workflow output can drive a parent flow loop", async () => {
  const { dir, env } = await makeEnv("lobster-subflow-");
  const countFile = path.join(dir, "count.txt");
  await fsp.writeFile(countFile, "0", "utf8");

  await writeWorkflow(dir, "child", {
    steps: [
      {
        id: "tick",
        run: `node -e "const fs=require('fs'); const fp='${countFile}'; const next=(Number(fs.readFileSync(fp,'utf8'))||0)+1; fs.writeFileSync(fp,String(next)); process.stdout.write(JSON.stringify({done: next == 3}))"`,
      },
    ],
  });
  const parentPath = await writeWorkflow(dir, "parent", {
    steps: [
      {
        id: "invoke",
        run: "lobster.run --name child",
        max_iterations: 5,
        flow: [{ when: "$invoke.json.done == true", goto: "finish" }, { default: "invoke" }],
      },
      { id: "finish", run: 'node -e "process.stdout.write(JSON.stringify({finished:true}))"' },
    ],
  });

  const result = await runWorkflowFile({ filePath: parentPath, ctx: ctx(env) });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ finished: true }]);
});

test("lobster.run can invoke an explicit child workflow file", async () => {
  const { dir, env } = await makeEnv("lobster-subfile-");
  const childPath = await writeWorkflow(dir, "child-file", {
    steps: [{ id: "out", run: 'node -e "process.stdout.write(JSON.stringify({explicit:true}))"' }],
  });
  const parentPath = await writeWorkflow(dir, "parent", {
    steps: [{ id: "invoke", run: `lobster.run --file ${JSON.stringify(childPath)}` }],
  });

  const result = await runWorkflowFile({ filePath: parentPath, ctx: ctx(env) });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ explicit: true }]);
});

test("child workflow approval can resume through the parent workflow", async () => {
  const { dir, env } = await makeEnv("lobster-child-resume-");
  await writeWorkflow(dir, "child", {
    steps: [
      {
        id: "gate",
        run: "node -e \"process.stdout.write(JSON.stringify({requiresApproval:{prompt:'Approve child?',items:[]}}))\"",
        approval: "required",
      },
      {
        id: "finish",
        run: 'node -e "process.stdout.write(JSON.stringify({child:true}))"',
        when: "$gate.approved",
      },
    ],
  });
  const parentPath = await writeWorkflow(dir, "parent", {
    steps: [
      { id: "invoke", run: "lobster.run --name child", max_iterations: 1 },
      { id: "done", run: 'node -e "process.stdout.write(JSON.stringify({parent:true}))"' },
    ],
  });

  const first = await runWorkflowFile({ filePath: parentPath, ctx: ctx(env) });
  assert.equal(first.status, "needs_approval");
  assert.equal(first.requiresApproval?.prompt, "Approve child?");

  const resumed = await runWorkflowFile({
    filePath: parentPath,
    ctx: ctx(env),
    resume: asWorkflowResume(decodeResumeToken(first.requiresApproval?.resumeToken ?? "")),
    approved: true,
  });
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ parent: true }]);
});

test("child workflow input can resume through the parent workflow", async () => {
  const { dir, env } = await makeEnv("lobster-child-input-");
  await writeWorkflow(dir, "child", {
    steps: [
      {
        id: "ask",
        input: {
          prompt: "Need answer",
          responseSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
      {
        id: "emit",
        run: 'node -e "process.stdout.write(JSON.stringify({answer:process.env.ANSWER}))"',
        env: { ANSWER: "$ask.response.answer" },
      },
    ],
  });
  const parentPath = await writeWorkflow(dir, "parent", {
    steps: [{ id: "invoke", run: "lobster.run --name child" }],
  });

  const first = await runWorkflowFile({ filePath: parentPath, ctx: ctx(env) });
  assert.equal(first.status, "needs_input");
  assert.equal(first.requiresInput?.prompt, "Need answer");

  const resumed = await runWorkflowFile({
    filePath: parentPath,
    ctx: ctx(env),
    resume: asWorkflowResume(decodeResumeToken(first.requiresInput?.resumeToken ?? "")),
    response: { answer: "ok" },
  });
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ answer: "ok" }]);
});
