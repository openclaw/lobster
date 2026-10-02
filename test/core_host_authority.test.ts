import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { decodeResumeToken, resumeToolRequest, runToolRequest } from "../src/core/index.js";
import { keyToPath } from "../src/state/store.js";

function pauseStateRead(filePath: string) {
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const readStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const originalReadFile = fsp.readFile;
	let paused = false;
	Object.defineProperty(fsp, "readFile", {
		configurable: true,
		writable: true,
		async value(
			filePathArg: Parameters<typeof fsp.readFile>[0],
			options?: Parameters<typeof fsp.readFile>[1],
		) {
			if (!paused && String(filePathArg) === filePath) {
				paused = true;
				started();
				await gate;
			}
			return originalReadFile(filePathArg, options);
		},
	});
	return {
		readStarted,
		release,
		restore() {
			Object.defineProperty(fsp, "readFile", {
				configurable: true,
				writable: true,
				value: originalReadFile,
			});
		},
	};
}

function pauseStateLock(lockPath: string) {
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const lockStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const originalMkdir = fsp.mkdir;
	let paused = false;
	Object.defineProperty(fsp, "mkdir", {
		configurable: true,
		writable: true,
		async value(
			pathArg: Parameters<typeof fsp.mkdir>[0],
			options?: Parameters<typeof fsp.mkdir>[1],
		) {
			if (!paused && String(pathArg) === lockPath) {
				paused = true;
				started();
				await gate;
			}
			return originalMkdir(pathArg, options);
		},
	});
	return {
		lockStarted,
		release,
		restore() {
			Object.defineProperty(fsp, "mkdir", {
				configurable: true,
				writable: true,
				value: originalMkdir,
			});
		},
	};
}

function pauseAtomicSync(filePath: string) {
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const syncStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const originalOpen = fsp.open;
	const tempPrefix = path.join(path.dirname(filePath), `.${path.basename(filePath)}.`);
	let paused = false;
	Object.defineProperty(fsp, "open", {
		configurable: true,
		writable: true,
		async value(
			filePathArg: Parameters<typeof fsp.open>[0],
			flags: Parameters<typeof fsp.open>[1],
			mode?: Parameters<typeof fsp.open>[2],
		) {
			const handle = await originalOpen(filePathArg, flags, mode);
			if (!paused && String(filePathArg).startsWith(tempPrefix)) {
				paused = true;
				const originalSync = handle.sync.bind(handle);
				Object.defineProperty(handle, "sync", {
					configurable: true,
					async value() {
						started();
						await gate;
						return originalSync();
					},
				});
			}
			return handle;
		},
	});
	return {
		syncStarted,
		release,
		restore() {
			Object.defineProperty(fsp, "open", {
				configurable: true,
				writable: true,
				value: originalOpen,
			});
		},
	};
}

function pauseApprovalIndexLink(stateDir: string) {
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const linkStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const originalLink = fsp.link;
	let paused = false;
	Object.defineProperty(fsp, "link", {
		configurable: true,
		writable: true,
		async value(
			existingPath: Parameters<typeof fsp.link>[0],
			newPath: Parameters<typeof fsp.link>[1],
		) {
			const result = await originalLink(existingPath, newPath);
			if (!paused && String(newPath).startsWith(path.join(stateDir, "approval_"))) {
				paused = true;
				started();
				await gate;
			}
			return result;
		},
	});
	return {
		linkStarted,
		release,
		restore() {
			Object.defineProperty(fsp, "link", {
				configurable: true,
				writable: true,
				value: originalLink,
			});
		},
	};
}

function pauseFileUnlink(filePath: string) {
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const unlinkStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const originalUnlink = fsp.unlink;
	let paused = false;
	Object.defineProperty(fsp, "unlink", {
		configurable: true,
		writable: true,
		async value(filePathArg: Parameters<typeof fsp.unlink>[0]) {
			const result = await originalUnlink(filePathArg);
			if (!paused && String(filePathArg) === filePath) {
				paused = true;
				started();
				await gate;
			}
			return result;
		},
	});
	return {
		unlinkStarted,
		started: unlinkStarted,
		release,
		restore() {
			Object.defineProperty(fsp, "unlink", {
				configurable: true,
				writable: true,
				value: originalUnlink,
			});
		},
	};
}

