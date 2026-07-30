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
	keyToPath,
	withFileLock,
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

test("diffAndStore does not publish a snapshot after cancellation before atomic replace", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-diff-cancel-publish-"));
	const env = { LOBSTER_STATE_DIR: tmp };
	await writeStateJson({ env, key: "snapshot", value: { version: "before" } });

	const controller = new AbortController();
	const signal = controller.signal;
	const throwIfAborted = signal.throwIfAborted.bind(signal);
	let signalChecks = 0;
	Object.defineProperty(signal, "throwIfAborted", {
		value() {
			signalChecks += 1;
			if (signalChecks === 2) controller.abort(new Error("abort before state publish"));
			throwIfAborted();
		},
	});

	await assert.rejects(
		() => diffAndStore({ env, key: "snapshot", value: { version: "after" }, signal }),
		/abort before state publish/,
	);
	assert.equal(signalChecks, 2);
	assert.deepEqual(await readStateJson({ env, key: "snapshot" }), { version: "before" });
	const leftovers = (await fsp.readdir(tmp)).filter((file) => file.includes(".tmp"));
	assert.deepEqual(leftovers, []);
});

test("diffAndStore restores the previous snapshot when cancellation arrives during atomic rename", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-diff-cancel-rename-"));
	const env = { LOBSTER_STATE_DIR: tmp };
	await writeStateJson({ env, key: "snapshot", value: { version: "before" } });

	const controller = new AbortController();
	await assert.rejects(
		() =>
			diffAndStore({
				env,
				key: "snapshot",
				value: { version: "after" },
				signal: controller.signal,
				atomicWriteOptions: {
					async renameFile(from, to) {
						await fsp.rename(from, to);
						controller.abort(new Error("abort during atomic rename"));
					},
				},
			}),
		/abort during atomic rename/,
	);
	assert.deepEqual(await readStateJson({ env, key: "snapshot" }), { version: "before" });
	const leftovers = (await fsp.readdir(tmp)).filter((file) => file.includes(".tmp"));
	assert.deepEqual(leftovers, []);
});

test("diffAndStore removes a newly published snapshot when cancellation arrives during atomic rename", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-diff-cancel-new-rename-"));
	const env = { LOBSTER_STATE_DIR: tmp };
	const controller = new AbortController();

	await assert.rejects(
		() =>
			diffAndStore({
				env,
				key: "snapshot",
				value: { version: "after" },
				signal: controller.signal,
				atomicWriteOptions: {
					async renameFile(from, to) {
						await fsp.rename(from, to);
						controller.abort(new Error("abort during initial atomic rename"));
					},
				},
			}),
		/abort during initial atomic rename/,
	);
	assert.equal(await readStateJson({ env, key: "snapshot" }), null);
	const leftovers = (await fsp.readdir(tmp)).filter((file) => file.includes(".tmp"));
	assert.deepEqual(leftovers, []);
});

test("diffAndStore restores an existing null snapshot when cancellation arrives during atomic rename", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-diff-cancel-null-rename-"));
	const env = { LOBSTER_STATE_DIR: tmp };
	await writeStateJson({ env, key: "snapshot", value: null });
	const snapshotPath = keyToPath(tmp, "snapshot");

	const controller = new AbortController();
	await assert.rejects(
		() =>
			diffAndStore({
				env,
				key: "snapshot",
				value: { version: "after" },
				signal: controller.signal,
				atomicWriteOptions: {
					async renameFile(from, to) {
						await fsp.rename(from, to);
						controller.abort(new Error("abort during null snapshot rename"));
					},
				},
			}),
		/abort during null snapshot rename/,
	);
	assert.equal(await readStateJson({ env, key: "snapshot" }), null);
	assert.equal(await fsp.readFile(snapshotPath, "utf8"), "null\n");
});

