import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { runWorkflowFile } from "../src/workflows/file.js";
import { PassThrough } from "node:stream";

function runLobster(args: string[], opts?: { env?: Record<string, string | undefined> }) {
  const res = spawnSync(process.execPath, [path.join("bin", "lobster.js"), ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, ...(opts?.env ?? undefined) },
    encoding: "utf8",
  });
  return res;
}

function createStreams() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutData = "";
  let stderrData = "";
  stdout.setEncoding("utf8");
  stderr.setEncoding("utf8");
  stdout.on("data", (chunk) => {
    stdoutData += chunk;
  });
  stderr.on("data", (chunk) => {
    stderrData += chunk;
  });
  return {
    stdout,
    stderr,
    getStdout: () => stdoutData,
    getStderr: () => stderrData,
  };
}

test("dry-run of a 3-step workflow file (shell steps)", async () => {
  const workflow = {
    name: "test-dry-run",
    args: { url: { default: "https://example.com" } },
    steps: [
      { id: "fetch-data", run: "curl ${url}" },
      { id: "transform", run: 'jq ".items"' },
      { id: "upload", run: "curl -X POST https://api.example.com" },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const { stdout, stderr, getStderr } = createStreams();

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout,
      stderr,
      env: { ...process.env },
      mode: "human",
      dryRun: true,
    },
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, []);

  const output = getStderr();
  assert.match(output, /\[DRY RUN\]/);
  assert.match(output, /Would execute 3 steps/);
  assert.match(output, /fetch-data\s+\[shell\]/);
  assert.match(output, /run: curl https:\/\/example\.com/);
  assert.match(output, /transform\s+\[shell\]/);
  assert.match(output, /upload\s+\[shell\]/);
});

test("dry-run of a workflow with an approval step", async () => {
  const workflow = {
    steps: [
      { id: "collect", run: "echo hello" },
      {
        id: "approve_step",
        run: "echo check",
        approval: "Proceed with deployment?",
      },
      { id: "deploy", run: "echo deploying" },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-approval-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const { stdout, stderr, getStderr } = createStreams();

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout,
      stderr,
      env: { ...process.env },
      mode: "tool",
      dryRun: true,
    },
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, []);

  const output = getStderr();
  assert.match(output, /approve_step\s+\[shell\]/);
  assert.match(output, /\[approval required\]/);
});

test("dry-run of a workflow with a conditional step that would be skipped", async () => {
  const workflow = {
    steps: [
      { id: "gate", run: "echo gate" },
      {
        id: "conditional",
        run: "echo conditional",
        condition: false,
      },
      { id: "final", run: "echo final" },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-cond-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const { stdout, stderr, getStderr } = createStreams();

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout,
      stderr,
      env: { ...process.env },
      mode: "human",
      dryRun: true,
    },
  });

  assert.equal(result.status, "ok");

  const output = getStderr();
  assert.match(output, /conditional\s+\[skipped — condition: false\]/);
  assert.match(output, /gate\s+\[shell\]/);
  assert.match(output, /final\s+\[shell\]/);
});

test("dry-run of an inline pipeline string via CLI", async () => {
  const res = runLobster([
    "run",
    "--dry-run",
    'exec --json "echo [1,2,3]" | where active=true | table',
  ]);

  assert.equal(
    res.status,
    0,
    `expected exit 0, got ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
  );
  assert.match(res.stderr, /\[DRY RUN\] Pipeline/);
  assert.match(res.stderr, /exec/);
  assert.match(res.stderr, /where/);
  assert.match(res.stderr, /table/);
  // stdout must be clean — no JSON array leaking through
  assert.equal(res.stdout.trim(), "", `expected empty stdout, got: ${res.stdout}`);
});

test("dry-run exits 0 on valid input", async () => {
  const workflow = {
    steps: [{ id: "step1", run: "echo hello" }],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-exit-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const res = runLobster(["run", "--dry-run", "--file", filePath]);

  assert.equal(
    res.status,
    0,
    `expected exit 0, got ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
  );
  assert.match(res.stderr, /\[DRY RUN\]/);
  assert.match(res.stderr, /step1/);
  // stdout must be clean — no JSON output
  assert.equal(res.stdout.trim(), "", `expected empty stdout, got: ${res.stdout}`);
});