function pauseStateMarkerRename(statePath: string) {
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const renameStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const originalRename = fsp.rename;
	const tempPrefix = path.join(path.dirname(statePath), `.${path.basename(statePath)}.`);
	let paused = false;
	Object.defineProperty(fsp, "rename", {
		configurable: true,
		writable: true,
		async value(
			oldPath: Parameters<typeof fsp.rename>[0],
			newPath: Parameters<typeof fsp.rename>[1],
		) {
			const result = await originalRename(oldPath, newPath);
			if (!paused && String(oldPath).startsWith(tempPrefix) && String(newPath) === statePath) {
				paused = true;
				started();
				await gate;
			}
			return result;
		},
	});
	return {
		renameStarted,
		started: renameStarted,
		release,
		restore() {
			Object.defineProperty(fsp, "rename", {
				configurable: true,
				writable: true,
				value: originalRename,
			});
		},
	};
}

async function waitForGate(gate: Promise<void>) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			gate,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("authority test gate timed out")), 2_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function retireAfterDispatch() {
	let current = true;
	let checks = 0;
	return {
		assertInvocationCurrent() {
			checks++;
			if (!current) throw new Error("host invocation retired");
			if (checks === 1) queueMicrotask(() => (current = false));
		},
		get checks() {
			return checks;
		},
	};
}

function resumeStatePath(stateDir: string, token: string) {
	const stateKey = decodeResumeToken(token).stateKey;
	assert.ok(stateKey, "expected a persisted resume state");
	return keyToPath(stateDir, stateKey);
}

test("approved pipeline rechecks host authority after awaited resume-state preparation", async () => {
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-pipeline-"));
	const stateDir = path.join(tmp, "state");
	const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
	let gate: ReturnType<typeof pauseStateRead> | undefined;
	try {
		const first = await runToolRequest({
			pipeline: 'approve --prompt "Write?" | state.set committed',
			ctx: { cwd: tmp, env },
		});
		assert.equal(first.status, "needs_approval");
		const token = first.requiresApproval?.resumeToken;
		assert.ok(token);
		gate = pauseStateRead(resumeStatePath(stateDir, token));
		let current = true;
		let checks = 0;
		const pending = resumeToolRequest({
			token,
			approved: true,
			ctx: {
				cwd: tmp,
				env,
				assertInvocationCurrent: () => {
					checks++;
					if (!current) throw new Error("host invocation retired");
				},
			},
		});
		await gate.readStarted;
		current = false;
		gate.release();
		const resumed = await pending;
		assert.equal(resumed.ok, false);
		assert.match(resumed.error?.message ?? "", /host invocation retired/);
		assert.ok(checks >= 1);
		await assert.rejects(fsp.stat(path.join(stateDir, "committed.json")), { code: "ENOENT" });
	} finally {
		gate?.release();
		gate?.restore();
		await fsp.rm(tmp, { recursive: true, force: true });
	}
});

test("approved state.set rechecks host authority after its lock wait", async () => {
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-state-"));
	const stateDir = path.join(tmp, "state");
	const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
	let gate: ReturnType<typeof pauseStateLock> | undefined;
	try {
		const first = await runToolRequest({
			pipeline: 'approve --prompt "Write?" | state.set committed',
			ctx: { cwd: tmp, env },
		});
		assert.equal(first.status, "needs_approval");
		const token = first.requiresApproval?.resumeToken;
		assert.ok(token);
		const committedPath = path.join(stateDir, "committed.json");
		gate = pauseStateLock(`${committedPath}.lock`);
		let current = true;
		let checks = 0;
		const pending = resumeToolRequest({
			token,
			approved: true,
			ctx: {
				cwd: tmp,
				env,
				assertInvocationCurrent: () => {
					checks++;
					if (!current) throw new Error("host invocation retired");
				},
			},
		});
		await gate.lockStarted;
		current = false;
		gate.release();
		const resumed = await pending;
		assert.equal(resumed.ok, false);
		assert.match(resumed.error?.message ?? "", /host invocation retired/);
		assert.ok(checks >= 2);
		await assert.rejects(fsp.stat(committedPath), { code: "ENOENT" });
	} finally {
		gate?.release();
		gate?.restore();
		await fsp.rm(tmp, { recursive: true, force: true });
	}
});