test("diffAndStore serializes cancellation rollback before a concurrent snapshot update", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-diff-cancel-concurrent-"));
	const env = { LOBSTER_STATE_DIR: tmp };
	await writeStateJson({ env, key: "snapshot", value: { version: "before" } });

	const controller = new AbortController();
	let publishCancelledSnapshot!: () => void;
	const cancelledSnapshotPublished = new Promise<void>((resolve) => {
		publishCancelledSnapshot = resolve;
	});
	let allowCancellation!: () => void;
	const waitForCancellation = new Promise<void>((resolve) => {
		allowCancellation = resolve;
	});
	const cancelled = diffAndStore({
		env,
		key: "snapshot",
		value: { version: "cancelled-A" },
		signal: controller.signal,
		atomicWriteOptions: {
			async renameFile(from, to) {
				await fsp.rename(from, to);
				publishCancelledSnapshot();
				await waitForCancellation;
			},
		},
	});
	await cancelledSnapshotPublished;

	let successfulSnapshotPublished = false;
	const successful = writeState("snapshot", { version: "successful-B" }, { env }).then(() => {
		successfulSnapshotPublished = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(successfulSnapshotPublished, false, "the next writer must wait for rollback");

	controller.abort(new Error("abort during concurrent atomic rename"));
	allowCancellation();
	await assert.rejects(cancelled, /abort during concurrent atomic rename/);
	await successful;
	assert.equal(successfulSnapshotPublished, true);
	assert.deepEqual(await readStateJson({ env, key: "snapshot" }), { version: "successful-B" });
	const leftovers = (await fsp.readdir(tmp)).filter(
		(file) => file.includes(".tmp") || file.endsWith(".lock"),
	);
	assert.deepEqual(leftovers, []);
});

test("state.set stops waiting for a live state lock when its signal is aborted", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-state-lock-abort-"));
	const env = { LOBSTER_STATE_DIR: tmp };
	const key = "blocked";
	const lockPath = `${keyToPath(tmp, key)}.lock`;
	await fsp.mkdir(lockPath);
	await fsp.writeFile(path.join(lockPath, "owner"), `${process.pid}::live-writer\n`, "utf8");

	const controller = new AbortController();
	const stateSet = createDefaultRegistry().get("state.set");
	const pending = stateSet.run({
		input: streamOf([{ value: true }]),
		args: { _: [key] },
		ctx: {
			stdin: process.stdin,
			stdout: process.stdout,
			stderr: process.stderr,
			env,
			signal: controller.signal,
		},
	});
	const completion = pending.then(
		() => ({ kind: "success" as const }),
		(error) => ({ kind: "error" as const, error }),
	);

	await new Promise((resolve) => setImmediate(resolve));
	controller.abort(new Error("state lock cancelled"));
	const early = await Promise.race([
		completion,
		new Promise<{ kind: "timeout" }>((resolve) =>
			setTimeout(() => resolve({ kind: "timeout" }), 75),
		),
	]);
	if (early.kind === "timeout") await fsp.rm(lockPath, { recursive: true, force: true });
	const settled = early.kind === "timeout" ? await completion : early;

	assert.notEqual(early.kind, "timeout", "state.set must not remain blocked after cancellation");
	assert.equal(settled.kind, "error");
	if (settled.kind === "error") assert.match(settled.error?.message ?? "", /state lock cancelled/);
	await fsp.rm(lockPath, { recursive: true, force: true });
});

test("diffAndStore does not reclaim a live fallback lock after a short heartbeat gap", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-state-lock-lease-"));
	const env = { LOBSTER_STATE_DIR: tmp };
	const key = "snapshot";
	const lockPath = `${keyToPath(tmp, key)}.lock`;
	const ownerPath = path.join(lockPath, "owner");
	await fsp.mkdir(lockPath);
	await fsp.writeFile(ownerPath, `${process.pid}::live-writer\n`, "utf8");
	const briefGap = new Date(Date.now() - 2_000);
	await fsp.utimes(lockPath, briefGap, briefGap);
	await fsp.utimes(ownerPath, briefGap, briefGap);

	const controller = new AbortController();
	const abort = setTimeout(
		() => controller.abort(new Error("live fallback lock remained held")),
		100,
	);
	try {
		await assert.rejects(
			() => diffAndStore({ env, key, value: { version: "new" }, signal: controller.signal }),
			/live fallback lock remained held/,
		);
	} finally {
		clearTimeout(abort);
		await fsp.rm(lockPath, { recursive: true, force: true });
	}
	assert.equal(await readStateJson({ env, key }), null);
});

