import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, promises as fsp } from "node:fs";
import { createDefaultRegistry } from "../src/commands/registry.js";
import { runPipeline } from "../src/runtime.js";
import { diffLast, diffAndStoreValue } from "../src/sdk/primitives/diff.js";
import { stateSet, readState, writeState } from "../src/sdk/primitives/state.js";
import {
  createApprovalIndex,
  diffAndStore,
  writeStateJson,
  readStateJson,
  writeFileAtomic,
  writeFileAtomicExclusive,
} from "../src/state/store.js";

function streamOf(items) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test("state.set writes and state.get reads", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-state-"));
  const registry = createDefaultRegistry();

  const env = { ...process.env, LOBSTER_STATE_DIR: tmp };

  // write
  const setCmd = registry.get("state.set");
  await setCmd.run({
    input: streamOf([{ a: 1 }]),
    args: { _: ["demo-key"] },
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      registry,
      mode: "tool",
      render: { json() {}, lines() {} },
    },
  });

  // read
  const getCmd = registry.get("state.get");
  const res = await getCmd.run({
    input: streamOf([]),
    args: { _: ["demo-key"] },
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      registry,
      mode: "tool",
      render: { json() {}, lines() {} },
    },
  });

  const items = [];
  for await (const it of res.output) items.push(it);
  assert.deepEqual(items, [{ a: 1 }]);
});

test("state.get returns null for missing key", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-state-"));
  const registry = createDefaultRegistry();
  const env = { ...process.env, LOBSTER_STATE_DIR: tmp };

  const output = await runPipeline({
    pipeline: [{ name: "state.get", args: { _: ["missing"] }, raw: "state.get missing" }],
    registry,
    input: [],
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env,
    mode: "tool",
  });

  assert.deepEqual(output.items, [null]);
});

// --- Atomic-write behavior proofs (issues #108, #109) ---
//
// Plain fsp.writeFile truncates the target before writing, so a concurrent
// reader (or a crash mid-write) can observe an empty/partial file and fail to
// JSON.parse it. These tests drive many large writes while reading in parallel
// and assert the reader NEVER sees a truncated value. They fail against the
// pre-fix non-atomic writeFile and pass with writeFileAtomic (stage + rename).

test("writeStateJson is atomic: concurrent reads never observe truncated state (#108)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-atomic-store-"));
  const env = { LOBSTER_STATE_DIR: tmp };
  const key = "pipeline-resume";
  const payload = "x".repeat(256 * 1024); // large enough that writeFile is not instantaneous

  await writeStateJson({ env, key, value: { payload, n: 0 } });

  let readErrors = 0;
  let partialReads = 0;
  const reader = (async () => {
    for (let i = 0; i < 500; i++) {
      try {
        const v = await readStateJson({ env, key });
        if (!v || v.payload !== payload) partialReads++;
      } catch {
        readErrors++; // JSON.parse on truncated content throws SyntaxError
      }
    }
  })();
  const writer = (async () => {
    for (let n = 1; n <= 150; n++) {
      await writeStateJson({ env, key, value: { payload, n } });
    }
  })();
  await Promise.all([reader, writer]);

  assert.equal(readErrors, 0, "reader must never hit a parse/IO error mid-write");
  assert.equal(partialReads, 0, "reader must never observe truncated/empty state");

  const leftovers = (await fsp.readdir(tmp)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, [], "atomic write must not leave temp files behind");
});

test("writeFileAtomic creates private files and preserves existing modes", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-atomic-mode-"));
  const freshPath = path.join(tmp, "fresh.json");
  const existingPath = path.join(tmp, "existing.json");

  await writeFileAtomic(freshPath, '{"ok":true}\n');
  assert.equal((await fsp.stat(freshPath)).mode & 0o777, 0o600);

  await fsp.writeFile(existingPath, '{"old":true}\n', { mode: 0o640 });
  await fsp.chmod(existingPath, 0o640);
  await writeFileAtomic(existingPath, '{"ok":true}\n');
  assert.equal((await fsp.stat(existingPath)).mode & 0o777, 0o640);
});