test("approved state.set rechecks host authority before atomic publication", async () => {
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-publish-"));
	const stateDir = path.join(tmp, "state");
	const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
	let gate: ReturnType<typeof pauseAtomicSync> | undefined;
	try {
		const first = await runToolRequest({
			pipeline: 'approve --prompt "Write?" | state.set committed',
			ctx: { cwd: tmp, env },
		});
		assert.equal(first.status, "needs_approval");
		const token = first.requiresApproval?.resumeToken;
		assert.ok(token);
		const committedPath = path.join(stateDir, "committed.json");
		gate = pauseAtomicSync(committedPath);
		let current = true;
		const pending = resumeToolRequest({
			token,
			approved: true,
			ctx: {
				cwd: tmp,
				env,
				assertInvocationCurrent: () => {
					if (!current) throw new Error("host invocation retired");
				},
			},
		});
		await gate.syncStarted;
		current = false;
		gate.release();
		const resumed = await pending;
		assert.equal(resumed.ok, false);
		assert.match(resumed.error?.message ?? "", /host invocation retired/);
		await assert.rejects(fsp.stat(committedPath), { code: "ENOENT" });
		assert.equal(
			(await fsp.readdir(stateDir)).some((name) => name.startsWith(".committed.json.")),
			false,
		);
	} finally {
		gate?.release();
		gate?.restore();
		await fsp.rm(tmp, { recursive: true, force: true });
	}
});

test("approved exec rechecks host authority after draining input", async () => {
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-exec-"));
	const stateDir = path.join(tmp, "state");
	const effectPath = path.join(tmp, "committed.txt");
	const env = { ...process.env, LOBSTER_STATE_DIR: stateDir, LOBSTER_EFFECT_FILE: effectPath };
	try {
		const first = await runToolRequest({
			pipeline:
				"approve --prompt \"Run?\" | exec node -e \"require('node:fs').writeFileSync(process.env.LOBSTER_EFFECT_FILE, 'committed')\"",
			ctx: { cwd: tmp, env },
		});
		assert.equal(first.status, "needs_approval");
		const token = first.requiresApproval?.resumeToken;
		assert.ok(token);
		const authority = retireAfterDispatch();
		const resumed = await resumeToolRequest({
			token,
			approved: true,
			ctx: { cwd: tmp, env, assertInvocationCurrent: authority.assertInvocationCurrent },
		});
		assert.equal(resumed.ok, false);
		assert.match(resumed.error?.message ?? "", /host invocation retired/);
		assert.ok(authority.checks >= 2);
		await assert.rejects(fsp.stat(effectPath), { code: "ENOENT" });
	} finally {
		await fsp.rm(tmp, { recursive: true, force: true });
	}
});