test("normal run still works (no regression)", async () => {
  const workflow = {
    steps: [
      {
        id: "greet",
        command: "node -e \"process.stdout.write(JSON.stringify({msg:'hello'}))\"",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-regression-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const res = runLobster(["run", "--file", filePath]);

  assert.equal(
    res.status,
    0,
    `expected exit 0, got ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
  );

  const parsed = JSON.parse(res.stdout.trim());
  assert.deepEqual(parsed, [{ msg: "hello" }]);
});

test("dry-run approval step sets approved:true so downstream conditions evaluate correctly", async () => {
  const workflow = {
    steps: [
      { id: "gate", run: "echo gate", approval: "Continue?" },
      { id: "post-approval", run: "echo done", when: "$gate.approved" },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-approvcond-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const { stdout, stderr, getStderr } = createStreams();

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout,
      stderr,
      env: { ...process.env },
      mode: "human",
      dryRun: true,
    },
  });

  assert.equal(result.status, "ok");
  const output = getStderr();
  // post-approval step should NOT be marked as skipped — approval is modeled as granted
  assert.doesNotMatch(output, /post-approval.*skipped/);
  assert.match(output, /post-approval\s+\[shell\]/);
});

test("dry-run workflow with pipeline step", async () => {
  const registry = createDefaultRegistry();
  const workflow = {
    steps: [
      { id: "fetch", run: "echo hello" },
      { id: "process", pipeline: 'exec --json "echo [1]" | head 1' },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-pipeline-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const { stdout, stderr, getStderr } = createStreams();

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout,
      stderr,
      env: { ...process.env },
      mode: "human",
      registry,
      dryRun: true,
    },
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, []);

  const output = getStderr();
  assert.match(output, /fetch\s+\[shell\]/);
  assert.match(output, /process\s+\[pipeline\]/);
  assert.match(output, /pipeline: exec --json "echo \[1\]" \| head 1/);
});

test("dry-run throws on stdin ref to non-existent step", async () => {
  const workflow = {
    steps: [
      { id: "gen", run: "echo hello" },
      { id: "consumer", run: "echo done", stdin: "$missing.stdout" },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-stdin-bad-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const { stdout, stderr } = createStreams();

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: {
          stdin: process.stdin,
          stdout,
          stderr,
          env: { ...process.env },
          mode: "human",
          dryRun: true,
        },
      }),
    /Unknown step reference: missing\.stdout/,
  );
});

test("dry-run annotates valid stdin step refs as unknown at plan time", async () => {
  const workflow = {
    steps: [
      { id: "gen", run: "echo hello" },
      { id: "consumer", run: "echo done", stdin: "$gen.stdout" },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-stdin-valid-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const { stdout, stderr, getStderr } = createStreams();

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout,
      stderr,
      env: { ...process.env },
      mode: "human",
      dryRun: true,
    },
  });

  assert.equal(result.status, "ok");
  assert.match(getStderr(), /output unknown at plan time/);
});

test("dry-run preserves step output refs in shell commands instead of collapsing them to empty strings", async () => {
  const workflow = {
    steps: [
      { id: "fetch", run: "echo hello" },
      { id: "render", run: "echo A=[$fetch.stdout] B=[$fetch.json]" },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-shellrefs-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const { stdout, stderr, getStderr } = createStreams();

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout,
      stderr,
      env: { ...process.env },
      mode: "human",
      dryRun: true,
    },
  });

  assert.equal(result.status, "ok");
  const output = getStderr();
  assert.match(output, /run: echo A=\[\$fetch\.stdout\] B=\[\$fetch\.json\]/);
  assert.match(output, /\[contains step output refs — unknown at plan time\]/);
  assert.doesNotMatch(output, /run: echo A=\[\] B=\[\]/);
});

test("dry-run still resolves approved refs in shell commands", async () => {
  const workflow = {
    steps: [
      { id: "gate", run: "echo ok", approval: "Continue?" },
      { id: "render", run: "echo approved=$gate.approved" },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-approvedref-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const { stdout, stderr, getStderr } = createStreams();

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout,
      stderr,
      env: { ...process.env },
      mode: "human",
      dryRun: true,
    },
  });

  assert.equal(result.status, "ok");
  const output = getStderr();
  assert.match(output, /run: echo approved=true/);
  assert.doesNotMatch(output, /approved=\$gate\.approved/);
});

test("dry-run throws on pipeline step with unknown command", async () => {
  const registry = createDefaultRegistry();
  const workflow = {
    steps: [{ id: "step1", pipeline: "not_a_real_command | head 1" }],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-badcmd-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const { stdout, stderr } = createStreams();

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: {
          stdin: process.stdin,
          stdout,
          stderr,
          env: { ...process.env },
          mode: "human",
          registry,
          dryRun: true,
        },
      }),
    /unknown command: not_a_real_command/,
  );
});

test("dry-run flag is consumed regardless of position in argv", async () => {
  // --dry-run before pipeline tokens (canonical form)
  const before = runLobster(["run", "--dry-run", 'exec --json "echo [1]"']);
  assert.equal(before.status, 0);
  assert.match(before.stderr, /\[DRY RUN\]/);
  assert.equal(before.stdout.trim(), "");

  // --dry-run after positional file arg: lobster run workflow.lobster --dry-run
  // This is the primary use-case that was previously broken.
});

test("dry-run flag after positional file arg activates dry-run", async () => {
  const workflow = {
    steps: [{ id: "greet", run: "echo hello" }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-test-"));
  const filePath = path.join(tmpDir, "test.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow), "utf8");

  // Flag comes AFTER the positional file argument — must still activate dry-run.
  const res = runLobster(["run", filePath, "--dry-run"]);
  assert.equal(res.status, 0, `expected exit 0\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(
    res.stderr,
    /\[DRY RUN\]/,
    "expected [DRY RUN] in stderr when flag is after file path",
  );
  assert.equal(res.stdout.trim(), "", "expected no stdout in dry-run mode");

  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test("dry-run flag still activates after positional workflow file when other Lobster flags are present", async () => {
  const workflow = {
    args: { name: { default: "hello" } },
    steps: [{ id: "greet", run: "echo ${name}" }],
  };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-test-args-"));
  const filePath = path.join(tmpDir, "test.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow), "utf8");

  const res = runLobster(["run", filePath, "--args-json", '{"name":"world"}', "--dry-run"]);
  assert.equal(res.status, 0, `expected exit 0\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(res.stderr, /\[DRY RUN\]/);
  assert.match(res.stderr, /run: echo world/);
  assert.equal(res.stdout.trim(), "");

  await fsp.rm(tmpDir, { recursive: true, force: true });
});

test("command-level --dry-run in the first stage is not stolen by Lobster dry-run parsing", () => {
  const res = runLobster([
    "run",
    "openclaw.invoke",
    "--tool",
    "message",
    "--action",
    "send",
    "--dry-run",
  ]);

  assert.notEqual(
    res.status,
    0,
    "expected command execution to fail instead of Lobster dry-run exiting 0",
  );
  assert.doesNotMatch(res.stderr, /\[DRY RUN\]/);
  assert.match(res.stderr, /requires --url or OPENCLAW_URL/);
});

test("dry-run allows pipeline stage names that still depend on prior step output", async () => {
  const registry = createDefaultRegistry();
  const workflow = {
    steps: [
      { id: "planner", run: "echo openclaw.invoke" },
      { id: "call", pipeline: "$planner.stdout --tool message --action send" },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-dynamic-stage-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const { stdout, stderr, getStderr } = createStreams();

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout,
      stderr,
      env: { ...process.env },
      mode: "human",
      registry,
      dryRun: true,
    },
  });

  assert.equal(result.status, "ok");
  const output = getStderr();
  assert.match(output, /pipeline: \$planner\.stdout --tool message --action send/);
  assert.match(output, /\[command validation deferred — stage name depends on step output\]/);
});

test("dry-run does not eat shell variables that only resemble step refs", async () => {
  const workflow = {
    steps: [{ id: "shell_vars", run: "echo $HOME.json $PATH.stdout" }],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-shell-vars-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const res = runLobster(["run", "--dry-run", filePath]);
  assert.equal(res.status, 0);
  assert.match(res.stderr, /echo \$HOME\.json \$PATH\.stdout/);
});

test("dry-run evaluates compound conditions with approvals, input placeholders, and parentheses", async () => {
  const workflow = {
    steps: [
      { id: "gate", run: "echo ok", approval: "Continue?" },
      {
        id: "review",
        input: {
          prompt: "Review?",
          responseSchema: {
            type: "object",
            properties: { decision: { type: "string" } },
            required: ["decision"],
          },
        },
      },
      {
        id: "deploy",
        run: "echo deploy",
        condition: "$gate.approved && ($review.response.pending == true || $review.skipped)",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dry-compound-cond-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const { stdout, stderr, getStderr } = createStreams();

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout,
      stderr,
      env: { ...process.env },
      mode: "human",
      dryRun: true,
    },
  });

  assert.equal(result.status, "ok");
  const output = getStderr();
  assert.doesNotMatch(output, /deploy.*skipped/);
  assert.match(output, /deploy\s+\[shell\]/);
});
