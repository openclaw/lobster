import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { runWorkflowFile } from "../src/workflows/file.js";
import { decodeResumeToken } from "../src/resume.js";

test("workflow file runs with approval and resume", async () => {
  const workflow = {
    name: "sample",
    steps: [
      {
        id: "collect",
        command: 'node -e "process.stdout.write(JSON.stringify([{value:1}]))"',
      },
      {
        id: "mutate",
        command:
          "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const items=JSON.parse(d);items[0].value=2;process.stdout.write(JSON.stringify(items));});\"",
        stdin: "$collect.stdout",
      },
      {
        id: "approve_step",
        command:
          "node -e \"process.stdout.write(JSON.stringify({requiresApproval:{prompt:'Proceed?', items:[{id:1}]}}))\"",
        approval: "required",
      },
      {
        id: "finish",
        command:
          "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const items=JSON.parse(d);process.stdout.write(JSON.stringify({done:true,value:items[0].value}));});\"",
        stdin: "$mutate.stdout",
        condition: "$approve_step.approved",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-"));
  const stateDir = path.join(tmpDir, "state");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };

  const first = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
  });

  assert.equal(first.status, "needs_approval");
  assert.equal(first.requiresApproval?.prompt, "Proceed?");
  assert.ok(first.requiresApproval?.resumeToken);

  const payload = decodeResumeToken(first.requiresApproval?.resumeToken ?? "");
  assert.equal(payload.kind, "workflow-file");

  const resumed = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
    resume: payload,
    approved: true,
  });

  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ done: true, value: 2 }]);

  const stateFiles = await fsp.readdir(stateDir);
  const resumeStateFiles = stateFiles.filter((name) => name.startsWith("workflow_resume_"));
  assert.deepEqual(resumeStateFiles, []);
});

test("workflow resume cancellation cleans up resume state", async () => {
  const workflow = {
    steps: [
      {
        id: "approve_step",
        command:
          "node -e \"process.stdout.write(JSON.stringify({requiresApproval:{prompt:'Proceed?', items:[{id:1}]}}))\"",
        approval: "required",
      },
      {
        id: "finish",
        command: 'node -e "process.stdout.write(JSON.stringify({done:true}))"',
        condition: "$approve_step.approved",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-cancel-"));
  const stateDir = path.join(tmpDir, "state");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };

  const first = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
  });
  assert.equal(first.status, "needs_approval");

  const payload = decodeResumeToken(first.requiresApproval?.resumeToken ?? "");
  assert.equal(payload.kind, "workflow-file");
  assert.ok(payload.stateKey);

  await fsp.access(path.join(stateDir, `${payload.stateKey}.json`));

  const cancelled = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
    resume: payload,
    approved: false,
  });

  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.output, []);
  const files = await fsp.readdir(stateDir);
  const resumeStateFiles = files.filter((name) => name.startsWith("workflow_resume_"));
  assert.deepEqual(resumeStateFiles, []);
});

test("workflow resume accepts workflow-resume_ state key aliases and cleans up state", async () => {
  const workflow = {
    steps: [
      {
        id: "approve_step",
        command:
          "node -e \"process.stdout.write(JSON.stringify({requiresApproval:{prompt:'Proceed?', items:[{id:1}]}}))\"",
        approval: "required",
      },
      {
        id: "finish",
        command: 'node -e "process.stdout.write(JSON.stringify({done:true}))"',
        condition: "$approve_step.approved",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-alias-"));
  const stateDir = path.join(tmpDir, "state");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
  const first = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
  });
  assert.equal(first.status, "needs_approval");

  const payload = decodeResumeToken(first.requiresApproval?.resumeToken ?? "");
  assert.equal(payload.kind, "workflow-file");
  assert.ok(payload.stateKey?.startsWith("workflow_resume_"));

  const aliasedPayload = {
    ...payload,
    stateKey: (payload.stateKey ?? "").replace("workflow_resume_", "workflow-resume_"),
  };
  assert.ok(aliasedPayload.stateKey.startsWith("workflow-resume_"));

  const resumed = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
    resume: aliasedPayload,
    approved: true,
  });
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ done: true }]);

  const files = await fsp.readdir(stateDir);
  const resumeStateFiles = files.filter(
    (name) => name.startsWith("workflow_resume_") || name.startsWith("workflow-resume_"),
  );
  assert.deepEqual(resumeStateFiles, []);
});