test("approved openclaw.invoke rechecks host authority after draining input", async () => {
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-invoke-"));
	const stateDir = path.join(tmp, "state");
	const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return new Response(JSON.stringify({ ok: true, result: { sent: true } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	try {
		const first = await runToolRequest({
			pipeline:
				'approve --prompt "Invoke?" | openclaw.invoke --url http://127.0.0.1:1 --tool demo --action ping',
			ctx: { cwd: tmp, env },
		});
		assert.equal(first.status, "needs_approval");
		const token = first.requiresApproval?.resumeToken;
		assert.ok(token);
		const authority = retireAfterDispatch();
		const resumed = await resumeToolRequest({
			token,
			approved: true,
			ctx: { cwd: tmp, env, assertInvocationCurrent: authority.assertInvocationCurrent },
		});
		assert.equal(resumed.ok, false);
		assert.match(resumed.error?.message ?? "", /host invocation retired/);
		assert.ok(authority.checks >= 2);
		assert.equal(calls, 0);
	} finally {
		globalThis.fetch = originalFetch;
		await fsp.rm(tmp, { recursive: true, force: true });
	}
});

test("approved llm.invoke rechecks host authority after draining input", async () => {
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-llm-"));
	const stateDir = path.join(tmp, "state");
	const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
	let calls = 0;
	const llmAdapters = {
		"authority-test": {
			async invoke() {
				calls++;
				return { ok: true, result: { output: { text: "answered" } } };
			},
		},
	};
	try {
		const first = await runToolRequest({
			pipeline:
				'approve --prompt "Call?" | llm.invoke --provider authority-test --prompt test --disable-cache',
			ctx: { cwd: tmp, env, llmAdapters },
		});
		assert.equal(first.status, "needs_approval");
		const token = first.requiresApproval?.resumeToken;
		assert.ok(token);
		const authority = retireAfterDispatch();
		const resumed = await resumeToolRequest({
			token,
			approved: true,
			ctx: {
				cwd: tmp,
				env,
				llmAdapters,
				assertInvocationCurrent: authority.assertInvocationCurrent,
			},
		});
		assert.equal(resumed.ok, false);
		assert.match(resumed.error?.message ?? "", /host invocation retired/);
		assert.ok(authority.checks >= 2);
		assert.equal(calls, 0);
	} finally {
		await fsp.rm(tmp, { recursive: true, force: true });
	}
});

test("approved pipeline cannot publish a successor approval after host retirement", async () => {
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-successor-"));
	const env = { ...process.env, LOBSTER_STATE_DIR: tmp };
	try {
		const first = await runToolRequest({
			pipeline: 'approve --prompt "First?" | approve --prompt "Second?"',
			ctx: { cwd: tmp, env },
		});
		assert.equal(first.status, "needs_approval");
		const token = first.requiresApproval?.resumeToken;
		assert.ok(token);
		const before = (await fsp.readdir(tmp)).sort();
		const authority = retireAfterDispatch();
		const resumed = await resumeToolRequest({
			token,
			approved: true,
			ctx: { cwd: tmp, env, assertInvocationCurrent: authority.assertInvocationCurrent },
		});
		assert.equal(resumed.ok, false);
		assert.match(resumed.error?.message ?? "", /host invocation retired/);
		assert.deepEqual((await fsp.readdir(tmp)).sort(), before);
	} finally {
		await fsp.rm(tmp, { recursive: true, force: true });
	}
});

test("approved pipeline removes a successor linked before host retirement", async () => {
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-index-"));
	const env = { ...process.env, LOBSTER_STATE_DIR: tmp };
	let gate: ReturnType<typeof pauseApprovalIndexLink> | undefined;
	try {
		const first = await runToolRequest({
			pipeline: 'approve --prompt "First?" | approve --prompt "Second?"',
			ctx: { cwd: tmp, env },
		});
		assert.equal(first.status, "needs_approval");
		const token = first.requiresApproval?.resumeToken;
		assert.ok(token);
		const before = (await fsp.readdir(tmp)).sort();
		gate = pauseApprovalIndexLink(tmp);
		let current = true;
		const pending = resumeToolRequest({
			token,
			approved: true,
			ctx: {
				cwd: tmp,
				env,
				assertInvocationCurrent: () => {
					if (!current) throw new Error("host invocation retired");
				},
			},
		});
		await gate.linkStarted;
		current = false;
		gate.release();
		const resumed = await pending;
		assert.equal(resumed.ok, false);
		assert.match(resumed.error?.message ?? "", /host invocation retired/);
		assert.deepEqual((await fsp.readdir(tmp)).sort(), before);
	} finally {
		gate?.release();
		gate?.restore();
		await fsp.rm(tmp, { recursive: true, force: true });
	}
});

test("approved pipeline restores the predecessor after retirement during old-index cleanup", async () => {
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-old-index-"));
	const env = { ...process.env, LOBSTER_STATE_DIR: tmp };
	let gate: ReturnType<typeof pauseFileUnlink> | undefined;
	try {
		const first = await runToolRequest({
			pipeline: 'approve --prompt "First?" | approve --prompt "Second?"',
			ctx: { cwd: tmp, env },
		});
		assert.equal(first.status, "needs_approval");
		const token = first.requiresApproval?.resumeToken;
		const approvalId = first.requiresApproval?.approvalId;
		assert.ok(token);
		assert.ok(approvalId);
		const before = (await fsp.readdir(tmp)).sort();
		gate = pauseFileUnlink(path.join(tmp, `approval_${approvalId}.json`));
		let current = true;
		const pending = resumeToolRequest({
			token,
			approved: true,
			ctx: {
				cwd: tmp,
				env,
				assertInvocationCurrent: () => {
					if (!current) throw new Error("host invocation retired");
				},
			},
		});
		await waitForGate(gate.unlinkStarted);
		current = false;
		gate.release();
		const resumed = await pending;
		assert.equal(resumed.ok, false);
		assert.match(resumed.error?.message ?? "", /host invocation retired/);
		assert.deepEqual((await fsp.readdir(tmp)).sort(), before);
		const retried = await resumeToolRequest({
			approvalId,
			approved: true,
			ctx: { cwd: tmp, env },
		});
		assert.equal(retried.status, "needs_approval");
		assert.equal(retried.requiresApproval?.prompt, "Second?");
	} finally {
		gate?.release();
		gate?.restore();
		await fsp.rm(tmp, { recursive: true, force: true });
	}
});

test("approved pipeline restores the predecessor when a successor input is retired", async () => {
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-input-"));
	const env = { ...process.env, LOBSTER_STATE_DIR: tmp };
	let gate: ReturnType<typeof pauseFileUnlink> | undefined;
	try {
		const first = await runToolRequest({
			pipeline: 'approve --prompt "First?" | ask --prompt "Name?"',
			ctx: { cwd: tmp, env },
		});
		assert.equal(first.status, "needs_approval");
		const token = first.requiresApproval?.resumeToken;
		const approvalId = first.requiresApproval?.approvalId;
		assert.ok(token);
		assert.ok(approvalId);
		const before = (await fsp.readdir(tmp)).sort();
		gate = pauseFileUnlink(path.join(tmp, `approval_${approvalId}.json`));
		let current = true;
		const pending = resumeToolRequest({
			token,
			approved: true,
			ctx: {
				cwd: tmp,
				env,
				assertInvocationCurrent: () => {
					if (!current) throw new Error("host invocation retired");
				},
			},
		});
		await waitForGate(gate.unlinkStarted);
		current = false;
		gate.release();
		const resumed = await pending;
		assert.equal(resumed.ok, false);
		assert.match(resumed.error?.message ?? "", /host invocation retired/);
		assert.deepEqual((await fsp.readdir(tmp)).sort(), before);
		const retried = await resumeToolRequest({
			approvalId,
			approved: true,
			ctx: { cwd: tmp, env },
		});
		assert.equal(retried.status, "needs_input");
		assert.equal(retried.requiresInput?.prompt, "Name?");
	} finally {
		gate?.release();
		gate?.restore();
		await fsp.rm(tmp, { recursive: true, force: true });
	}
});

test("approved workflow cannot publish a successor approval after host retirement", async () => {
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-workflow-gate-"));
	const stateDir = path.join(tmp, "state");
	const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
	let gate: ReturnType<typeof pauseStateRead> | undefined;
	try {
		const filePath = path.join(tmp, "gates.lobster");
		await fsp.writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "first", approval: "First?" },
					{ id: "second", approval: "Second?" },
				],
			}),
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: tmp, env } });
		assert.equal(first.status, "needs_approval");
		const token = first.requiresApproval?.resumeToken;
		assert.ok(token);
		const before = (await fsp.readdir(stateDir)).sort();
		gate = pauseStateRead(resumeStatePath(stateDir, token));
		let current = true;
		let checks = 0;
		const pending = resumeToolRequest({
			token,
			approved: true,
			ctx: {
				cwd: tmp,
				env,
				assertInvocationCurrent: () => {
					checks++;
					if (!current) throw new Error("host invocation retired");
				},
			},
		});
		await gate.readStarted;
		current = false;
		gate.release();
		const resumed = await pending;
		assert.equal(resumed.ok, false);
		assert.match(resumed.error?.message ?? "", /host invocation retired/);
		assert.ok(checks >= 1);
		assert.deepEqual((await fsp.readdir(stateDir)).sort(), before);
	} finally {
		gate?.release();
		gate?.restore();
		await fsp.rm(tmp, { recursive: true, force: true });
	}
});

