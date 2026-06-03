import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promises as fsp } from "node:fs";

function runTool(pipeline, env) {
  const bin = path.join(process.cwd(), "bin", "lobster.js");
  const res = spawnSync("node", [bin, "run", "--mode", "tool", pipeline], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(res.status, 0);
  return JSON.parse(res.stdout);
}

function resume(token, approve, env) {
  const bin = path.join(process.cwd(), "bin", "lobster.js");
  const res = spawnSync(
    "node",
    [bin, "resume", "--token", token, "--approve", approve ? "yes" : "no"],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
  assert.equal(res.status, 0);
  return JSON.parse(res.stdout);
}

test("two approve gates can be resumed sequentially", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-multi-approval-"));
  const stateDir = path.join(tmpDir, "state");
  const env = { LOBSTER_STATE_DIR: stateDir };

  const pipeline = [
    "exec --json --shell \"printf '%s' '[{\\\"x\\\":1}]'\"",
    "approve --prompt 'first?'",
    "approve --prompt 'second?'",
    "pick x",
  ].join(" | ");

  const first = runTool(pipeline, env);
  assert.equal(first.status, "needs_approval");
  assert.equal(first.requiresApproval.prompt, "first?");

  const second = resume(first.requiresApproval.resumeToken, true, env);
  assert.equal(second.status, "needs_approval");
  assert.equal(second.requiresApproval.prompt, "second?");

  const done = resume(second.requiresApproval.resumeToken, true, env);
  assert.equal(done.status, "ok");
  assert.deepEqual(done.output, [{ x: 1 }]);

  const files = await fsp.readdir(stateDir);
  const pipelineResumeFiles = files.filter((name) => name.startsWith("pipeline_resume_"));
  assert.deepEqual(pipelineResumeFiles, []);
});
