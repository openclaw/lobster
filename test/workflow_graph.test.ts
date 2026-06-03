import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { renderWorkflowGraph } from "../src/workflows/graph.js";

function runCli(args: string[], env?: Record<string, string | undefined>) {
  const bin = path.join(process.cwd(), "bin", "lobster.js");
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...(env ?? {}) },
  });
}

test("workflow graph renderer outputs mermaid nodes and labeled edges", () => {
  const workflow = {
    args: { city: { default: "Phoenix" } },
    steps: [
      { id: "fetch", run: "weather --json ${city}" },
      { id: "confirm", approval: "Proceed?", stdin: "$fetch.json" },
      {
        id: "advice",
        pipeline: 'llm.invoke --prompt "Summarize this weather"',
        stdin: "$fetch.stdout",
        when: "$confirm.approved && $fetch.json.temp > 70",
      },
    ],
  };

  const output = renderWorkflowGraph({ workflow, format: "mermaid", args: { city: "Seattle" } });
  assert.match(output, /^flowchart TD/m);
  assert.match(output, /fetch\["fetch\\nrun: weather --json Seattle"\]/);
  assert.match(output, /confirm\{"confirm\\napproval gate"\}/);
  assert.match(
    output,
    /advice\["advice\\npipeline: llm\.invoke --prompt \\"Summarize this weather\\""\]/,
  );
  assert.match(output, /fetch -->\|stdin\| confirm/);
  assert.match(output, /fetch -->\|stdin\| advice/);
  assert.match(
    output,
    /confirm -->\|when: \$confirm\.approved && \$fetch\.json\.temp > 70\| advice/,
  );
});

test("workflow graph renderer outputs dot with approval shape", () => {
  const workflow = {
    steps: [
      { id: "fetch", run: "echo hello" },
      { id: "confirm", approval: "Proceed?", stdin: "$fetch.stdout" },
    ],
  };

  const output = renderWorkflowGraph({ workflow, format: "dot" });
  assert.match(output, /^digraph workflow \{/m);
  assert.match(output, /"confirm" \[shape=diamond,label="confirm\\\\napproval gate"\];/);
  assert.match(output, /"fetch" -> "confirm" \[label="stdin"\];/);
});

test("cli graph defaults to mermaid and resolves --args-json values", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-graph-cli-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  const workflow = [
    "name: weather-check",
    "args:",
    "  city:",
    "    default: Phoenix",
    "steps:",
    "  - id: fetch",
    "    run: weather --json ${city}",
    "  - id: confirm",
    "    approval: Proceed?",
    "    stdin: $fetch.json",
  ].join("\n");
  await fsp.writeFile(filePath, workflow, "utf8");

  const result = runCli(["graph", "--file", filePath, "--args-json", '{"city":"Seattle"}']);
  assert.equal(result.status, 0, `stderr=${result.stderr}`);
  assert.match(result.stdout, /^flowchart TD/m);
  assert.match(result.stdout, /run: weather --json Seattle/);
  assert.match(result.stdout, /confirm\{"confirm\\napproval gate"\}/);
});

test("cli graph supports --format dot", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-graph-dot-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  const workflow = [
    "steps:",
    "  - id: fetch",
    "    run: echo hello",
    "  - id: gate",
    "    approval: Proceed?",
    "    stdin: $fetch.stdout",
  ].join("\n");
  await fsp.writeFile(filePath, workflow, "utf8");

  const result = runCli(["graph", "--file", filePath, "--format", "dot"]);
  assert.equal(result.status, 0, `stderr=${result.stderr}`);
  assert.match(result.stdout, /^digraph workflow \{/m);
  assert.match(result.stdout, /"gate" \[shape=diamond/);
});

test("cli graph rejects unsupported formats", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-graph-bad-format-"));
  const filePath = path.join(tmpDir, "workflow.lobster");
  await fsp.writeFile(filePath, "steps:\n  - id: s\n    run: echo ok\n", "utf8");

  const result = runCli(["graph", "--file", filePath, "--format", "svg"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /graph --format must be one of: mermaid, dot, ascii/);
});