test("approved workflow removes a successor linked before host retirement", async () => {
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-workflow-link-"));
	const stateDir = path.join(tmp, "state");
	const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
	let gate: ReturnType<typeof pauseApprovalIndexLink> | undefined;
	try {
		const filePath = path.join(tmp, "gates.lobster");
		await fsp.writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "first", approval: "First?" },
					{ id: "second", approval: "Second?" },
				],
			}),
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: tmp, env } });
		assert.equal(first.status, "needs_approval");
		const token = first.requiresApproval?.resumeToken;
		const approvalId = first.requiresApproval?.approvalId;
		assert.ok(token);
		assert.ok(approvalId);
		const before = (await fsp.readdir(stateDir)).sort();
		gate = pauseApprovalIndexLink(stateDir);
		let current = true;
		const pending = resumeToolRequest({
			token,
			approved: true,
			ctx: {
				cwd: tmp,
				env,
				assertInvocationCurrent: () => {
					if (!current) throw new Error("host invocation retired");
				},
			},
		});
		await waitForGate(gate.linkStarted);
		current = false;
		gate.release();
		const resumed = await pending;
		assert.equal(resumed.ok, false);
		assert.match(resumed.error?.message ?? "", /host invocation retired/);
		assert.deepEqual((await fsp.readdir(stateDir)).sort(), before);
		const cancelled = await resumeToolRequest({
			approvalId,
			cancel: true,
			ctx: { cwd: tmp, env },
		});
		assert.equal(cancelled.status, "cancelled");
	} finally {
		gate?.release();
		gate?.restore();
		await fsp.rm(tmp, { recursive: true, force: true });
	}
});

