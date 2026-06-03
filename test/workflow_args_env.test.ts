import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

import { runWorkflowFile } from "../src/workflows/file.js";

test("workflow file exposes args as LOBSTER_ARG_* env vars (safe for quotes)", async () => {
  const workflow = {
    name: "args-env",
    args: {
      text: { default: "" },
    },
    steps: [
      {
        id: "echo",
        // Avoid embedding the arg into the shell command; read from env instead.
        command:
          'node -e "process.stdout.write(JSON.stringify({text: process.env.LOBSTER_ARG_TEXT}))"',
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-args-env-"));
  const stateDir = path.join(tmpDir, "state");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
  const text = 'hello "world" $HOME `backticks` $(whoami)';

  const result = await runWorkflowFile({
    filePath,
    args: { text },
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ text }]);
});
