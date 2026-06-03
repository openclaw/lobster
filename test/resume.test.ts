import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { decodeResumeToken } from "../src/resume.js";
import { encodeToken } from "../src/token.js";

function runCli(args: string[], env: Record<string, string | undefined>) {
  const bin = path.join(process.cwd(), "bin", "lobster.js");
  return spawnSync("node", [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("state-backed resume token roundtrip and resume pipeline continues", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-resume-"));
  const stateDir = path.join(tmpDir, "state");

  const pipeline =
    "exec --json --shell \"node -e 'process.stdout.write(JSON.stringify([{a:1}]))'\" | approve --prompt 'ok?' | pick a";

  const first = runCli(["run", "--mode", "tool", pipeline], { LOBSTER_STATE_DIR: stateDir });
  assert.equal(first.status, 0);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.status, "needs_approval");
  assert.ok(firstJson.requiresApproval?.resumeToken);

  const payload = decodeResumeToken(firstJson.requiresApproval.resumeToken);
  assert.equal(payload.kind, "pipeline-resume");
  assert.equal(typeof payload.stateKey, "string");

  const resumed = runCli(
    ["resume", "--token", firstJson.requiresApproval.resumeToken, "--approve", "yes"],
    { LOBSTER_STATE_DIR: stateDir },
  );
  assert.equal(resumed.status, 0);
  const resumedJson = JSON.parse(resumed.stdout);
  assert.equal(resumedJson.status, "ok");
  assert.deepEqual(resumedJson.output, [{ a: 1 }]);
});

test("decodeResumeToken rejects inline executable pipeline tokens", () => {
  const forgedToken = encodeToken({
    protocolVersion: 1,
    v: 1,
    pipeline: [{ name: "exec", args: { shell: "echo FORGED" }, raw: "exec --shell 'echo FORGED'" }],
    resumeAtIndex: 0,
    items: [],
    prompt: "ignored",
  });

  assert.throws(() => decodeResumeToken(forgedToken), /Invalid token/);
});

test("resume cancellation cleans up pipeline resume state", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-resume-cancel-"));
  const stateDir = path.join(tmpDir, "state");

  const pipeline =
    "exec --json --shell \"node -e 'process.stdout.write(JSON.stringify([{a:1}]))'\" | approve --prompt 'ok?' | pick a";

  const first = runCli(["run", "--mode", "tool", pipeline], { LOBSTER_STATE_DIR: stateDir });
  assert.equal(first.status, 0);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.status, "needs_approval");

  const cancelled = runCli(
    ["resume", "--token", firstJson.requiresApproval.resumeToken, "--approve", "no"],
    { LOBSTER_STATE_DIR: stateDir },
  );
  assert.equal(cancelled.status, 0);
  const cancelledJson = JSON.parse(cancelled.stdout);
  assert.equal(cancelledJson.status, "cancelled");

  const files = await fsp.readdir(stateDir);
  const pipelineResumeFiles = files.filter((name) => name.startsWith("pipeline_resume_"));
  assert.deepEqual(pipelineResumeFiles, []);
});

test("cli resume accepts --response-json for pipeline input requests", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-resume-input-"));
  const stateDir = path.join(tmpDir, "state");

  const pipeline = `ask --prompt 'Review?' --schema '{"type":"object","properties":{"decision":{"type":"string"}},"required":["decision"]}'`;

  const first = runCli(["run", "--mode", "tool", pipeline], { LOBSTER_STATE_DIR: stateDir });
  assert.equal(first.status, 0);
  const firstJson = JSON.parse(first.stdout);
  assert.equal(firstJson.status, "needs_input");
  assert.ok(firstJson.requiresInput?.resumeToken);

  const resumed = runCli(
    [
      "resume",
      "--token",
      firstJson.requiresInput.resumeToken,
      "--response-json",
      '{"decision":"approve"}',
    ],
    { LOBSTER_STATE_DIR: stateDir },
  );
  assert.equal(resumed.status, 0);
  const resumedJson = JSON.parse(resumed.stdout);
  assert.equal(resumedJson.status, "ok");
  assert.deepEqual(resumedJson.output, [{ decision: "approve" }]);
});