test("approved workflow restores the predecessor after retirement during old-index cleanup", async () => {
	const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-workflow-index-"));
	const stateDir = path.join(tmp, "state");
	const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
	let gate: ReturnType<typeof pauseFileUnlink> | undefined;
	try {
		const filePath = path.join(tmp, "gates.lobster");
		await fsp.writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "first", approval: "First?" },
					{ id: "second", approval: "Second?" },
				],
			}),
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: tmp, env } });
		assert.equal(first.status, "needs_approval");
		const token = first.requiresApproval?.resumeToken;
		const approvalId = first.requiresApproval?.approvalId;
		assert.ok(token);
		assert.ok(approvalId);
		const before = (await fsp.readdir(stateDir)).sort();
		gate = pauseFileUnlink(path.join(stateDir, `approval_${approvalId}.json`));
		let current = true;
		const pending = resumeToolRequest({
			token,
			approved: true,
			ctx: {
				cwd: tmp,
				env,
				assertInvocationCurrent: () => {
					if (!current) throw new Error("host invocation retired");
				},
			},
		});
		await waitForGate(gate.unlinkStarted);
		current = false;
		gate.release();
		const resumed = await pending;
		assert.equal(resumed.ok, false);
		assert.match(resumed.error?.message ?? "", /host invocation retired/);
		assert.deepEqual((await fsp.readdir(stateDir)).sort(), before);
		const retried = await resumeToolRequest({
			approvalId,
			approved: true,
			ctx: { cwd: tmp, env },
		});
		assert.equal(retried.status, "needs_approval");
		assert.equal(retried.requiresApproval?.prompt, "Second?");
	} finally {
		gate?.release();
		gate?.restore();
		await fsp.rm(tmp, { recursive: true, force: true });
	}
});

for (const kind of ["pipeline", "workflow"] as const) {
	test(`approved ${kind} restores a pre-dispatch claim when host authority retires`, async () => {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-claim-"));
		const stateDir = path.join(tmp, "state");
		const effectPath = path.join(tmp, "committed.txt");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir, LOBSTER_EFFECT_FILE: effectPath };
		let gate: ReturnType<typeof pauseStateMarkerRename> | undefined;
		try {
			const filePath = path.join(tmp, "workflow.lobster");
			if (kind === "workflow") {
				await fsp.writeFile(
					filePath,
					JSON.stringify({
						steps: [
							{ id: "gate", approval: "Write?" },
							{
								id: "write",
								run: `"${process.execPath}" -e "require('node:fs').writeFileSync(process.env.LOBSTER_EFFECT_FILE, 'committed')"`,
							},
						],
					}),
				);
			}
			const first =
				kind === "pipeline"
					? await runToolRequest({
							pipeline:
								"approve --prompt \"Write?\" | exec node -e \"require('node:fs').writeFileSync(process.env.LOBSTER_EFFECT_FILE, 'committed')\"",
							ctx: { cwd: tmp, env },
						})
					: await runToolRequest({ filePath, ctx: { cwd: tmp, env } });
			assert.equal(first.status, "needs_approval");
			const token = first.requiresApproval?.resumeToken;
			const approvalId = first.requiresApproval?.approvalId;
			assert.ok(token);
			assert.ok(approvalId);
			const statePath = resumeStatePath(stateDir, token);
			const before = await fsp.readFile(statePath, "utf8");
			gate = pauseStateMarkerRename(statePath);
			let current = true;
			const pending = resumeToolRequest({
				token,
				approved: true,
				ctx: {
					cwd: tmp,
					env,
					assertInvocationCurrent: () => {
						if (!current) throw new Error("host invocation retired");
					},
				},
			});
			await waitForGate(gate.renameStarted);
			current = false;
			gate.release();
			const resumed = await pending;
			assert.equal(resumed.ok, false);
			assert.match(resumed.error?.message ?? "", /host invocation retired/);
			await assert.rejects(fsp.stat(effectPath), { code: "ENOENT" });
			assert.equal(await fsp.readFile(statePath, "utf8"), before);
			const cancelled = await resumeToolRequest({
				approvalId,
				cancel: true,
				ctx: { cwd: tmp, env },
			});
			assert.equal(cancelled.status, "cancelled");
		} finally {
			gate?.release();
			gate?.restore();
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	});
}