test("workflow file input steps pause and resume with structured responses", async () => {
  const workflow = {
    steps: [
      {
        id: "draft",
        run: "node -e \"process.stdout.write(JSON.stringify({text:'hello'}))\"",
      },
      {
        id: "review",
        input: {
          prompt: "Review draft?",
          responseSchema: {
            type: "object",
            properties: { decision: { type: "string" } },
            required: ["decision"],
          },
        },
      },
      {
        id: "finish",
        run: 'node -e "process.stdout.write(JSON.stringify({decision:process.env.DECISION,subject:process.env.SUBJECT}))"',
        env: {
          DECISION: "$review.response.decision",
          SUBJECT: "$review.subject.text",
        },
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-input-"));
  const stateDir = path.join(tmpDir, "state");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };

  const first = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
  });

  assert.equal(first.status, "needs_input");
  assert.deepEqual(first.requiresInput?.subject, { text: "hello" });
  assert.ok(first.requiresInput?.resumeToken);

  const payload = decodeResumeToken(first.requiresInput?.resumeToken ?? "");
  assert.equal(payload.kind, "workflow-file");

  const resumeEnv: Record<string, string | undefined> = { ...env };
  delete resumeEnv.LONG_TEXT;

  const resumed = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: resumeEnv,
      mode: "tool",
    },
    resume: payload,
    response: { decision: "approve" },
  });

  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ decision: "approve", subject: "hello" }]);
});

test("workflow input resumes preserve the full subject even when the tool envelope preview is truncated", async () => {
  const longText = "x".repeat(250_000);
  const workflow = {
    steps: [
      {
        id: "draft",
        run: "node -e \"let data=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => data += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify({text:data})))\"",
        stdin: longText,
      },
      {
        id: "review",
        input: {
          prompt: "Review draft?",
          responseSchema: {
            type: "object",
            properties: { decision: { type: "string" } },
            required: ["decision"],
          },
        },
      },
      {
        id: "finish",
        run: "node -e \"let data=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => data += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify({subjectLength:data.length})))\"",
        stdin: "$review.subject.text",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-input-truncate-"));
  const stateDir = path.join(tmpDir, "state");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: stateDir,
    LOBSTER_MAX_TOOL_ENVELOPE_BYTES: "8192",
  };

  const first = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
  });

  assert.equal(first.status, "needs_input");
  assert.deepEqual(first.requiresInput?.subject, {
    truncated: true,
    bytes: Buffer.byteLength(JSON.stringify({ text: longText }), "utf8"),
    preview: JSON.stringify({ text: longText }).slice(0, 2000),
  });

  const payload = decodeResumeToken(first.requiresInput?.resumeToken ?? "");
  assert.equal(payload.kind, "workflow-file");

  const resumed = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
    resume: payload,
    response: { decision: "approve" },
  });

  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ subjectLength: longText.length }]);
});

test("workflow approval resumes require an explicit decision", async () => {
  const workflow = {
    steps: [
      {
        id: "approve_step",
        command:
          "node -e \"process.stdout.write(JSON.stringify({requiresApproval:{prompt:'Proceed?', items:[{id:1}]}}))\"",
        approval: "required",
      },
      {
        id: "finish",
        run: 'node -e "process.stdout.write(JSON.stringify({done:true}))"',
        condition: "$approve_step.approved",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-approval-required-"));
  const stateDir = path.join(tmpDir, "state");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };

  const first = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
  });

  assert.equal(first.status, "needs_approval");
  const payload = decodeResumeToken(first.requiresApproval?.resumeToken ?? "");
  assert.equal(payload.kind, "workflow-file");

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          env,
          mode: "tool",
        },
        resume: payload,
      }),
    /requires --approve yes\|no/i,
  );
});