test("diffAndStore reclaims an old lock with a malformed owner", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-diff-malformed-lock-"));
	const env = { LOBSTER_STATE_DIR: tmp };
	const lockPath = `${keyToPath(tmp, "snapshot")}.lock`;
	await fsp.mkdir(lockPath);
	await fsp.writeFile(path.join(lockPath, "owner"), "\n", "utf8");
	const staleAt = new Date(Date.now() - 10_000);
	await fsp.utimes(lockPath, staleAt, staleAt);

	await diffAndStore({ env, key: "snapshot", value: { version: "recovered" } });
	assert.deepEqual(await readStateJson({ env, key: "snapshot" }), { version: "recovered" });
	await assert.rejects(fsp.access(lockPath));
});

test("diffAndStore reclaims an old lock after its owner PID is reused", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-diff-reused-pid-lock-"));
	const env = { LOBSTER_STATE_DIR: tmp };
	const lockPath = `${keyToPath(tmp, "snapshot")}.lock`;
	const ownerPath = path.join(lockPath, "owner");
	await fsp.mkdir(lockPath);
	await fsp.writeFile(ownerPath, `${process.pid}:0:stale-owner\n`, "utf8");
	const staleAt = new Date(Date.now() - 10_000);
	await fsp.utimes(lockPath, staleAt, staleAt);
	await fsp.utimes(ownerPath, staleAt, staleAt);

	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error("reused lock was not reclaimed")),
		250,
	);
	try {
		await diffAndStore({
			env,
			key: "snapshot",
			value: { version: "recovered" },
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
	assert.equal(controller.signal.aborted, false);
	assert.deepEqual(await readStateJson({ env, key: "snapshot" }), { version: "recovered" });
	await assert.rejects(fsp.access(lockPath));
});

test("withFileLock does not reclaim a replacement lock after observing a stale one", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "lobster-state-lock-replacement-"));
	const filePath = path.join(tmp, "snapshot.json");
	const lockPath = `${filePath}.lock`;
	await fsp.mkdir(lockPath);
	await fsp.writeFile(path.join(lockPath, "owner"), `${process.pid}:0:stale-owner\n`, "utf8");
	const staleAt = new Date(Date.now() - 10_000);
	await fsp.utimes(lockPath, staleAt, staleAt);
	await fsp.utimes(path.join(lockPath, "owner"), staleAt, staleAt);

	const originalReadFile = fsp.readFile;
	let replaced = false;
	let replacementActive = false;
	let overlap = false;
	let replacement: Promise<void> | undefined;
	let releaseReplacement!: () => void;
	const replacementReleased = new Promise<void>((resolve) => {
		releaseReplacement = resolve;
	});
	let replacementStarted!: () => void;
	const replacementEntered = new Promise<void>((resolve) => {
		replacementStarted = resolve;
	});

	Object.defineProperty(fsp, "readFile", {
		configurable: true,
		writable: true,
		async value(
			filePathArg: Parameters<typeof fsp.readFile>[0],
			options?: Parameters<typeof fsp.readFile>[1],
		) {
			const result = await originalReadFile(filePathArg, options);
			if (!replaced && String(filePathArg) === path.join(lockPath, "owner")) {
				replaced = true;
				await fsp.rm(lockPath, { recursive: true, force: true });
				replacement = withFileLock({
					filePath,
					task: async () => {
						replacementActive = true;
						replacementStarted();
						await replacementReleased;
						replacementActive = false;
					},
				});
				await replacementEntered;
			}
			return result;
		},
	});

	try {
		const original = withFileLock({
			filePath,
			task: async () => {
				if (replacementActive) overlap = true;
			},
		});
		await replacementEntered;
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(overlap, false, "the stale reclaimer must not enter beside the replacement");
		releaseReplacement();
		if (!replacement) throw new Error("replacement lock did not start");
		await Promise.all([original, replacement]);
	} finally {
		Object.defineProperty(fsp, "readFile", {
			configurable: true,
			writable: true,
			value: originalReadFile,
		});
		await fsp.rm(tmp, { recursive: true, force: true });
	}

	assert.equal(replaced, true);
	assert.equal(overlap, false);
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
