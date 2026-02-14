#!/usr/bin/env node

// Shell-accessible wrapper for the llm_task.invoke pipeline command.
// Allows workflow steps (which run via /bin/sh) to call llm_task.invoke
// without going through the lobster pipeline runner.
//
// Usage:
//   llm-task-invoke --prompt 'Summarize this document'
//   cat artifact.json | llm-task-invoke --prompt 'Score the item'
//   llm-task-invoke --prompt 'Extract metadata' --output-schema '{"type":"object"}'

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveImport(relPath) {
  const distPath = join(__dirname, "../dist", relPath);
  if (existsSync(distPath)) return distPath;
  return join(__dirname, "..", relPath);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--help" || tok === "-h") {
      args._help = true;
      continue;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        args[tok.slice(2, eq)] = tok.slice(eq + 1);
        continue;
      }
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
        continue;
      }
      args[key] = next;
      i++;
      continue;
    }
    args._.push(tok);
  }
  return args;
}

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return null;
  return text;
}

async function* stdinToArtifacts(text) {
  // Try as JSON first (array or single object)
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      for (const item of parsed) yield item;
      return;
    }
    yield parsed;
    return;
  } catch {
    // not valid JSON
  }

  // Try JSONL (one object per line)
  const lines = text.split("\n").filter((l) => l.trim());
  let yieldedAny = false;
  for (const line of lines) {
    try {
      yield JSON.parse(line);
      yieldedAny = true;
    } catch {
      // skip non-JSON lines
    }
  }

  // Plain text -> text artifact
  if (!yieldedAny) {
    yield { kind: "text", text };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args._help) {
    const mod = await import(resolveImport("src/commands/stdlib/llm_task_invoke.js"));
    process.stdout.write(mod.llmTaskInvokeCommand.help() + "\n");
    process.exit(0);
  }

  const mod = await import(resolveImport("src/commands/stdlib/llm_task_invoke.js"));
  const command = mod.llmTaskInvokeCommand;

  const stdinText = await readStdin();

  async function* emptyStream() {
    // no items
  }

  const input = stdinText ? stdinToArtifacts(stdinText) : emptyStream();

  const ctx = {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };

  const result = await command.run({ input, args, ctx });

  for await (const item of result.output) {
    process.stdout.write(JSON.stringify(item) + "\n");
  }
}

main().catch((err) => {
  process.stderr.write(`llm-task-invoke: ${err.message}\n`);
  process.exitCode = 1;
});