test("workflow approval can require a different approver than initiator", async () => {
  const workflow = {
    steps: [
      {
        id: "gate",
        approval: {
          prompt: "Proceed?",
          require_different_approver: true,
        },
      },
      {
        id: "finish",
        run: 'node -e "process.stdout.write(JSON.stringify({done:true}))"',
        when: "$gate.approved",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-approval-identity-"));
  const stateDir = path.join(tmpDir, "state");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const baseEnv = {
    ...process.env,
    LOBSTER_STATE_DIR: stateDir,
    LOBSTER_APPROVAL_INITIATED_BY: "agent-1",
  };

  const first = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: baseEnv,
      mode: "tool",
    },
  });
  assert.equal(first.status, "needs_approval");
  assert.equal(first.requiresApproval?.initiatedBy, "agent-1");
  assert.equal(first.requiresApproval?.requireDifferentApprover, true);

  const payload = decodeResumeToken(first.requiresApproval?.resumeToken ?? "");
  assert.equal(payload.kind, "workflow-file");

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          env: { ...baseEnv, LOBSTER_APPROVAL_APPROVED_BY: "agent-1" },
          mode: "tool",
        },
        resume: payload,
        approved: true,
      }),
    /must be granted by someone other than 'agent-1'/i,
  );

  const resumed = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: { ...baseEnv, LOBSTER_APPROVAL_APPROVED_BY: "human-1" },
      mode: "tool",
    },
    resume: payload,
    approved: true,
  });
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ done: true }]);
});

test("workflow approval can require a specific approver identity", async () => {
  const workflow = {
    steps: [
      {
        id: "gate",
        approval: {
          prompt: "Proceed?",
          required_approver: "alice",
        },
      },
      {
        id: "finish",
        run: 'node -e "process.stdout.write(JSON.stringify({done:true}))"',
        when: "$gate.approved",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-required-approver-"));
  const stateDir = path.join(tmpDir, "state");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };

  const first = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
  });
  assert.equal(first.status, "needs_approval");
  assert.equal(first.requiresApproval?.requiredApprover, "alice");

  const payload = decodeResumeToken(first.requiresApproval?.resumeToken ?? "");
  assert.equal(payload.kind, "workflow-file");

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          env: { ...env, LOBSTER_APPROVAL_APPROVED_BY: "bob" },
          mode: "tool",
        },
        resume: payload,
        approved: true,
      }),
    /requires approver 'alice', got 'bob'/i,
  );

  const resumed = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: { ...env, LOBSTER_APPROVAL_APPROVED_BY: "alice" },
      mode: "tool",
    },
    resume: payload,
    approved: true,
  });
  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ done: true }]);
});

test("workflow conditions support comparisons, boolean operators, and parentheses", async () => {
  const workflow = {
    steps: [
      {
        id: "collect",
        run: "node -e \"process.stdout.write(JSON.stringify({kind:'deploy',count:2}))\"",
      },
      {
        id: "review",
        input: {
          prompt: "Review draft?",
          responseSchema: {
            type: "object",
            properties: { decision: { type: "string" } },
            required: ["decision"],
          },
        },
      },
      {
        id: "approve_step",
        command:
          "node -e \"process.stdout.write(JSON.stringify({requiresApproval:{prompt:'Proceed?', items:[{id:1}]}}))\"",
        approval: "required",
      },
      {
        id: "finish",
        run: 'node -e "process.stdout.write(JSON.stringify({ok:true}))"',
        condition:
          "($approve_step.approved && $review.response.decision == approve) && !($collect.json.kind != deploy || $collect.json.count != 2)",
      },
      {
        id: "fallback",
        run: 'node -e "process.stdout.write(JSON.stringify({ok:false}))"',
        condition: "$review.response.decision == reject || $collect.json.kind == skip",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-conditions-"));
  const stateDir = path.join(tmpDir, "state");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };

  const first = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
  });
  assert.equal(first.status, "needs_input");

  const inputPayload = decodeResumeToken(first.requiresInput?.resumeToken ?? "");
  assert.equal(inputPayload.kind, "workflow-file");

  const second = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
    resume: inputPayload,
    response: { decision: "approve" },
  });
  assert.equal(second.status, "needs_approval");

  const approvalPayload = decodeResumeToken(second.requiresApproval?.resumeToken ?? "");
  assert.equal(approvalPayload.kind, "workflow-file");

  const resumed = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: "tool",
    },
    resume: approvalPayload,
    approved: true,
  });

  assert.equal(resumed.status, "ok");
  assert.deepEqual(resumed.output, [{ ok: true }]);
});