test("writeFileAtomic removes temp files when replacement fails", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-atomic-cleanup-"));
  const targetDir = path.join(tmp, "state.json");
  await fsp.mkdir(targetDir);

  await assert.rejects(() => writeFileAtomic(targetDir, '{"ok":true}\n'));
  const leftovers = (await fsp.readdir(tmp)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("writeFileAtomic leaves existing target untouched when publish fails", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-atomic-fault-"));
  const target = path.join(tmp, "state.json");
  await fsp.writeFile(target, '{"old":true}\n', { mode: 0o600 });
  const fault = Object.assign(new Error("rename failed"), { code: "EIO" });

  await assert.rejects(
    () =>
      writeFileAtomic(target, '{"new":true}\n', {
        async renameFile() {
          throw fault;
        },
      }),
    (err: NodeJS.ErrnoException) => err?.code === "EIO",
  );

  assert.equal(await fsp.readFile(target, "utf8"), '{"old":true}\n');
  const leftovers = (await fsp.readdir(tmp)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("writeFileAtomic propagates parent directory sync failures", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-atomic-dir-sync-"));
  const target = path.join(tmp, "state.json");
  const fault = Object.assign(new Error("dir sync failed"), { code: "EIO" });

  await assert.rejects(
    () =>
      writeFileAtomic(target, '{"ok":true}\n', {
        async syncParentDir() {
          throw fault;
        },
      }),
    (err: NodeJS.ErrnoException) => err?.code === "EIO",
  );

  assert.equal(await fsp.readFile(target, "utf8"), '{"ok":true}\n');
  const leftovers = (await fsp.readdir(tmp)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("readStateJson surfaces malformed authoritative state", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-state-corrupt-"));
  const env = { LOBSTER_STATE_DIR: tmp };
  await fsp.writeFile(path.join(tmp, "resume.json"), '{"partial"', "utf8");

  await assert.rejects(() => readStateJson({ env, key: "resume" }), SyntaxError);
});

test("writeFileAtomicExclusive creates private files without replacing existing targets", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-atomic-exclusive-"));
  const target = path.join(tmp, "approval_deadbeef.json");

  await writeFileAtomicExclusive(target, '{"stateKey":"original"}\n');
  assert.equal((await fsp.stat(target)).mode & 0o777, 0o600);

  await assert.rejects(
    () => writeFileAtomicExclusive(target, '{"stateKey":"replacement"}\n'),
    (err: NodeJS.ErrnoException) => err?.code === "EEXIST",
  );
  assert.equal(await fsp.readFile(target, "utf8"), '{"stateKey":"original"}\n');

  const leftovers = (await fsp.readdir(tmp)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("writeFileAtomicExclusive removes temp link before final directory sync", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-atomic-exclusive-sync-order-"));
  const target = path.join(tmp, "approval_deadbeef.json");
  let filesAtSync: string[] = [];

  await writeFileAtomicExclusive(target, '{"stateKey":"original"}\n', {
    async syncParentDir() {
      filesAtSync = await fsp.readdir(tmp);
    },
  });

  assert.equal(await fsp.readFile(target, "utf8"), '{"stateKey":"original"}\n');
  assert.ok(filesAtSync.includes("approval_deadbeef.json"));
  assert.deepEqual(
    filesAtSync.filter((file) => file.includes(".tmp")),
    [],
  );
});

test("writeFileAtomicExclusive rejects unsupported hard links without a partial target", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-atomic-exclusive-unsupported-"));
  const target = path.join(tmp, "approval_deadbeef.json");
  const unsupported = Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
  const options = {
    async linkFile() {
      throw unsupported;
    },
  };

  await assert.rejects(
    () => writeFileAtomicExclusive(target, '{"stateKey":"original"}\n', options),
    (err: NodeJS.ErrnoException) => err?.code === "ENOTSUP",
  );
  await assert.rejects(
    () => fsp.stat(target),
    (err: NodeJS.ErrnoException) => err?.code === "ENOENT",
  );

  const leftovers = (await fsp.readdir(tmp)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("writeFileAtomicExclusive removes published target when parent directory sync fails", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-atomic-exclusive-dir-sync-"));
  const target = path.join(tmp, "approval_deadbeef.json");
  const fault = Object.assign(new Error("dir sync failed"), { code: "EIO" });

  await assert.rejects(
    () =>
      writeFileAtomicExclusive(target, '{"stateKey":"original"}\n', {
        async syncParentDir() {
          throw fault;
        },
      }),
    (err: NodeJS.ErrnoException) => err?.code === "EIO",
  );
  await assert.rejects(
    () => fsp.stat(target),
    (err: NodeJS.ErrnoException) => err?.code === "ENOENT",
  );

  const leftovers = (await fsp.readdir(tmp)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("createApprovalIndex omits short ID when atomic exclusive publish is unsupported", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-approval-index-unsupported-"));
  const env = { LOBSTER_STATE_DIR: tmp };
  const unsupported = Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });

  const approvalId = await createApprovalIndex({
    env,
    stateKey: "workflow_resume_1",
    options: {
      async linkFile() {
        throw unsupported;
      },
    },
  });

  assert.equal(approvalId, null);
  const files = await fsp.readdir(tmp);
  assert.deepEqual(files, []);
});

test("createApprovalIndex omits short ID when approval index durability fails", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-approval-index-sync-fails-"));
  const env = { LOBSTER_STATE_DIR: tmp };
  const fault = Object.assign(new Error("dir sync failed"), { code: "EIO" });

  const approvalId = await createApprovalIndex({
    env,
    stateKey: "workflow_resume_1",
    options: {
      async syncParentDir() {
        throw fault;
      },
    },
  });

  assert.equal(approvalId, null);
  const files = await fsp.readdir(tmp);
  assert.deepEqual(files, []);
});

test("diffAndStore treats corrupt previous state as a miss and rewrites atomically (#112)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-diff-corrupt-"));
  const env = { LOBSTER_STATE_DIR: tmp };
  await fsp.writeFile(path.join(tmp, "snapshot.json"), '{"partial"', "utf8");

  const result = await diffAndStore({ env, key: "snapshot", value: { ok: true } });

  assert.equal(result.before, null);
  assert.equal(result.changed, true);
  assert.deepEqual(await readStateJson({ env, key: "snapshot" }), { ok: true });
});

test("SDK diff primitives treat corrupt previous state as a miss (#112)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-sdk-diff-corrupt-"));
  const ctx = { env: { LOBSTER_STATE_DIR: tmp } };
  await fsp.writeFile(path.join(tmp, "sdk-snapshot.json"), '{"partial"', "utf8");

  const direct = await diffAndStoreValue("sdk-snapshot", { next: true }, ctx);
  assert.equal(direct.before, null);
  assert.equal(direct.changed, true);

  await fsp.writeFile(path.join(tmp, "stage-snapshot.json"), '{"partial"', "utf8");
  const stage = diffLast("stage-snapshot");
  const result = await stage.run({ input: streamOf([{ next: true }]), ctx });
  const output = [];
  for await (const item of result.output) output.push(item);

  assert.deepEqual(output, [
    {
      kind: "diff.last",
      key: "stage-snapshot",
      changed: true,
      before: null,
      after: { next: true },
    },
  ]);
});

