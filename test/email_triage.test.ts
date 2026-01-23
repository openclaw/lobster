import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { runPipeline } from "../src/runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test("gog.gmail.search | email.triage works end-to-end (mock gog)", async () => {
  const registry = createDefaultRegistry();

  // Tests run from dist/, but fixtures live in source tree.
  const repoRoot = join(__dirname, "..", "..");
  const mockGog = join(repoRoot, "test", "fixtures", "mock-gog.mjs");

  const result = await runPipeline({
    pipeline: [
      { name: "gog.gmail.search", args: { query: "newer_than:1d", max: 20 }, raw: "" },
      { name: "email.triage", args: { limit: 20 }, raw: "" },
    ],
    registry,
    input: [],
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: { ...process.env, GOG_BIN: mockGog },
    mode: "tool",
  } as any);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].summary, "1 need replies, 1 need action, 1 FYI");
});

test("email.triage buckets based on subject/from/labels", async () => {
  const registry = createDefaultRegistry();

  const emails = [
    {
      id: "m1",
      threadId: "t1",
      from: "Alice <alice@example.com>",
      subject: "Quick question",
      date: "2026-01-22T07:00:00Z",
      snippet: "Hey, can you take a look?",
      labels: ["INBOX", "UNREAD"],
    },
    {
      id: "m2",
      threadId: "t2",
      from: "no-reply@service.com",
      subject: "Your receipt",
      date: "2026-01-22T06:00:00Z",
      snippet: "Thanks",
      labels: ["INBOX", "UNREAD"],
    },
    {
      id: "m3",
      threadId: "t3",
      from: "Bob <bob@example.com>",
      subject: "Action required: NDA",
      date: "2026-01-21T23:00:00Z",
      snippet: "Please sign",
      labels: ["INBOX"],
    },
  ];

  const input = (async function* () {
    for (const e of emails) yield e;
  })();

  const result = await runPipeline({
    pipeline: [{ name: "email.triage", args: { limit: 20 }, raw: "" }],
    registry,
    input,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    mode: "tool",
  } as any);

  assert.equal(result.items.length, 1);
  const out = result.items[0];
  assert.equal(out.summary, "1 need replies, 1 need action, 1 FYI");
  assert.deepEqual(out.buckets.needsReply, ["m1"]);
  assert.deepEqual(out.buckets.needsAction, ["m3"]);
  assert.deepEqual(out.buckets.fyi, ["m2"]);
});