test("workflow conditions reject standalone bare identifiers", async () => {
  const workflow = {
    steps: [
      { id: "collect", run: "echo hello" },
      { id: "finish", run: "echo done", condition: "approve" },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-condition-invalid-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          env: { ...process.env },
          mode: "tool",
        },
      }),
    /Unsupported condition: approve/,
  );
});

test("workflow conditions reject unknown step refs even under negation", async () => {
  const workflow = {
    steps: [
      { id: "collect", run: "echo hello" },
      { id: "finish", run: "echo done", condition: "!$aprove.approved" },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-condition-typo-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  await assert.rejects(
    () =>
      runWorkflowFile({
        filePath,
        ctx: {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          env: { ...process.env },
          mode: "tool",
        },
      }),
    /Unknown step reference: aprove\.approved/,
  );
});

test("workflow conditions compare object refs without key-order sensitivity", async () => {
  const workflow = {
    steps: [
      {
        id: "left",
        run: 'node -e "process.stdout.write(JSON.stringify({a:1,b:2}))"',
      },
      {
        id: "right",
        run: 'node -e "process.stdout.write(JSON.stringify({b:2,a:1}))"',
      },
      {
        id: "finish",
        run: 'node -e "process.stdout.write(JSON.stringify({ok:true}))"',
        condition: "$left.json == $right.json",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-condition-object-eq-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const result = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: { ...process.env },
      mode: "tool",
    },
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.output, [{ ok: true }]);
});

test("workflow files can mix shell steps, approval-only steps, and pipeline llm steps", async () => {
  const registry = createDefaultRegistry();
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/invoke") {
      res.writeHead(404);
      res.end("nope");
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      requests.push(parsed);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            runId: "http_1",
            model: parsed.model || "test-model",
            prompt: parsed.prompt,
            output: {
              format: "json",
              text: '{"recommendation":"no","reason":"warm"}',
              data: { recommendation: "no", reason: "warm" },
            },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  const workflow = {
    name: "mixed-workflow",
    steps: [
      {
        id: "fetch",
        run: "node -e \"process.stdout.write(JSON.stringify({location:'Phoenix',temp_f:73.8,humidity_pct:13,wind_mph:3.4}))\"",
      },
      {
        id: "confirm",
        approval: "Want jacket advice from the LLM?",
        stdin: "$fetch.json",
      },
      {
        id: "advice",
        pipeline:
          'llm.invoke --provider http --prompt "Given this weather data, should I wear a jacket? Return JSON." --disable-cache',
        stdin: "$fetch.json",
        when: "$confirm.approved",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-mixed-"));
  const stateDir = path.join(tmpDir, "state");
  const cacheDir = path.join(tmpDir, "cache");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: stateDir,
    LOBSTER_CACHE_DIR: cacheDir,
    LOBSTER_LLM_ADAPTER_URL: `http://127.0.0.1:${port}`,
  };

  try {
    const first = await runWorkflowFile({
      filePath,
      ctx: {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env,
        mode: "tool",
        registry,
      },
    });

    assert.equal(first.status, "needs_approval");
    assert.equal(first.requiresApproval?.prompt, "Want jacket advice from the LLM?");
    assert.match(first.requiresApproval?.preview ?? "", /Phoenix/);
    assert.ok(first.requiresApproval?.resumeToken);

    const payload = decodeResumeToken(first.requiresApproval?.resumeToken ?? "");
    assert.equal(payload.kind, "workflow-file");

    const resumed = await runWorkflowFile({
      filePath,
      ctx: {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env,
        mode: "tool",
        registry,
      },
      resume: payload,
      approved: true,
    });

    assert.equal(resumed.status, "ok");
    assert.equal(resumed.output.length, 1);
    assert.equal((resumed.output[0] as any).kind, "llm.invoke");
    assert.equal((resumed.output[0] as any).output.data.recommendation, "no");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].artifacts[0].location, "Phoenix");
  } finally {
    await closeServer(server);
  }
});

test("workflow pipeline llm_task.invoke consumes stdin artifacts from previous step", async () => {
  const registry = createDefaultRegistry();
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/tools/invoke") {
      res.writeHead(404);
      res.end("nope");
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      requests.push(parsed);
      const text = String(parsed?.args?.artifacts?.[0]?.text ?? "");
      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            ok: true,
            result: {
              runId: "task_1",
              model: parsed?.args?.model ?? "test-model",
              prompt: parsed?.args?.prompt,
              output: {
                text: JSON.stringify({ word_count: wordCount }),
                data: { word_count: wordCount },
                format: "json",
              },
            },
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  const workflow = {
    name: "word-counter",
    steps: [
      {
        id: "make_words",
        run: 'echo "One two three four five six"',
      },
      {
        id: "count_words",
        pipeline:
          'llm_task.invoke --prompt "How many words have been pasted below?" --disable-cache',
        stdin: "$make_words.stdout",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-llm-task-stdin-"));
  const stateDir = path.join(tmpDir, "state");
  const cacheDir = path.join(tmpDir, "cache");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const env = {
    ...process.env,
    LOBSTER_STATE_DIR: stateDir,
    LOBSTER_CACHE_DIR: cacheDir,
    OPENCLAW_URL: `http://127.0.0.1:${port}`,
  };

  try {
    const result = await runWorkflowFile({
      filePath,
      ctx: {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env,
        mode: "tool",
        registry,
      },
    });

    assert.equal(result.status, "ok");
    assert.equal(result.output.length, 1);
    assert.equal((result.output[0] as any).kind, "llm_task.invoke");
    assert.equal((result.output[0] as any).output.data.word_count, 6);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].tool, "llm-task");
    assert.equal(requests[0].action, "invoke");
    assert.equal(requests[0].args.prompt, "How many words have been pasted below?");
    assert.match(
      String(requests[0].args.artifacts?.[0]?.text ?? ""),
      /One two three four five six/,
    );
  } finally {
    await closeServer(server);
  }
});

test("workflow pipeline steps respect cwd and feed later shell steps via stdout refs", async () => {
  const registry = createDefaultRegistry();
  const workflow = {
    cwd: "${TARGET_DIR}",
    steps: [
      {
        id: "pwd",
        pipeline: "exec pwd",
      },
      {
        id: "capture",
        run: "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({pwd:d.trim()}));});\"",
        stdin: "$pwd.stdout",
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-workflow-pipeline-cwd-"));
  const targetDir = path.join(tmpDir, "nested");
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

  const result = await runWorkflowFile({
    filePath,
    args: { TARGET_DIR: targetDir },
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: { ...process.env, LOBSTER_STATE_DIR: path.join(tmpDir, "state") },
      mode: "tool",
      registry,
    },
  });

  assert.equal(result.status, "ok");
  const resolvedTargetDir = await fsp.realpath(targetDir);
  assert.deepEqual(result.output, [{ pwd: resolvedTargetDir }]);
});

async function closeServer(server: http.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