for (const kind of ["pipeline", "workflow"] as const) {
	for (const phase of ["marker", "delete"] as const) {
		test(`approved terminal ${kind} preserves its checkpoint after retirement during ${phase}`, async () => {
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-terminal-"));
			const stateDir = path.join(tmp, "state");
			const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
			let gate:
				| ReturnType<typeof pauseStateMarkerRename>
				| ReturnType<typeof pauseFileUnlink>
				| undefined;
			try {
				const filePath = path.join(tmp, "workflow.lobster");
				if (kind === "workflow") {
					await fsp.writeFile(
						filePath,
						JSON.stringify({ steps: [{ id: "finish", approval: "Finish?" }] }),
					);
				}
				const first =
					kind === "pipeline"
						? await runToolRequest({
								pipeline: 'approve --prompt "Finish?"',
								ctx: { cwd: tmp, env },
							})
						: await runToolRequest({ filePath, ctx: { cwd: tmp, env } });
				assert.equal(first.status, "needs_approval");
				const token = first.requiresApproval?.resumeToken;
				const approvalId = first.requiresApproval?.approvalId;
				assert.ok(token);
				assert.ok(approvalId);
				const statePath = resumeStatePath(stateDir, token);
				const before = await fsp.readFile(statePath, "utf8");
				gate = phase === "marker" ? pauseStateMarkerRename(statePath) : pauseFileUnlink(statePath);
				let current = true;
				const pending = resumeToolRequest({
					token,
					approved: true,
					ctx: {
						cwd: tmp,
						env,
						assertInvocationCurrent: () => {
							if (!current) throw new Error("host invocation retired");
						},
					},
				});
				await waitForGate(gate.started);
				current = false;
				gate.release();
				const resumed = await pending;
				assert.equal(resumed.ok, false);
				assert.match(resumed.error?.message ?? "", /host invocation retired/);
				assert.equal(await fsp.readFile(statePath, "utf8"), before);
				const cancelled = await resumeToolRequest({
					approvalId,
					cancel: true,
					ctx: { cwd: tmp, env },
				});
				assert.equal(cancelled.status, "cancelled");
			} finally {
				gate?.release();
				gate?.restore();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		});
	}
}

for (const kind of ["pipeline", "workflow"] as const) {
	test(`approved ${kind} does not restore a predecessor after unsafe dispatch`, async () => {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-effect-"));
		const stateDir = path.join(tmp, "state");
		const effectPath = path.join(tmp, "committed.txt");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir, LOBSTER_EFFECT_FILE: effectPath };
		let gate: ReturnType<typeof pauseFileUnlink> | undefined;
		try {
			const command = `"${process.execPath}" -e "require('node:fs').writeFileSync(process.env.LOBSTER_EFFECT_FILE, 'committed')"`;
			const filePath = path.join(tmp, "workflow.lobster");
			if (kind === "workflow") {
				await fsp.writeFile(
					filePath,
					JSON.stringify({
						steps: [
							{ id: "first", approval: "First?" },
							{ id: "write", run: command, approval: "Second?" },
						],
					}),
				);
			}
			const first =
				kind === "pipeline"
					? await runToolRequest({
							pipeline: `approve --prompt "First?" | exec ${command} | approve --prompt "Second?"`,
							ctx: { cwd: tmp, env },
						})
					: await runToolRequest({ filePath, ctx: { cwd: tmp, env } });
			assert.equal(first.status, "needs_approval");
			const token = first.requiresApproval?.resumeToken;
			const approvalId = first.requiresApproval?.approvalId;
			assert.ok(token);
			assert.ok(approvalId);
			gate = pauseFileUnlink(path.join(stateDir, `approval_${approvalId}.json`));
			let current = true;
			const pending = resumeToolRequest({
				token,
				approved: true,
				ctx: {
					cwd: tmp,
					env,
					assertInvocationCurrent: () => {
						if (!current) throw new Error("host invocation retired");
					},
				},
			});
			await waitForGate(gate.unlinkStarted);
			current = false;
			gate.release();
			const resumed = await pending;
			assert.equal(resumed.ok, false);
			assert.match(resumed.error?.message ?? "", /host invocation retired/);
			assert.equal(await fsp.readFile(effectPath, "utf8"), "committed");
			const files = await fsp.readdir(stateDir);
			assert.equal(
				files.some((name) => name.startsWith("approval_")),
				false,
			);
			assert.equal(
				files.filter((name) => /^(pipeline|workflow)_resume_/.test(name)).length,
				kind === "pipeline" ? 1 : 0,
			);
			const replay = await resumeToolRequest({ token, approved: true, ctx: { cwd: tmp, env } });
			assert.equal(replay.ok, false);
			assert.equal(await fsp.readFile(effectPath, "utf8"), "committed");
		} finally {
			gate?.release();
			gate?.restore();
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	});
}

for (const shellKind of ["direct", "for_each", "parallel", "retry_continue"] as const) {
	test(`approved ${shellKind} workflow shell rechecks host authority after state read`, async () => {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-host-authority-workflow-"));
		const stateDir = path.join(tmp, "state");
		const effectPath = path.join(tmp, "committed.txt");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir, LOBSTER_EFFECT_FILE: effectPath };
		let gate: ReturnType<typeof pauseStateRead> | undefined;
		try {
			const command = `"${process.execPath}" -e "require('node:fs').writeFileSync(process.env.LOBSTER_EFFECT_FILE, 'committed')"`;
			if (shellKind === "for_each") {
				await fsp.mkdir(stateDir, { recursive: true });
				await fsp.writeFile(path.join(stateDir, "items.json"), '["item"]');
			}
			const filePath = path.join(tmp, "workflow.lobster");
			await fsp.writeFile(
				filePath,
				JSON.stringify({
					steps: [
						...(shellKind === "for_each" ? [{ id: "items", pipeline: "state.get items" }] : []),
						{ id: "gate", approval: "Write?" },
						shellKind === "direct" || shellKind === "retry_continue"
							? {
									id: "write",
									run: command,
									...(shellKind === "retry_continue"
										? { retry: { max: 2, delay_ms: 0 }, on_error: "continue" }
										: {}),
								}
							: shellKind === "for_each"
								? {
										id: "write",
										for_each: "$items.json",
										steps: [{ id: "item_write", run: command }],
									}
								: { id: "write", parallel: { branches: [{ id: "branch_write", run: command }] } },
					],
				}),
			);
			const first = await runToolRequest({ filePath, ctx: { cwd: tmp, env } });
			assert.equal(first.status, "needs_approval");
			const token = first.requiresApproval?.resumeToken;
			assert.ok(token);
			gate = pauseStateRead(resumeStatePath(stateDir, token));
			let current = true;
			let checks = 0;
			const pending = resumeToolRequest({
				token,
				approved: true,
				ctx: {
					cwd: tmp,
					env,
					assertInvocationCurrent: () => {
						checks++;
						if (!current) throw new Error("host invocation retired");
					},
				},
			});
			await gate.readStarted;
			current = false;
			gate.release();
			const resumed = await pending;
			assert.equal(resumed.ok, false);
			assert.match(resumed.error?.message ?? "", /host invocation retired/);
			assert.ok(checks >= 1);
			await assert.rejects(fsp.stat(effectPath), { code: "ENOENT" });
		} finally {
			gate?.release();
			gate?.restore();
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	});
}