test("SDK stateSet/readState is atomic under concurrent reads (#109)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-atomic-sdk-"));
  const ctx = { env: { LOBSTER_STATE_DIR: tmp } };
  const key = "sdk-state";
  const payload = "y".repeat(256 * 1024);

  const writeOnce = async (n: number) => {
    const prim = stateSet(key);
    const input = (async function* () {
      yield { payload, n };
    })();
    const res = await prim.run({ input, ctx });
    for await (const _ of res.output) {
      void _;
    }
  };

  await writeOnce(0);

  let readErrors = 0;
  let partialReads = 0;
  const reader = (async () => {
    for (let i = 0; i < 500; i++) {
      try {
        const v = await readState(key, ctx);
        if (!v || v.payload !== payload) partialReads++;
      } catch {
        readErrors++;
      }
    }
  })();
  const writer = (async () => {
    for (let n = 1; n <= 120; n++) {
      await writeOnce(n);
    }
  })();
  await Promise.all([reader, writer]);

  assert.equal(readErrors, 0, "SDK reader must never hit a parse/IO error mid-write");
  assert.equal(partialReads, 0, "SDK reader must never observe truncated/empty state");
});

test("SDK writeState preserves restricted state-file mode", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-atomic-sdk-mode-"));
  const ctx = { env: { LOBSTER_STATE_DIR: tmp } };
  const filePath = path.join(tmp, "sdk-state.json");
  await fsp.mkdir(tmp, { recursive: true });
  await fsp.writeFile(filePath, '{"old":true}\n', { mode: 0o600 });
  await fsp.chmod(filePath, 0o600);

  await writeState("sdk-state", { ok: true }, ctx);

  assert.equal((await fsp.stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(await readState("sdk-state", ctx), { ok: true });
});

test("SDK writeState removes temp files when replacement fails", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-atomic-sdk-cleanup-"));
  const ctx = { env: { LOBSTER_STATE_DIR: tmp } };
  await fsp.mkdir(path.join(tmp, "sdk-state.json"));

  await assert.rejects(() => writeState("sdk-state", { ok: true }, ctx));
  const leftovers = (await fsp.readdir(tmp)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});
