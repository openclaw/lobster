import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp, readFileSync } from "node:fs";
import {
	access,
	chmod,
	copyFile,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { runAbortableProcess } from "../src/abortable_process.js";
import { resumeToolRequest, runToolRequest } from "../src/core/tool_runtime.js";
import { decodeResumeToken } from "../src/resume.js";
import { runPipeline } from "../src/runtime.js";
import { keyToPath } from "../src/state/store.js";
import { encodeToken } from "../src/token.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function streamOf(items: unknown[]) {
	return (async function* () {
		for (const item of items) yield item;
	})();
}

test("runAbortableProcess preserves UTF-8 characters split across pipe chunks", async () => {
	const result = await runAbortableProcess({
		command: process.execPath,
		argv: [
			"-e",
			"process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 20)",
		],
		env: process.env,
		notFoundMessage: "node missing",
	});
	assert.equal(result.stdout, "€");
});

test("runAbortableProcess does not spawn when its signal is already aborted", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-pre-aborted-process-"));
	try {
		const marker = join(dir, "spawned");
		const controller = new AbortController();
		controller.abort(new Error("abort before spawn"));

		await assert.rejects(
			runAbortableProcess({
				command: process.execPath,
				argv: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
				env: process.env,
				signal: controller.signal,
				notFoundMessage: "node missing",
			}),
			/abort before spawn/,
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(await fileExists(marker), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

async function fileExists(path: string) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function listStateFiles(stateDir: string) {
	try {
		return await readdir(stateDir);
	} catch (err: any) {
		if (err?.code === "ENOENT") return [];
		throw err;
	}
}

async function waitForFile(path: string, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await fileExists(path)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function waitForChildProcess(parentPid: number, timeoutMs = 5000) {
	const childrenPath = `/proc/${parentPid}/task/${parentPid}/children`;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const children = (await readFile(childrenPath, "utf8"))
				.trim()
				.split(/\s+/)
				.map(Number)
				.filter(Number.isInteger);
			if (children.length === 1) return children[0];
		} catch {
			// The pseudo-terminal process may not have spawned the CLI yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for a child process of ${parentPid}`);
}

function startLobsterCli({
	args,
	cwd,
	env,
	interactive = false,
}: {
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	interactive?: boolean;
}) {
	const repoRoot = join(__dirname, "..", "..");
	const entry = join(repoRoot, "bin", "lobster.js");
	const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const command = `exec ${[process.execPath, entry, ...args].map(shellQuote).join(" ")}`;
	const child = spawn(
		interactive ? "script" : process.execPath,
		interactive ? ["-qefc", command, "/dev/null"] : [entry, ...args],
		{
			cwd,
			env,
			stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});
	const result = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
		stdout: string;
		stderr: string;
	}>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
	return { child, result, getStdout: () => stdout };
}

async function waitForCliOutput(getStdout: () => string, pattern: RegExp, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pattern.test(getStdout())) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for CLI output matching ${pattern}`);
}

async function observeSettlement<T>(promise: Promise<T>, timeoutMs: number) {
	return Promise.race([
		promise.then((value) => ({ settled: true as const, value, settledAt: Date.now() })),
		new Promise<{ settled: false }>((resolve) =>
			setTimeout(() => resolve({ settled: false }), timeoutMs),
		),
	]);
}

function processIsRunning(pid: number) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
		if (state === "Z") return false;
	} catch {
		// /proc is unavailable on Windows and the process may already be reaped.
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function withCommands(
	defaultRegistry: ReturnType<typeof createDefaultRegistry>,
	...commands: any[]
) {
	return {
		get(name: string) {
			return commands.find((command) => command.name === name) ?? defaultRegistry.get(name);
		},
	};
}

function assertCancellationEnvelope(envelope: Awaited<ReturnType<typeof runToolRequest>>) {
	assert.equal(envelope.ok, false);
	assert.equal(envelope.status, undefined);
	assert.equal(envelope.error?.type, "runtime_error");
	assert.match(envelope.error?.message ?? "", /abort/i);
}

function createCustomAbortSideEffect() {
	let invocations = 0;
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	return {
		command: {
			name: "test.custom-abort-side-effect",
			async run({ input, ctx }: { input: AsyncIterable<unknown>; ctx: { signal?: AbortSignal } }) {
				const items = [];
				for await (const item of input) items.push(item);
				invocations += 1;
				if (invocations === 1) {
					assert.ok(ctx.signal);
					markStarted();
					await new Promise<void>((resolve) =>
						ctx.signal!.addEventListener("abort", () => resolve(), { once: true }),
					);
					ctx.signal.throwIfAborted();
				}
				return { output: streamOf(items) };
			},
		},
		started,
		get invocations() {
			return invocations;
		},
	};
}

function createCountingSideEffect(name: string) {
	let invocations = 0;
	return {
		command: {
			name,
			async run({ input }: { input: AsyncIterable<unknown> }) {
				invocations += 1;
				const items = [];
				for await (const item of input) items.push(item);
				return { output: streamOf(items.length > 0 ? items : [{ ok: true }]) };
			},
		},
		get invocations() {
			return invocations;
		},
	};
}

test("pre-aborted tool pipeline does not start its first stage", async () => {
	const controller = new AbortController();
	controller.abort();
	let sideEffectStarted = false;
	const sideEffect = {
		name: "test.side-effect",
		async run() {
			sideEffectStarted = true;
			return { output: streamOf([{ ok: true }]) };
		},
	};

	const envelope = await runToolRequest({
		pipeline: "test.side-effect",
		ctx: {
			registry: withCommands(createDefaultRegistry(), sideEffect),
			signal: controller.signal,
		},
	});

	assertCancellationEnvelope(envelope);
	assert.equal(sideEffectStarted, false, "pre-aborted requests must not start side effects");
});

test("pre-aborted workflow pipeline does not start its first stage", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-pre-abort-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [{ id: "side-effect", pipeline: "test.side-effect" }],
			}),
			"utf8",
		);
		let sideEffectStarted = false;
		const sideEffect = {
			name: "test.side-effect",
			async run() {
				sideEffectStarted = true;
				return { output: streamOf([{ ok: true }]) };
			},
		};
		const controller = new AbortController();
		controller.abort();

		const envelope = await runToolRequest({
			filePath,
			ctx: {
				cwd: dir,
				registry: withCommands(createDefaultRegistry(), sideEffect),
				signal: controller.signal,
			},
		});

		assertCancellationEnvelope(envelope);
		assert.equal(sideEffectStarted, false, "pre-aborted workflows must not start side effects");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pre-aborted workflow shell does not start its process", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-shell-pre-abort-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const started = join(dir, "shell-started");
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [{ id: "shell", run: `printf started > ${started}` }],
			}),
			"utf8",
		);
		const controller = new AbortController();
		controller.abort(new Error("pre-aborted workflow shell"));

		const envelope = await runToolRequest({
			filePath,
			ctx: { cwd: dir, signal: controller.signal },
		});

		assertCancellationEnvelope(envelope);
		assert.equal(envelope.error?.message, "pre-aborted workflow shell");
		assert.equal(await fileExists(started), false, "pre-aborted workflow must not spawn a shell");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pipeline input cancellation after state publication does not return a live resume token", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-pipeline-gate-cancel-"));
	try {
		const stateDir = join(dir, "state");
		const controller = new AbortController();
		const signal = controller.signal;
		const throwIfAborted = signal.throwIfAborted.bind(signal);
		let signalChecks = 0;
		Object.defineProperty(signal, "throwIfAborted", {
			value() {
				signalChecks += 1;
				if (signalChecks === 6) {
					controller.abort(new Error("abort after pipeline input state publication"));
				}
				throwIfAborted();
			},
		});

		const envelope = await runToolRequest({
			pipeline: `ask --emit --prompt Continue? --schema '${JSON.stringify({ type: "object" })}'`,
			ctx: { env: { ...process.env, LOBSTER_STATE_DIR: stateDir }, signal },
		});

		assertCancellationEnvelope(envelope);
		assert.equal(signalChecks, 6);
		assert.deepEqual(await listStateFiles(stateDir), [], "cancelled input state must be removed");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pipeline approval cancellation after index publication removes the state and index", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-pipeline-approval-cancel-"));
	try {
		const stateDir = join(dir, "state");
		const controller = new AbortController();
		const signal = controller.signal;
		const throwIfAborted = signal.throwIfAborted.bind(signal);
		let signalChecks = 0;
		Object.defineProperty(signal, "throwIfAborted", {
			value() {
				signalChecks += 1;
				if (signalChecks === 9) {
					controller.abort(new Error("abort after pipeline approval index publication"));
				}
				throwIfAborted();
			},
		});
		const source = {
			name: "test.gate-source",
			async run() {
				return { output: streamOf([{ value: 1 }]) };
			},
		};

		const envelope = await runToolRequest({
			pipeline: "test.gate-source | approve --prompt Continue?",
			ctx: {
				env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
				signal,
				registry: withCommands(createDefaultRegistry(), source),
			},
		});

		assertCancellationEnvelope(envelope);
		assert.equal(signalChecks, 9);
		assert.deepEqual(
			await listStateFiles(stateDir),
			[],
			"cancelled approval state must be removed",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow input cancellation after state publication does not return a live resume token", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-gate-cancel-"));
	try {
		const stateDir = join(dir, "state");
		const filePath = join(dir, "workflow.lobster");
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "answer", input: { prompt: "Continue?", responseSchema: { type: "object" } } },
				],
			}),
			"utf8",
		);
		const controller = new AbortController();
		const signal = controller.signal;
		const throwIfAborted = signal.throwIfAborted.bind(signal);
		let signalChecks = 0;
		Object.defineProperty(signal, "throwIfAborted", {
			value() {
				signalChecks += 1;
				if (signalChecks === 4) {
					controller.abort(new Error("abort after workflow input state publication"));
				}
				throwIfAborted();
			},
		});

		const envelope = await runToolRequest({
			filePath,
			ctx: { env: { ...process.env, LOBSTER_STATE_DIR: stateDir }, signal },
		});

		assertCancellationEnvelope(envelope);
		assert.equal(signalChecks, 4);
		assert.deepEqual(await listStateFiles(stateDir), [], "cancelled input state must be removed");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow approval cancellation after index publication removes the state and index", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-approval-cancel-"));
	try {
		const stateDir = join(dir, "state");
		const filePath = join(dir, "workflow.lobster");
		await writeFile(
			filePath,
			JSON.stringify({ steps: [{ id: "gate", approval: "Continue?" }] }),
			"utf8",
		);
		const controller = new AbortController();
		const signal = controller.signal;
		const throwIfAborted = signal.throwIfAborted.bind(signal);
		let signalChecks = 0;
		Object.defineProperty(signal, "throwIfAborted", {
			value() {
				signalChecks += 1;
				if (signalChecks === 5) {
					controller.abort(new Error("abort after workflow approval index publication"));
				}
				throwIfAborted();
			},
		});

		const envelope = await runToolRequest({
			filePath,
			ctx: { env: { ...process.env, LOBSTER_STATE_DIR: stateDir }, signal },
		});

		assertCancellationEnvelope(envelope);
		assert.equal(signalChecks, 5);
		assert.deepEqual(
			await listStateFiles(stateDir),
			[],
			"cancelled approval state must be removed",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pre-aborted pipeline approval resume remains retryable", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-pre-abort-approval-resume-"));
	try {
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		const sideEffect = createCountingSideEffect("test.pre-abort-approval-side-effect");
		const source = {
			name: "test.pre-abort-source",
			async run() {
				return { output: streamOf([{ value: 1 }]) };
			},
		};
		const registry = withCommands(createDefaultRegistry(), source, sideEffect.command);
		const first = await runToolRequest({
			pipeline:
				"test.pre-abort-source | approve --prompt Continue? | test.pre-abort-approval-side-effect",
			ctx: { registry, env },
		});
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);

		const controller = new AbortController();
		controller.abort(new Error("pre-aborted approval resume"));
		const aborted = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { registry, signal: controller.signal, env },
		});
		assertCancellationEnvelope(aborted);
		assert.equal(sideEffect.invocations, 0);

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { registry, env },
		});
		assert.equal(retried.ok, true);
		assert.deepEqual(retried.output, [{ value: 1 }]);
		assert.equal(sideEffect.invocations, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pre-aborted pipeline input resume remains retryable", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-pre-abort-input-resume-"));
	try {
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		const sideEffect = createCountingSideEffect("test.pre-abort-input-side-effect");
		const registry = withCommands(createDefaultRegistry(), sideEffect.command);
		const responseSchema = JSON.stringify({
			type: "object",
			properties: { value: { type: "number" } },
			required: ["value"],
		});
		const first = await runToolRequest({
			pipeline: `ask --emit --prompt Continue? --schema '${responseSchema}' | test.pre-abort-input-side-effect`,
			ctx: { registry, env },
		});
		assert.equal(first.status, "needs_input");
		assert.ok(first.requiresInput?.resumeToken);

		const controller = new AbortController();
		controller.abort(new Error("pre-aborted input resume"));
		const aborted = await resumeToolRequest({
			token: first.requiresInput.resumeToken,
			response: { value: 1 },
			ctx: { registry, signal: controller.signal, env },
		});
		assertCancellationEnvelope(aborted);
		assert.equal(sideEffect.invocations, 0);

		const retried = await resumeToolRequest({
			token: first.requiresInput.resumeToken,
			response: { value: 1 },
			ctx: { registry, env },
		});
		assert.equal(retried.ok, true);
		assert.deepEqual(retried.output, [{ value: 1 }]);
		assert.equal(sideEffect.invocations, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pipeline approval resume remains retryable when a resume-safe stage aborts before input", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-safe-input-setup-abort-"));
	try {
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		const controller = new AbortController();
		let abortBeforeInput = true;
		const safeInput = {
			name: "test.resume-safe-before-input",
			meta: { resumeSafeBeforeInput: true },
			async run({ ctx }: any) {
				if (abortBeforeInput) {
					abortBeforeInput = false;
					controller.abort(new Error("abort before resume-safe input"));
				}
				await ctx.requestInput({
					prompt: "Second?",
					responseSchema: { type: "object" },
				});
				return { output: [] };
			},
		};
		const registry = withCommands(createDefaultRegistry(), safeInput);
		const first = await runToolRequest({
			pipeline: "approve --prompt First? | test.resume-safe-before-input",
			ctx: { env, registry },
		});
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);

		const aborted = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { env, registry, signal: controller.signal },
		});
		assertCancellationEnvelope(aborted);

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { env, registry },
		});
		assert.equal(retried.status, "needs_input");
		assert.equal(retried.requiresInput?.prompt, "Second?");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("same-stage ask resume restores its token when cancellation wins before execution", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-same-stage-ask-cancel-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const sideEffect = createCountingSideEffect("test.same-stage-ask-side-effect");
		let activeController: AbortController | undefined;
		const inputGate = {
			name: "test.same-stage-ask-gate",
			meta: { resumeSafeBeforeInput: true, resumeSafeAfterInput: true },
			async run({ ctx }: any) {
				await ctx.requestInput({ prompt: "First?", responseSchema: { type: "object" } });
				activeController?.abort(new Error("abort after same-stage input delivery"));
				return { output: streamOf([]) };
			},
		};
		const registry = withCommands(createDefaultRegistry(), inputGate, sideEffect.command);
		const first = await runToolRequest({
			pipeline: "test.same-stage-ask-gate | test.same-stage-ask-side-effect",
			ctx: { env, registry },
		});
		assert.equal(first.status, "needs_input");
		assert.ok(first.requiresInput?.resumeToken);

		const controller = new AbortController();
		activeController = controller;
		const aborted = await resumeToolRequest({
			token: first.requiresInput.resumeToken,
			response: { decision: "approve" },
			ctx: { env, registry, signal: controller.signal },
		});
		activeController = undefined;
		assertCancellationEnvelope(aborted);
		assert.equal(sideEffect.invocations, 0);

		const retried = await resumeToolRequest({
			token: first.requiresInput.resumeToken,
			response: { decision: "approve" },
			ctx: { env, registry },
		});
		assert.equal(retried.ok, true);
		assert.equal(sideEffect.invocations, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("same-stage input resumes stop waiting on a held state lock", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-same-stage-input-lock-abort-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const workflowPath = join(dir, "workflow.lobster");
		await writeFile(
			workflowPath,
			JSON.stringify({ steps: [{ id: "review", pipeline: "ask --prompt Review?" }] }),
			"utf8",
		);

		for (const run of [
			() => runToolRequest({ pipeline: "ask --prompt Review?", ctx: { cwd: dir, env } }),
			() => runToolRequest({ filePath: workflowPath, ctx: { cwd: dir, env } }),
		]) {
			const first = await run();
			assert.equal(first.status, "needs_input");
			assert.ok(first.requiresInput?.resumeToken);
			const payload = decodeResumeToken(first.requiresInput.resumeToken);
			const lockPath = `${keyToPath(stateDir, payload.stateKey)}.lock`;
			await fsp.mkdir(lockPath);
			await fsp.writeFile(join(lockPath, "owner"), `${process.pid}::live-writer\n`, "utf8");

			const controller = new AbortController();
			const originalMkdir = fsp.mkdir;
			let signalLockAttempt: (() => void) | undefined;
			const lockAttempted = new Promise<void>((resolve) => {
				signalLockAttempt = resolve;
			});
			Object.defineProperty(fsp, "mkdir", {
				configurable: true,
				writable: true,
				async value(
					filePath: Parameters<typeof fsp.mkdir>[0],
					options?: Parameters<typeof fsp.mkdir>[1],
				) {
					if (String(filePath) === lockPath) signalLockAttempt?.();
					return originalMkdir(filePath, options);
				},
			});

			let resumed;
			try {
				const pending = resumeToolRequest({
					token: first.requiresInput.resumeToken,
					response: { decision: "approve" },
					ctx: { cwd: dir, env, signal: controller.signal },
				});
				await lockAttempted;
				controller.abort(
					new Error("same-stage input cleanup stopped while waiting for a state lock"),
				);
				resumed = await observeSettlement(pending, 1500);
			} finally {
				Object.defineProperty(fsp, "mkdir", {
					configurable: true,
					writable: true,
					value: originalMkdir,
				});
			}

			assert.equal(
				resumed.settled,
				true,
				"same-stage cleanup must not remain blocked on a state lock",
			);
			if (resumed.settled) {
				assert.equal(resumed.value.ok, false);
				assert.equal(resumed.value.error?.type, "runtime_error");
			}
			assert.equal(await fileExists(keyToPath(stateDir, payload.stateKey)), true);
			await rm(lockPath, { recursive: true, force: true });

			const retried = await resumeToolRequest({
				token: first.requiresInput.resumeToken,
				response: { decision: "approve" },
				ctx: { cwd: dir, env },
			});
			assert.equal(retried.status, "ok");
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow pipeline input resume restores its capability before execution starts", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-pipeline-safe-input-cancel-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const filePath = join(dir, "workflow.lobster");
		await writeFile(
			filePath,
			JSON.stringify({ steps: [{ id: "review", pipeline: "ask --prompt Review?" }] }),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });
		assert.equal(first.status, "needs_input");
		assert.ok(first.requiresInput?.resumeToken);
		const payload = decodeResumeToken(first.requiresInput.resumeToken);
		const statePath = keyToPath(stateDir, payload.stateKey);

		const controller = new AbortController();
		const originalUnlink = fsp.unlink;
		Object.defineProperty(fsp, "unlink", {
			configurable: true,
			writable: true,
			async value(filePath: Parameters<typeof fsp.unlink>[0]) {
				const result = await originalUnlink(filePath);
				if (String(filePath) === statePath && !controller.signal.aborted) {
					controller.abort(new Error("abort after safe workflow pipeline input cleanup"));
				}
				return result;
			},
		});
		let aborted;
		try {
			aborted = await resumeToolRequest({
				token: first.requiresInput.resumeToken,
				response: { decision: "approve" },
				ctx: { cwd: dir, env, signal: controller.signal },
			});
		} finally {
			Object.defineProperty(fsp, "unlink", {
				configurable: true,
				writable: true,
				value: originalUnlink,
			});
		}
		assertCancellationEnvelope(aborted!);
		assert.equal(await fileExists(statePath), true);

		const retried = await resumeToolRequest({
			token: first.requiresInput.resumeToken,
			response: { decision: "approve" },
			ctx: { cwd: dir, env },
		});
		assert.equal(retried.status, "ok");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pre-aborted workflow approval resume remains retryable", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-pre-abort-workflow-resume-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		const sideEffect = createCountingSideEffect("test.pre-abort-workflow-side-effect");
		const registry = withCommands(createDefaultRegistry(), sideEffect.command);
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "confirm", approval: "Continue?" },
					{
						id: "effect",
						pipeline: "test.pre-abort-workflow-side-effect",
						when: "$confirm.approved",
					},
				],
			}),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, registry, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);

		const controller = new AbortController();
		controller.abort(new Error("pre-aborted workflow resume"));
		const aborted = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, registry, signal: controller.signal, env },
		});
		assertCancellationEnvelope(aborted);
		assert.equal(sideEffect.invocations, 0);

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, registry, env },
		});
		assert.equal(retried.ok, true);
		assert.equal(sideEffect.invocations, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow approval resume remains retryable when cancellation occurs during setup", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-setup-abort-workflow-resume-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		const sideEffect = createCountingSideEffect("test.setup-abort-workflow-side-effect");
		const registry = withCommands(createDefaultRegistry(), sideEffect.command);
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "confirm", approval: "Continue?" },
					{
						id: "effect",
						pipeline: "test.setup-abort-workflow-side-effect",
						when: "$confirm.approved",
					},
				],
			}),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, registry, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);

		const controller = new AbortController();
		const signal = controller.signal;
		const throwIfAborted = signal.throwIfAborted.bind(signal);
		let signalChecks = 0;
		Object.defineProperty(signal, "throwIfAborted", {
			value() {
				signalChecks += 1;
				if (signalChecks === 1) {
					controller.abort(new Error("abort during workflow resume setup"));
				}
				throwIfAborted();
			},
		});
		const aborted = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, registry, signal, env },
		});
		assertCancellationEnvelope(aborted);
		assert.equal(sideEffect.invocations, 0);

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, registry, env },
		});
		assert.equal(retried.ok, true);
		assert.equal(sideEffect.invocations, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pre-aborted terminal workflow approval resume remains retryable", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-pre-abort-terminal-workflow-resume-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		await writeFile(
			filePath,
			JSON.stringify({ steps: [{ id: "confirm", approval: "Continue?" }] }),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);

		const controller = new AbortController();
		controller.abort(new Error("pre-aborted terminal workflow resume"));
		const aborted = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, signal: controller.signal, env },
		});
		assertCancellationEnvelope(aborted);

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(retried.ok, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow approval resume remains retryable when cancellation creates its next input gate", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-input-gate-abort-workflow-resume-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "confirm", approval: "Continue?" },
					{ id: "answer", input: { prompt: "Continue?", responseSchema: { type: "object" } } },
				],
			}),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);

		const controller = new AbortController();
		const signal = controller.signal;
		const throwIfAborted = signal.throwIfAborted.bind(signal);
		let signalChecks = 0;
		Object.defineProperty(signal, "throwIfAborted", {
			value() {
				signalChecks += 1;
				if (signalChecks === 3) {
					controller.abort(new Error("abort while creating next workflow input gate"));
				}
				throwIfAborted();
			},
		});
		const aborted = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, signal, env },
		});
		assertCancellationEnvelope(aborted);
		assert.equal(signalChecks, 3);

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(retried.status, "needs_input");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow approval resume remains retryable when child workflow setup is cancelled", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-child-setup-abort-workflow-resume-"));
	try {
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		const parentPath = join(dir, "parent.lobster");
		const childPath = join(dir, "child.lobster");
		await writeFile(
			parentPath,
			JSON.stringify({
				steps: [
					{ id: "confirm", approval: "Continue?" },
					{ id: "child", workflow: "child.lobster" },
				],
			}),
			"utf8",
		);
		await writeFile(
			childPath,
			JSON.stringify({ steps: [{ id: "child-step", run: "true" }] }),
			"utf8",
		);
		const first = await runToolRequest({ filePath: parentPath, ctx: { cwd: dir, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);

		const controller = new AbortController();
		const originalRealpath = fsp.realpath;
		let childSetupObserved = false;
		let childRealpathCalls = 0;
		Object.defineProperty(fsp, "realpath", {
			configurable: true,
			writable: true,
			async value(filePath: Parameters<typeof fsp.realpath>[0]) {
				const resolved = await originalRealpath(filePath);
				if (String(filePath) === childPath) childRealpathCalls += 1;
				if (childRealpathCalls === 2 && !controller.signal.aborted) {
					childSetupObserved = true;
					controller.abort(new Error("abort during child workflow setup"));
				}
				return resolved;
			},
		});
		let aborted;
		try {
			aborted = await resumeToolRequest({
				approvalId: first.requiresApproval.approvalId,
				approved: true,
				ctx: { cwd: dir, signal: controller.signal, env },
			});
		} finally {
			Object.defineProperty(fsp, "realpath", {
				configurable: true,
				writable: true,
				value: originalRealpath,
			});
		}
		assertCancellationEnvelope(aborted!);
		assert.equal(childSetupObserved, true);
		assert.equal(childRealpathCalls, 2);

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(retried.ok, true);
		assert.equal(retried.status, "ok");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("terminal pipeline approval resume restores its original approval ID when cleanup is cancelled", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-terminal-pipeline-cleanup-abort-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const first = await runToolRequest({
			pipeline: "approve --prompt First?",
			ctx: { env },
		});
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);
		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		const previousStatePath = keyToPath(stateDir, payload.stateKey);

		const controller = new AbortController();
		const originalUnlink = fsp.unlink;
		let previousStateDeleted = false;
		Object.defineProperty(fsp, "unlink", {
			configurable: true,
			writable: true,
			async value(filePath: Parameters<typeof fsp.unlink>[0]) {
				const result = await originalUnlink(filePath);
				if (String(filePath) === previousStatePath && !controller.signal.aborted) {
					previousStateDeleted = true;
					controller.abort(new Error("abort during terminal pipeline approval cleanup"));
				}
				return result;
			},
		});
		let aborted;
		try {
			aborted = await resumeToolRequest({
				approvalId: first.requiresApproval.approvalId,
				approved: true,
				ctx: { env, signal: controller.signal },
			});
		} finally {
			Object.defineProperty(fsp, "unlink", {
				configurable: true,
				writable: true,
				value: originalUnlink,
			});
		}
		assertCancellationEnvelope(aborted!);
		assert.equal(previousStateDeleted, true);

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { env },
		});
		assert.equal(retried.ok, true);
		assert.equal(retried.status, "ok");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pipeline approval resume restores its original capability after next-approval cleanup is cancelled", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-pipeline-approval-cleanup-abort-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const first = await runToolRequest({
			pipeline: "approve --prompt First? | approve --prompt Second?",
			ctx: { env },
		});
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);
		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		const previousStatePath = keyToPath(stateDir, payload.stateKey);

		const controller = new AbortController();
		const originalRename = fsp.rename;
		let previousStateClaimed = false;
		Object.defineProperty(fsp, "rename", {
			configurable: true,
			writable: true,
			async value(from: Parameters<typeof fsp.rename>[0], to: Parameters<typeof fsp.rename>[1]) {
				const result = await originalRename(from, to);
				if (String(to) === previousStatePath && !controller.signal.aborted) {
					previousStateClaimed = true;
					controller.abort(new Error("abort after previous pipeline approval state claim"));
				}
				return result;
			},
		});
		let aborted;
		try {
			aborted = await resumeToolRequest({
				approvalId: first.requiresApproval.approvalId,
				approved: true,
				ctx: { env, signal: controller.signal },
			});
		} finally {
			Object.defineProperty(fsp, "rename", {
				configurable: true,
				writable: true,
				value: originalRename,
			});
		}
		assertCancellationEnvelope(aborted!);
		assert.equal(previousStateClaimed, true);

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { env },
		});
		assert.equal(retried.status, "needs_approval");
		assert.equal(retried.requiresApproval?.prompt, "Second?");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pipeline approval resume restores its original capability after next-input cleanup is cancelled", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-pipeline-input-cleanup-abort-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const first = await runToolRequest({
			pipeline: `approve --prompt First? | ask --emit --prompt Second? --schema '${JSON.stringify({ type: "object" })}'`,
			ctx: { env },
		});
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);
		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		const previousStatePath = keyToPath(stateDir, payload.stateKey);

		const controller = new AbortController();
		const originalRename = fsp.rename;
		let previousStateClaimed = false;
		Object.defineProperty(fsp, "rename", {
			configurable: true,
			writable: true,
			async value(from: Parameters<typeof fsp.rename>[0], to: Parameters<typeof fsp.rename>[1]) {
				const result = await originalRename(from, to);
				if (String(to) === previousStatePath && !controller.signal.aborted) {
					previousStateClaimed = true;
					controller.abort(new Error("abort after previous pipeline input state claim"));
				}
				return result;
			},
		});
		let aborted;
		try {
			aborted = await resumeToolRequest({
				approvalId: first.requiresApproval.approvalId,
				approved: true,
				ctx: { env, signal: controller.signal },
			});
		} finally {
			Object.defineProperty(fsp, "rename", {
				configurable: true,
				writable: true,
				value: originalRename,
			});
		}
		assertCancellationEnvelope(aborted!);
		assert.equal(previousStateClaimed, true);

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { env },
		});
		assert.equal(retried.status, "needs_input");
		assert.equal(retried.requiresInput?.prompt, "Second?");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pipeline cancellation after side effects does not restore the consumed approval capability", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-pipeline-side-effect-gate-cancel-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		let sideEffects = 0;
		const sideEffectThenInput = {
			name: "test.side-effect-then-input",
			async run({ ctx }: any) {
				sideEffects += 1;
				try {
					await ctx.requestInput({
						prompt: "Second?",
						responseSchema: { type: "object" },
					});
					return { output: streamOf([]) };
				} catch (err) {
					controller.abort(new Error("abort after side-effecting pipeline state claim"));
					throw err;
				}
			},
		};
		const registry = withCommands(createDefaultRegistry(), sideEffectThenInput);
		const first = await runToolRequest({
			pipeline: "approve --prompt First? | test.side-effect-then-input",
			ctx: { env, registry },
		});
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);
		const controller = new AbortController();
		const aborted = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { env, registry, signal: controller.signal },
		});
		assertCancellationEnvelope(aborted!);
		assert.equal(sideEffects, 1);

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { env, registry },
		});
		assert.equal(retried.ok, false);
		assert.equal(retried.error?.type, "parse_error");
		assert.equal(sideEffects, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("same-stage resumed input consumes its capability before a custom command acts on it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-resumed-input-side-effect-cancel-"));
	try {
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		const controller = new AbortController();
		let sideEffects = 0;
		const sideEffectAfterInput = {
			name: "test.side-effect-after-input",
			meta: { resumeSafeBeforeInput: true },
			async run({ ctx }: any) {
				await ctx.requestInput({ prompt: "Continue?", responseSchema: { type: "object" } });
				sideEffects += 1;
				controller.abort(new Error("abort after resumed input side effect"));
				return { output: streamOf([]) };
			},
		};
		const registry = withCommands(createDefaultRegistry(), sideEffectAfterInput);
		const first = await runToolRequest({
			pipeline: "test.side-effect-after-input",
			ctx: { env, registry },
		});
		assert.equal(first.status, "needs_input");
		assert.ok(first.requiresInput?.resumeToken);

		const aborted = await resumeToolRequest({
			token: first.requiresInput.resumeToken,
			response: {},
			ctx: { env, registry, signal: controller.signal },
		});
		assertCancellationEnvelope(aborted);
		assert.equal(sideEffects, 1);

		const replay = await resumeToolRequest({
			token: first.requiresInput.resumeToken,
			response: {},
			ctx: { env, registry },
		});
		assert.equal(replay.ok, false);
		assert.notEqual(replay.status, "needs_input");
		assert.equal(sideEffects, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow approval resume restores its original capability after next-input cleanup is cancelled", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-input-gate-cleanup-abort-workflow-resume-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "confirm", approval: "Continue?" },
					{ id: "answer", input: { prompt: "Continue?", responseSchema: { type: "object" } } },
				],
			}),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);

		const controller = new AbortController();
		const signal = controller.signal;
		const throwIfAborted = signal.throwIfAborted.bind(signal);
		let signalChecks = 0;
		Object.defineProperty(signal, "throwIfAborted", {
			value() {
				signalChecks += 1;
				if (signalChecks === 5) {
					controller.abort(new Error("abort after next-input state replaced the approval state"));
				}
				throwIfAborted();
			},
		});
		const aborted = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, signal, env },
		});
		assertCancellationEnvelope(aborted);
		assert.equal(signalChecks, 5);

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(retried.status, "needs_input");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow gate replacement retires the superseded approval index", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-gate-index-retirement-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "confirm", approval: "Continue?" },
					{ id: "answer", input: { prompt: "Second?", responseSchema: { type: "object" } } },
				],
			}),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		const oldIndexPath = join(stateDir, `approval_${first.requiresApproval.approvalId}.json`);
		assert.equal(await fileExists(oldIndexPath), true);

		const resumed = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(resumed.status, "needs_input");
		assert.equal(await fileExists(oldIndexPath), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow approval resume restores its original capability after next-approval cleanup is cancelled", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-approval-gate-cleanup-abort-workflow-resume-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "first", approval: "Continue?" },
					{ id: "second", approval: "Confirm again?" },
				],
			}),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);

		const controller = new AbortController();
		const signal = controller.signal;
		const throwIfAborted = signal.throwIfAborted.bind(signal);
		let signalChecks = 0;
		Object.defineProperty(signal, "throwIfAborted", {
			value() {
				signalChecks += 1;
				if (signalChecks === 6) {
					controller.abort(
						new Error("abort after next-approval state replaced the approval state"),
					);
				}
				throwIfAborted();
			},
		});
		const aborted = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, signal, env },
		});
		assertCancellationEnvelope(aborted);
		assert.equal(signalChecks, 6);

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(retried.status, "needs_approval");
		assert.equal(retried.requiresApproval?.prompt, "Confirm again?");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("terminal workflow approval resume restores its original capability when cleanup is cancelled", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-terminal-cleanup-abort-workflow-resume-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		await writeFile(
			filePath,
			JSON.stringify({ steps: [{ id: "confirm", approval: "Continue?" }] }),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);

		const controller = new AbortController();
		const signal = controller.signal;
		const throwIfAborted = signal.throwIfAborted.bind(signal);
		let signalChecks = 0;
		Object.defineProperty(signal, "throwIfAborted", {
			value() {
				signalChecks += 1;
				if (signalChecks === 2) {
					controller.abort(new Error("abort during terminal workflow resume cleanup"));
				}
				throwIfAborted();
			},
		});
		const aborted = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, signal, env },
		});
		assertCancellationEnvelope(aborted);
		assert.equal(signalChecks, 2);

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(retried.ok, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("cancellation stops terminal lazy output before reading its next item", async () => {
	const controller = new AbortController();
	let outputDrained = false;
	const terminal = {
		name: "test.terminal-output",
		async run() {
			return {
				output: (async function* () {
					yield { before: "abort" };
					controller.abort();
					yield { after: "abort" };
					outputDrained = true;
				})(),
			};
		},
	};

	const envelope = await runToolRequest({
		pipeline: "test.terminal-output",
		ctx: {
			registry: withCommands(createDefaultRegistry(), terminal),
			signal: controller.signal,
		},
	});

	assertCancellationEnvelope(envelope);
	assert.equal(outputDrained, false, "terminal cancellation must not read another output item");
});

test("cancellation observed before terminal output does not start its iterator", async () => {
	const controller = new AbortController();
	let outputDrained = false;
	const terminal = {
		name: "test.pre-drain-abort-output",
		async run() {
			controller.abort(new Error("abort before terminal drain"));
			return {
				halt: true,
				output: (async function* () {
					yield { cleanup: true };
					outputDrained = true;
				})(),
			};
		},
	};

	const envelope = await runToolRequest({
		pipeline: "test.pre-drain-abort-output",
		ctx: {
			registry: withCommands(createDefaultRegistry(), terminal),
			signal: controller.signal,
		},
	});

	assertCancellationEnvelope(envelope);
	assert.equal(envelope.error?.message, "abort before terminal drain");
	assert.equal(outputDrained, false, "pre-aborted terminal output must not be read");
});

test("cancellation before halted lazy output skips its iterator and later pipeline stages", async () => {
	const controller = new AbortController();
	let outputDrained = false;
	let downstreamRan = false;
	const terminal = {
		name: "test.halted-output-before-later-stage",
		async run() {
			controller.abort(new Error("abort before halted output drain"));
			return {
				halt: true,
				output: (async function* () {
					yield { cleanup: true };
					outputDrained = true;
				})(),
			};
		},
	};
	const downstream = {
		name: "test.halted-output-unreached",
		async run() {
			downstreamRan = true;
			return { output: [] };
		},
	};

	const envelope = await runToolRequest({
		pipeline: "test.halted-output-before-later-stage | test.halted-output-unreached",
		ctx: {
			registry: withCommands(createDefaultRegistry(), terminal, downstream),
			signal: controller.signal,
		},
	});

	assertCancellationEnvelope(envelope);
	assert.equal(envelope.error?.message, "abort before halted output drain");
	assert.equal(outputDrained, false, "halted output must not be read after cancellation");
	assert.equal(downstreamRan, false, "a halted stage must not dispatch later pipeline stages");
});

test("cancellation before a non-terminal lazy handoff does not wait for its next item", async () => {
	const controller = new AbortController();
	const source = {
		name: "test.abort-before-lazy-handoff",
		async run() {
			controller.abort(new Error("abort before lazy handoff"));
			return {
				output: {
					[Symbol.asyncIterator]() {
						return {
							next: () => new Promise<IteratorResult<unknown>>(() => {}),
							async return() {
								return { done: true, value: undefined };
							},
						};
					},
				},
			};
		},
	};

	const settled = await observeSettlement(
		runToolRequest({
			pipeline: "test.abort-before-lazy-handoff | test.unreached",
			ctx: {
				registry: withCommands(createDefaultRegistry(), source),
				signal: controller.signal,
			},
		}),
		500,
	);
	assert.equal(settled.settled, true, "cancellation must not wait for the stalled lazy handoff");
	if (settled.settled) assertCancellationEnvelope(settled.value);
});

test("cancellation before a terminal lazy read invokes its iterator abort hook", async () => {
	const controller = new AbortController();
	let readStarted!: () => void;
	const pendingReadStarted = new Promise<void>((resolve) => {
		readStarted = resolve;
	});
	let resolveNext!: (value: IteratorResult<unknown>) => void;
	let abortCalled = false;
	const terminal = {
		name: "test.cancellable-terminal-lazy-output",
		async run() {
			return {
				halt: true,
				output: {
					[Symbol.asyncIterator]() {
						return {
							abort() {
								abortCalled = true;
								resolveNext({ done: true, value: undefined });
							},
							next() {
								readStarted();
								return new Promise<IteratorResult<unknown>>((resolve) => {
									resolveNext = resolve;
								});
							},
							async return() {
								return { done: true, value: undefined };
							},
						};
					},
				},
			};
		},
	};

	const run = runToolRequest({
		pipeline: "test.cancellable-terminal-lazy-output",
		ctx: {
			registry: withCommands(createDefaultRegistry(), terminal),
			signal: controller.signal,
		},
	});
	await pendingReadStarted;
	controller.abort(new Error("abort cancellable terminal lazy output"));
	const settled = await observeSettlement(run, 500);
	assert.equal(settled.settled, true, "cancellation must release the terminal lazy read");
	if (settled.settled) assertCancellationEnvelope(settled.value);
	assert.equal(abortCalled, true);
});

test("cancellation falls back to an iterable-owned lazy abort hook", async () => {
	const controller = new AbortController();
	let readStarted!: () => void;
	const pendingReadStarted = new Promise<void>((resolve) => {
		readStarted = resolve;
	});
	let resolveNext!: (value: IteratorResult<unknown>) => void;
	let abortCalled = false;
	const source = {
		name: "test.iterable-owned-lazy-abort",
		async run() {
			return {
				output: {
					abort() {
						abortCalled = true;
						resolveNext({ done: true, value: undefined });
					},
					[Symbol.asyncIterator]() {
						return {
							next() {
								readStarted();
								return new Promise<IteratorResult<unknown>>((resolve) => {
									resolveNext = resolve;
								});
							},
							async return() {
								return { done: true, value: undefined };
							},
						};
					},
				},
			};
		},
	};

	const pending = runToolRequest({
		pipeline: "test.iterable-owned-lazy-abort",
		ctx: { registry: withCommands(createDefaultRegistry(), source), signal: controller.signal },
	});
	await pendingReadStarted;
	controller.abort(new Error("cancel iterable-owned lazy output"));
	const settled = await observeSettlement(pending, 500);
	assert.equal(settled.settled, true);
	if (settled.settled) {
		assert.equal(settled.value.ok, false);
		assert.equal(settled.value.error?.type, "runtime_error");
	}
	assert.equal(abortCalled, true);
});

test("cancellation does not pull another lazy output item after an in-flight read aborts", async () => {
	const controller = new AbortController();
	let afterAbortEffects = 0;
	const source = {
		name: "test.abort-does-not-pull-another-output",
		async run() {
			return {
				output: (async function* () {
					yield { value: 1 };
					controller.abort(new Error("abort before next lazy output"));
					afterAbortEffects += 1;
					yield { value: 2 };
					afterAbortEffects += 1;
					yield { value: 3 };
				})(),
			};
		},
	};

	const envelope = await runToolRequest({
		pipeline: "test.abort-does-not-pull-another-output",
		ctx: {
			registry: withCommands(createDefaultRegistry(), source),
			signal: controller.signal,
		},
	});

	assertCancellationEnvelope(envelope);
	assert.equal(
		afterAbortEffects,
		1,
		"cancellation must close the in-flight iterator instead of pulling a later item",
	);
});

test("cancellable lazy output releases a pending read before cancellation returns", async () => {
	const controller = new AbortController();
	let readStarted!: () => void;
	const pendingReadStarted = new Promise<void>((resolve) => {
		readStarted = resolve;
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let resolveNext!: (value: IteratorResult<unknown>) => void;
	let abortCalled = false;
	const source = {
		name: "test.cancellable-lazy-output",
		async run() {
			return {
				output: {
					[Symbol.asyncIterator]() {
						return {
							abort() {
								abortCalled = true;
								if (timer) clearTimeout(timer);
								resolveNext({ done: true, value: undefined });
							},
							next() {
								readStarted();
								return new Promise<IteratorResult<unknown>>((resolve) => {
									resolveNext = resolve;
									timer = setTimeout(() => resolve({ done: true, value: undefined }), 2000);
								});
							},
							async return() {
								return { done: true, value: undefined };
							},
						};
					},
				},
			};
		},
	};
	const downstream = {
		name: "test.cancellable-lazy-downstream",
		async run({ input }: { input: AsyncIterable<unknown> }) {
			for await (const _item of input) {
				// Draining begins the source's pending read.
			}
			return { output: streamOf([]) };
		},
	};

	try {
		const run = runToolRequest({
			pipeline: "test.cancellable-lazy-output | test.cancellable-lazy-downstream",
			ctx: {
				registry: withCommands(createDefaultRegistry(), source, downstream),
				signal: controller.signal,
			},
		});
		await pendingReadStarted;
		controller.abort(new Error("abort cancellable lazy output"));
		const settled = await observeSettlement(run, 500);
		assert.equal(settled.settled, true, "cancellation must release the pending lazy read");
		if (settled.settled) assertCancellationEnvelope(settled.value);
		assert.equal(abortCalled, true);
	} finally {
		if (timer) clearTimeout(timer);
	}
});

test("a permanently stalled native lazy generator does not block cancellation", async () => {
	const controller = new AbortController();
	let readStarted!: () => void;
	const pendingReadStarted = new Promise<void>((resolve) => {
		readStarted = resolve;
	});
	let sourceClosed = false;
	const source = {
		name: "test.native-lazy-output",
		async run() {
			return {
				output: (async function* () {
					try {
						readStarted();
						await new Promise<void>(() => {});
					} finally {
						sourceClosed = true;
					}
				})(),
			};
		},
	};
	const downstream = {
		name: "test.native-lazy-downstream",
		async run({ input }: { input: AsyncIterable<unknown> }) {
			for await (const _item of input) {
				// Draining begins the source's pending read.
			}
			return { output: streamOf([]) };
		},
	};

	const run = runToolRequest({
		pipeline: "test.native-lazy-output | test.native-lazy-downstream",
		ctx: {
			registry: withCommands(createDefaultRegistry(), source, downstream),
			signal: controller.signal,
		},
	});
	await pendingReadStarted;
	controller.abort(new Error("abort native lazy output"));
	const settled = await observeSettlement(run, 500);
	assert.equal(settled.settled, true, "cancellation must not wait for native generator cleanup");
	if (settled.settled) assertCancellationEnvelope(settled.value);
	assert.equal(
		sourceClosed,
		false,
		"a native generator without an abort hook cannot guarantee prompt cleanup",
	);
});

test("cancellation during lazy handoff stops yielding items to the downstream stage", async () => {
	const controller = new AbortController();
	const delivered: number[] = [];
	let sourceClosed = false;
	const source = {
		name: "test.lazy-item-source",
		async run() {
			return {
				output: (async function* () {
					try {
						yield 1;
						yield 2;
						yield 3;
					} finally {
						sourceClosed = true;
					}
				})(),
			};
		},
	};
	const downstream = {
		name: "test.per-item-side-effect",
		async run({ input }: { input: AsyncIterable<unknown> }) {
			return {
				output: (async function* () {
					for await (const item of input) {
						delivered.push(item as number);
						if (delivered.length === 1) {
							controller.abort(new Error("abort after first lazy item"));
						}
						yield item;
					}
				})(),
			};
		},
	};

	const envelope = await runToolRequest({
		pipeline: "test.lazy-item-source | test.per-item-side-effect",
		ctx: {
			registry: withCommands(createDefaultRegistry(), source, downstream),
			signal: controller.signal,
		},
	});

	assertCancellationEnvelope(envelope);
	assert.equal(envelope.error?.message, "abort after first lazy item");
	assert.deepEqual(delivered, [1], "cancelled handoff must not deliver later items");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sourceClosed, true, "cancelling the handoff must close the source iterator");
});

test("cancellation while draining lazy input prevents a downstream OpenClaw call", async () => {
	const controller = new AbortController();
	let requests = 0;
	const server = createServer((_req, res) => {
		requests += 1;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, result: { sent: true } }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing server address");
		const source = {
			name: "test.lazy-abort-source",
			async run() {
				return {
					output: (async function* () {
						yield { value: 1 };
						controller.abort(new Error("aborted during lazy stage handoff"));
					})(),
				};
			},
		};
		const registry = withCommands(createDefaultRegistry(), source);
		const envelope = await runToolRequest({
			pipeline: `test.lazy-abort-source | openclaw.invoke --url http://127.0.0.1:${address.port} --tool messages --action send`,
			ctx: { registry, signal: controller.signal },
		});

		assert.equal(requests, 0, "cancellation must prevent the downstream POST");
		assertCancellationEnvelope(envelope);
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
	}
});

test("parent cancellation terminates the gog process tree and skips Gmail sends", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-cancel-search-"));
	try {
		const repoRoot = join(__dirname, "..", "..");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const searchStarted = join(dir, "search-started");
		const searchTerminated = join(dir, "search-terminated");
		const searchCompleted = join(dir, "search-completed");
		const descendantStarted = join(dir, "descendant-started");
		const descendantCompleted = join(dir, "descendant-completed");
		const sendStarted = join(dir, "send-started");
		const sendCompleted = join(dir, "send-completed");
		const controller = new AbortController();
		const run = runToolRequest({
			pipeline: "gog.gmail.search --query newer_than:1d | gog.gmail.send",
			ctx: {
				signal: controller.signal,
				env: {
					...process.env,
					GOG_BIN: mockGog,
					MOCK_GOG_SEARCH_STARTED_FILE: searchStarted,
					MOCK_GOG_SEARCH_TERMINATED_FILE: searchTerminated,
					MOCK_GOG_SEARCH_COMPLETED_FILE: searchCompleted,
					MOCK_GOG_DESCENDANT_STARTED_FILE: descendantStarted,
					MOCK_GOG_DESCENDANT_COMPLETED_FILE: descendantCompleted,
					MOCK_GOG_SEND_STARTED_FILE: sendStarted,
					MOCK_GOG_SEND_COMPLETED_FILE: sendCompleted,
					MOCK_GOG_TERMINATION_DELAY_MS: "1000",
				},
			},
		});

		await waitForFile(searchStarted);
		await waitForFile(descendantStarted);
		const childPid = Number(await readFile(searchStarted, "utf8"));
		const descendantPid = Number(await readFile(descendantStarted, "utf8"));
		const abortedAt = Date.now();
		controller.abort();
		const immediate = await observeSettlement(run, 50);
		const observed = await observeSettlement(run, 500);
		const envelope = observed.settled ? observed.value : await run;

		assert.equal(immediate.settled, false, "workflow must wait for the child to exit");
		assert.equal(observed.settled, true, "workflow should settle promptly after parent abort");
		assertCancellationEnvelope(envelope);
		if (process.platform !== "win32") {
			await waitForFile(searchTerminated, 500);
		}
		await new Promise((resolve) => setTimeout(resolve, 700));
		assert.equal(processIsRunning(childPid), false);
		assert.equal(
			processIsRunning(descendantPid),
			false,
			"cancellation must kill child processes too",
		);
		if (process.platform !== "win32") {
			assert.equal(await fileExists(searchTerminated), true);
		}
		assert.equal(await fileExists(searchCompleted), false);
		assert.equal(
			await fileExists(descendantCompleted),
			false,
			"descendants must not continue after abort",
		);
		assert.equal(await fileExists(sendStarted), false);
		assert.equal(await fileExists(sendCompleted), false);
		if (observed.settled) assert.ok(observed.settledAt - abortedAt < 500);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow shell cancellation terminates descendant processes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-cancel-workflow-shell-"));
	try {
		const repoRoot = join(__dirname, "..", "..");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const filePath = join(dir, "workflow.lobster");
		const searchStarted = join(dir, "search-started");
		const descendantStarted = join(dir, "descendant-started");
		const descendantCompleted = join(dir, "descendant-completed");
		const controller = new AbortController();
		const command = [process.execPath, mockGog, "gmail", "search"]
			.map((arg) => JSON.stringify(arg))
			.join(" ");
		await writeFile(filePath, JSON.stringify({ steps: [{ id: "shell", run: command }] }), "utf8");

		const run = runToolRequest({
			filePath,
			ctx: {
				cwd: dir,
				signal: controller.signal,
				env: {
					...process.env,
					MOCK_GOG_SEARCH_STARTED_FILE: searchStarted,
					MOCK_GOG_DESCENDANT_STARTED_FILE: descendantStarted,
					MOCK_GOG_DESCENDANT_COMPLETED_FILE: descendantCompleted,
					MOCK_GOG_TERMINATION_DELAY_MS: "1000",
				},
			},
		});

		await waitForFile(searchStarted);
		await waitForFile(descendantStarted);
		const descendantPid = Number(await readFile(descendantStarted, "utf8"));
		controller.abort();
		const immediate = await observeSettlement(run, 50);
		const envelope = await run;

		assert.equal(immediate.settled, false, "workflow must wait for tree termination");
		assertCancellationEnvelope(envelope);
		await new Promise((resolve) => setTimeout(resolve, 900));
		assert.equal(processIsRunning(descendantPid), false);
		assert.equal(
			await fileExists(descendantCompleted),
			false,
			"a workflow shell descendant must not complete after cancellation",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("exec cancellation terminates descendant processes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-cancel-exec-"));
	try {
		const repoRoot = join(__dirname, "..", "..");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const searchStarted = join(dir, "search-started");
		const descendantStarted = join(dir, "descendant-started");
		const descendantCompleted = join(dir, "descendant-completed");
		const controller = new AbortController();
		const run = runToolRequest({
			pipeline: `exec ${process.execPath} ${mockGog} gmail search`,
			ctx: {
				signal: controller.signal,
				env: {
					...process.env,
					MOCK_GOG_SEARCH_STARTED_FILE: searchStarted,
					MOCK_GOG_DESCENDANT_STARTED_FILE: descendantStarted,
					MOCK_GOG_DESCENDANT_COMPLETED_FILE: descendantCompleted,
					MOCK_GOG_TERMINATION_DELAY_MS: "1000",
				},
			},
		});

		await waitForFile(searchStarted);
		await waitForFile(descendantStarted);
		const descendantPid = Number(await readFile(descendantStarted, "utf8"));
		controller.abort();
		const envelope = await run;

		assertCancellationEnvelope(envelope);
		await new Promise((resolve) => setTimeout(resolve, 900));
		assert.equal(processIsRunning(descendantPid), false);
		assert.equal(
			await fileExists(descendantCompleted),
			false,
			"an exec descendant must not complete after cancellation",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test(
	"CLI SIGINT terminates a detached workflow process tree before exiting",
	{ skip: process.platform === "win32" },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "lobster-cli-sigint-process-tree-"));
		let cli: ReturnType<typeof spawn> | undefined;
		try {
			const repoRoot = join(__dirname, "..", "..");
			const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
			const workflow = join(dir, "workflow.lobster");
			const searchStarted = join(dir, "search-started");
			const descendantStarted = join(dir, "descendant-started");
			const descendantCompleted = join(dir, "descendant-completed");
			const command = [process.execPath, mockGog, "gmail", "search"]
				.map((arg) => JSON.stringify(arg))
				.join(" ");
			await writeFile(workflow, JSON.stringify({ steps: [{ id: "shell", run: command }] }), "utf8");

			cli = spawn(
				process.execPath,
				[join(repoRoot, "bin", "lobster.js"), "run", "--file", workflow],
				{
					cwd: dir,
					env: {
						...process.env,
						MOCK_GOG_SEARCH_STARTED_FILE: searchStarted,
						MOCK_GOG_DESCENDANT_STARTED_FILE: descendantStarted,
						MOCK_GOG_DESCENDANT_COMPLETED_FILE: descendantCompleted,
						MOCK_GOG_TERMINATION_DELAY_MS: "1000",
					},
					stdio: "ignore",
				},
			);
			await waitForFile(searchStarted, 5000);
			await waitForFile(descendantStarted, 5000);
			const descendantPid = Number(await readFile(descendantStarted, "utf8"));
			assert.equal(cli.kill("SIGINT"), true);
			const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
				(resolve, reject) => {
					cli!.once("error", reject);
					cli!.once("exit", (code, signal) => resolve({ code, signal }));
				},
			);

			assert.equal(exited.signal, null);
			assert.equal(exited.code, 130, "CLI must retain the conventional SIGINT exit status");
			await new Promise((resolve) => setTimeout(resolve, 900));
			assert.equal(processIsRunning(descendantPid), false);
			assert.equal(
				await fileExists(descendantCompleted),
				false,
				"a detached workflow descendant must not finish after Ctrl+C",
			);
		} finally {
			cli?.kill("SIGKILL");
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"CLI SIGINT prevents later pipeline stages from writing state",
	{ skip: process.platform === "win32" },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "lobster-cli-sigint-pipeline-handoff-"));
		let cli: ReturnType<typeof startLobsterCli> | undefined;
		try {
			const repoRoot = join(__dirname, "..", "..");
			const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
			const stateDir = join(dir, "state");
			const sendStarted = join(dir, "send-started");
			const producer = `printf '${JSON.stringify([
				{ to: "user@example.com", subject: "Hello", body: "World" },
			])}'`;
			const pipeline = `exec --json --shell ${JSON.stringify(producer)} | gog.gmail.send | state.set cli_after_abort`;
			cli = startLobsterCli({
				args: [pipeline],
				cwd: dir,
				env: {
					...process.env,
					LOBSTER_STATE_DIR: stateDir,
					GOG_BIN: mockGog,
					MOCK_GOG_SEND_STARTED_FILE: sendStarted,
					MOCK_GOG_COMPLETION_DELAY_MS: "100",
				},
			});
			await waitForFile(sendStarted, 5000);
			assert.equal(cli.child.kill("SIGINT"), true);
			const exited = await cli.result;

			assert.equal(exited.signal, null);
			assert.equal(exited.code, 130, "CLI must retain the conventional SIGINT exit status");
			assert.equal(await fileExists(keyToPath(stateDir, "cli_after_abort")), false);
		} finally {
			cli?.child.kill("SIGKILL");
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"CLI SIGINT aborts a stalled OpenClaw HTTP call",
	{ skip: process.platform === "win32" },
	async () => {
		let requestReceived!: () => void;
		const requestStarted = new Promise<void>((resolve) => {
			requestReceived = resolve;
		});
		const server = createServer((request) => {
			request.resume();
			requestReceived();
			// Intentionally leave the response open so cancellation must abort fetch.
		});
		let cli: ReturnType<typeof startLobsterCli> | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			const address = server.address();
			assert.ok(address && typeof address !== "string");
			cli = startLobsterCli({
				args: [
					"openclaw.invoke",
					"--url",
					`http://127.0.0.1:${address.port}`,
					"--tool",
					"test",
					"--action",
					"wait",
				],
				cwd: tmpdir(),
				env: process.env,
			});

			const requestObserved = await observeSettlement(requestStarted, 5000);
			assert.equal(requestObserved.settled, true, "OpenClaw request must reach the server");
			assert.equal(cli.child.kill("SIGINT"), true);
			const exited = await observeSettlement(cli.result, 5000);
			assert.equal(exited.settled, true, "CLI must exit after one SIGINT");
			if (!exited.settled) return;
			assert.equal(exited.value.signal, null);
			assert.equal(exited.value.code, 130);
		} finally {
			cli?.child.kill("SIGKILL");
			(server as any).closeAllConnections?.();
			if (server.listening) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		}
	},
);

test("interactive ctx.requestInput aborts its input read", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-request-input-abort-"));
	try {
		const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
		Object.defineProperty(stdin, "isTTY", { value: true });
		const stdout = new PassThrough();
		let promptSeen!: () => void;
		const prompt = new Promise<void>((resolve) => {
			promptSeen = resolve;
		});
		stdout.once("data", () => promptSeen());
		const controller = new AbortController();
		const choose = {
			name: "test.interactive-input",
			async run({ ctx }: any) {
				await ctx.requestInput({
					prompt: "Choose a value",
					responseSchema: { type: "object" },
				});
				return { output: streamOf([]) };
			},
		};
		const run = runPipeline({
			pipeline: [{ name: "test.interactive-input", args: { _: [] } }],
			registry: withCommands(createDefaultRegistry(), choose),
			input: [],
			stdin,
			stdout,
			stderr: new PassThrough(),
			env: { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") },
			mode: "human",
			signal: controller.signal,
		});

		await prompt;
		controller.abort(new Error("input cancelled"));
		await assert.rejects(run, /input cancelled/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test(
	"CLI SIGINT aborts interactive workflow input and approval prompts",
	{ skip: process.platform !== "linux" },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "lobster-cli-sigint-workflow-prompts-"));
		try {
			for (const scenario of [
				{
					name: "input",
					prompt: /Enter JSON response:/,
					workflow: {
						steps: [
							{
								id: "answer",
								input: { prompt: "Continue?", responseSchema: { type: "object" } },
							},
						],
					},
				},
				{
					name: "approval",
					prompt: /Continue\? \[y\/N\]/,
					workflow: { steps: [{ id: "approve", approval: "Continue?" }] },
				},
			]) {
				const workflowPath = join(dir, `${scenario.name}.lobster`);
				await writeFile(workflowPath, JSON.stringify(scenario.workflow), "utf8");
				const cli = startLobsterCli({
					args: ["run", "--mode", "human", "--file", workflowPath],
					cwd: dir,
					env: process.env,
					interactive: true,
				});
				try {
					await waitForCliOutput(cli.getStdout, scenario.prompt);
					const cliPid = await waitForChildProcess(cli.child.pid!);
					process.kill(cliPid, "SIGINT");
					const exited = await observeSettlement(cli.result, 5000);
					assert.equal(exited.settled, true, `${scenario.name} prompt must exit after one SIGINT`);
					if (!exited.settled) continue;
					assert.equal(exited.value.signal, null);
					assert.equal(exited.value.code, 130);
				} finally {
					cli.child.kill("SIGKILL");
				}
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"CLI SIGINT consumes a pipeline approval resume after execution starts",
	{ skip: process.platform === "win32" },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "lobster-cli-sigint-pipeline-resume-"));
		let resumed: ReturnType<typeof startLobsterCli> | undefined;
		try {
			const repoRoot = join(__dirname, "..", "..");
			const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
			const stateDir = join(dir, "state");
			const sendInvocations = join(dir, "send-invocations");
			const sendCompleted = join(dir, "send-completed");
			const searchStarted = join(dir, "search-started");
			const searchTerminated = join(dir, "search-terminated");
			const producer = `printf '${JSON.stringify([
				{ to: "user@example.com", subject: "Hello", body: "World" },
			])}'`;
			const pipeline = `exec --json --shell ${JSON.stringify(producer)} | approve --prompt Send? | gog.gmail.send | gog.gmail.search --query newer_than:1d`;
			const env = {
				...process.env,
				LOBSTER_STATE_DIR: stateDir,
				GOG_BIN: mockGog,
				MOCK_GOG_SEND_INVOCATIONS_FILE: sendInvocations,
				MOCK_GOG_SEND_COMPLETED_FILE: sendCompleted,
				MOCK_GOG_SEARCH_STARTED_FILE: searchStarted,
				MOCK_GOG_SEARCH_TERMINATED_FILE: searchTerminated,
				MOCK_GOG_COMPLETION_DELAY_MS: "100",
			};
			const first = startLobsterCli({ args: ["run", "--mode", "tool", pipeline], cwd: dir, env });
			const initial = await first.result;
			assert.equal(initial.code, 0, initial.stderr);
			const approval = JSON.parse(initial.stdout).requiresApproval;
			assert.ok(approval?.resumeToken);
			assert.ok(approval?.approvalId);

			resumed = startLobsterCli({
				args: ["resume", "--token", approval.resumeToken, "--approve", "yes"],
				cwd: dir,
				env,
			});
			await waitForFile(searchStarted, 5000);
			assert.equal(resumed.child.kill("SIGINT"), true);
			const exited = await resumed.result;

			assert.equal(exited.signal, null);
			assert.equal(exited.code, 130);
			await waitForFile(sendCompleted, 1000);
			await waitForFile(searchTerminated, 1000);
			assert.equal((await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/).length, 1);
			assert.equal(
				(await listStateFiles(stateDir)).some((name) => /^(approval_|pipeline_resume_)/.test(name)),
				false,
			);

			const replayById = startLobsterCli({
				args: ["resume", "--id", approval.approvalId, "--approve", "yes"],
				cwd: dir,
				env,
			});
			const idReplay = await replayById.result;
			assert.equal(idReplay.code, 2);
			assert.match(idReplay.stdout, /not found or expired/);
			const replayByToken = startLobsterCli({
				args: ["resume", "--token", approval.resumeToken, "--approve", "yes"],
				cwd: dir,
				env,
			});
			const tokenReplay = await replayByToken.result;
			assert.equal(tokenReplay.code, 1);
			assert.match(tokenReplay.stdout, /Pipeline resume state not found/);
			assert.equal(
				(await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/).length,
				1,
				"retrying an interrupted CLI resume must not resend",
			);
		} finally {
			resumed?.child.kill("SIGKILL");
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"CLI SIGINT reports a tool envelope while resume cleanup waits on a state lock",
	{ skip: process.platform === "win32" },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "lobster-cli-sigint-resume-cleanup-lock-"));
		let resumed: ReturnType<typeof startLobsterCli> | undefined;
		try {
			const stateDir = join(dir, "state");
			const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
			const first = startLobsterCli({
				args: ["run", "--mode", "tool", "approve --prompt Continue?"],
				cwd: dir,
				env,
			});
			const initial = await first.result;
			assert.equal(initial.code, 0, initial.stderr);
			const approval = JSON.parse(initial.stdout).requiresApproval;
			assert.ok(approval?.resumeToken);

			const payload = decodeResumeToken(approval.resumeToken);
			const lockPath = `${keyToPath(stateDir, payload.stateKey)}.lock`;
			await fsp.mkdir(lockPath);
			await fsp.writeFile(join(lockPath, "owner"), `${process.pid}::live-writer\n`, "utf8");

			resumed = startLobsterCli({
				args: ["resume", "--token", approval.resumeToken, "--cancel"],
				cwd: dir,
				env,
			});
			await new Promise((resolve) => setTimeout(resolve, 1500));
			assert.equal(resumed.child.kill("SIGINT"), true);
			const exited = await resumed.result;

			assert.equal(exited.signal, null);
			assert.equal(exited.code, 130);
			const envelope = JSON.parse(exited.stdout);
			assert.equal(envelope.ok, false);
			assert.equal(envelope.error?.type, "runtime_error");
			assert.match(envelope.error?.message ?? "", /Received SIGINT/);
			await rm(lockPath, { recursive: true, force: true });
		} finally {
			resumed?.child.kill("SIGKILL");
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"CLI SIGINT consumes a workflow approval resume after execution starts",
	{ skip: process.platform === "win32" },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "lobster-cli-sigint-workflow-resume-"));
		let resumed: ReturnType<typeof startLobsterCli> | undefined;
		try {
			const repoRoot = join(__dirname, "..", "..");
			const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
			const workflow = join(dir, "workflow.lobster");
			const stateDir = join(dir, "state");
			const sendInvocations = join(dir, "send-invocations");
			const sendCompleted = join(dir, "send-completed");
			const searchStarted = join(dir, "search-started");
			const searchTerminated = join(dir, "search-terminated");
			const producer = `printf '${JSON.stringify([
				{ to: "user@example.com", subject: "Hello", body: "World" },
			])}'`;
			await writeFile(
				workflow,
				JSON.stringify({
					steps: [
						{ id: "confirm", approval: "Send?" },
						{
							id: "send",
							pipeline: `exec --json --shell ${JSON.stringify(producer)} | gog.gmail.send | gog.gmail.search --query newer_than:1d`,
							when: "$confirm.approved",
						},
					],
				}),
				"utf8",
			);
			const env = {
				...process.env,
				LOBSTER_STATE_DIR: stateDir,
				GOG_BIN: mockGog,
				MOCK_GOG_SEND_INVOCATIONS_FILE: sendInvocations,
				MOCK_GOG_SEND_COMPLETED_FILE: sendCompleted,
				MOCK_GOG_SEARCH_STARTED_FILE: searchStarted,
				MOCK_GOG_SEARCH_TERMINATED_FILE: searchTerminated,
				MOCK_GOG_COMPLETION_DELAY_MS: "100",
			};
			const first = startLobsterCli({
				args: ["run", "--mode", "tool", "--file", workflow],
				cwd: dir,
				env,
			});
			const initial = await first.result;
			assert.equal(initial.code, 0, initial.stderr);
			const approval = JSON.parse(initial.stdout).requiresApproval;
			assert.ok(approval?.resumeToken);
			assert.ok(approval?.approvalId);

			resumed = startLobsterCli({
				args: ["resume", "--token", approval.resumeToken, "--approve", "yes"],
				cwd: dir,
				env,
			});
			await waitForFile(searchStarted, 5000);
			assert.equal(resumed.child.kill("SIGINT"), true);
			const exited = await resumed.result;

			assert.equal(exited.signal, null);
			assert.equal(exited.code, 130);
			await waitForFile(sendCompleted, 1000);
			await waitForFile(searchTerminated, 1000);
			assert.equal((await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/).length, 1);
			assert.equal(
				(await listStateFiles(stateDir)).some((name) =>
					/^(approval_|workflow[-_]resume_)/.test(name),
				),
				false,
			);

			const replayById = startLobsterCli({
				args: ["resume", "--id", approval.approvalId, "--approve", "yes"],
				cwd: dir,
				env,
			});
			const idReplay = await replayById.result;
			assert.equal(idReplay.code, 2);
			assert.match(idReplay.stdout, /not found or expired/);
			const replayByToken = startLobsterCli({
				args: ["resume", "--token", approval.resumeToken, "--approve", "yes"],
				cwd: dir,
				env,
			});
			const tokenReplay = await replayByToken.result;
			assert.equal(tokenReplay.code, 1);
			assert.match(tokenReplay.stdout, /Workflow resume state not found/);
			assert.equal(
				(await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/).length,
				1,
				"retrying an interrupted workflow resume must not resend",
			);
		} finally {
			resumed?.child.kill("SIGKILL");
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("cancellation after Gmail search completion stops the next pipeline stage", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-cancel-search-handoff-"));
	try {
		const repoRoot = join(__dirname, "..", "..");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const controller = new AbortController();
		const signal = controller.signal;
		const throwIfAborted = signal.throwIfAborted.bind(signal);
		let signalChecks = 0;
		Object.defineProperty(signal, "throwIfAborted", {
			value() {
				signalChecks += 1;
				if (signalChecks === 3) controller.abort();
				throwIfAborted();
			},
		});

		let downstreamStarted = false;
		const downstream = {
			name: "test.side-effect",
			async run({ input }: { input: AsyncIterable<unknown> }) {
				downstreamStarted = true;
				for await (const _item of input) {
					// Drain search output before reporting success.
				}
				return { output: streamOf([{ ok: true }]) };
			},
		};
		const envelope = await runToolRequest({
			pipeline: "gog.gmail.search --query newer_than:1d | test.side-effect",
			ctx: {
				registry: withCommands(createDefaultRegistry(), downstream),
				signal,
				env: {
					...process.env,
					GOG_BIN: mockGog,
					MOCK_GOG_COMPLETION_DELAY_MS: "0",
				},
			},
		});

		assertCancellationEnvelope(envelope);
		assert.equal(signalChecks, 3);
		assert.equal(downstreamStarted, false, "cancellation must stop downstream side effects");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("cancellation during eager stage cleanup stops the next tool stage", async () => {
	const controller = new AbortController();
	const source = {
		name: "test.source",
		async run() {
			return {
				output: (async function* () {
					try {
						yield { source: true };
						yield { ignored: true };
					} finally {
						controller.abort();
					}
				})(),
			};
		},
	};
	const eager = {
		name: "test.eager",
		async run({ input }: { input: AsyncIterable<unknown> }) {
			const iterator = input[Symbol.asyncIterator]();
			const first = await iterator.next();
			assert.equal(first.done, false);
			return { output: [{ ok: true }] };
		},
	};
	let downstreamStarted = false;
	const downstream = {
		name: "test.side-effect",
		async run({ input }: { input: AsyncIterable<unknown> }) {
			downstreamStarted = true;
			const items = [];
			for await (const item of input) items.push(item);
			return { output: streamOf(items) };
		},
	};

	const envelope = await runToolRequest({
		pipeline: "test.source | test.eager | test.side-effect",
		ctx: {
			registry: withCommands(createDefaultRegistry(), source, eager, downstream),
			signal: controller.signal,
		},
	});

	assert.equal(controller.signal.aborted, true);
	assertCancellationEnvelope(envelope);
	assert.equal(downstreamStarted, false, "cleanup cancellation must stop the next stage");
});

test("process-tree escalation survives a short-lived caller", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-cancel-short-lived-"));
	try {
		const repoRoot = join(__dirname, "..", "..");
		const runner = join(repoRoot, "dist", "src", "abortable_process.js");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const wrapper = join(repoRoot, "test", "fixtures", "abortable-process-short-lived.mjs");
		const childStarted = join(dir, "search-started");
		const descendantStarted = join(dir, "descendant-started");
		const descendantCompleted = join(dir, "descendant-completed");
		const child = spawn(process.execPath, [wrapper, runner, mockGog], {
			env: {
				...process.env,
				MOCK_GOG_SEARCH_STARTED_FILE: childStarted,
				MOCK_GOG_DESCENDANT_STARTED_FILE: descendantStarted,
				MOCK_GOG_DESCENDANT_COMPLETED_FILE: descendantCompleted,
				MOCK_GOG_TERMINATION_DELAY_MS: "0",
				MOCK_GOG_COMPLETION_DELAY_MS: "5000",
			},
			stdio: "inherit",
		});
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});

		assert.equal(exitCode, 0, "the caller should settle cancellation before it exits");
		await waitForFile(descendantStarted);
		const descendantPid = Number(await readFile(descendantStarted, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 900));
		assert.equal(processIsRunning(descendantPid), false);
		assert.equal(
			await fileExists(descendantCompleted),
			false,
			"a descendant must not outlive a caller that exits after cancellation",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an in-flight gog.gmail.send completes and halts the pipeline after cancellation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-cancel-send-"));
	try {
		const repoRoot = join(__dirname, "..", "..");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const sendStarted = join(dir, "send-started");
		const sendTerminated = join(dir, "send-terminated");
		const sendCompleted = join(dir, "send-completed");
		const sendInvocations = join(dir, "send-invocations");
		const controller = new AbortController();
		const defaultRegistry = createDefaultRegistry();
		const source = {
			name: "draft",
			async run() {
				return {
					output: streamOf([
						{ to: "first@example.com", subject: "First", body: "Hello" },
						{ to: "second@example.com", subject: "Second", body: "Hello again" },
					]),
				};
			},
		};
		let downstreamStarted = false;
		const downstream = {
			name: "test.side-effect",
			async run({ input }: { input: AsyncIterable<unknown> }) {
				downstreamStarted = true;
				const items = [];
				for await (const item of input) items.push(item);
				return { output: streamOf(items) };
			},
		};
		const run = runToolRequest({
			pipeline: "draft | gog.gmail.send | test.side-effect",
			ctx: {
				registry: withCommands(defaultRegistry, source, downstream),
				signal: controller.signal,
				env: {
					...process.env,
					GOG_BIN: mockGog,
					MOCK_GOG_SEND_STARTED_FILE: sendStarted,
					MOCK_GOG_SEND_TERMINATED_FILE: sendTerminated,
					MOCK_GOG_SEND_COMPLETED_FILE: sendCompleted,
					MOCK_GOG_SEND_INVOCATIONS_FILE: sendInvocations,
					MOCK_GOG_COMPLETION_DELAY_MS: "100",
				},
			},
		});

		await waitForFile(sendStarted);
		controller.abort();
		const immediate = await observeSettlement(run, 50);
		const envelope = await run;

		assert.equal(
			immediate.settled,
			false,
			"an already-started send must not report an ambiguous abort",
		);
		assertCancellationEnvelope(envelope);
		assert.equal(downstreamStarted, false, "cancellation must stop later pipeline stages");
		await waitForFile(sendCompleted, 500);
		const invocations = (await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/);
		assert.equal(invocations.length, 1, "cancellation must prevent the second send from starting");
		assert.equal(await fileExists(sendTerminated), false);
		assert.equal(await fileExists(sendCompleted), true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("cancellation after a Gmail send interrupts a blocked next draft read", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-cancel-send-input-"));
	let releaseBlockedRead!: () => void;
	try {
		const repoRoot = join(__dirname, "..", "..");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const sendCompleted = join(dir, "send-completed");
		const sendInvocations = join(dir, "send-invocations");
		const controller = new AbortController();
		let markBlockedReadStarted!: () => void;
		const blockedReadStarted = new Promise<void>((resolve) => {
			markBlockedReadStarted = resolve;
		});
		const blockedRead = new Promise<IteratorResult<unknown>>((resolve) => {
			releaseBlockedRead = () => resolve({ done: true, value: undefined });
		});
		const source = {
			name: "draft",
			async run() {
				return {
					output: {
						[Symbol.asyncIterator]() {
							let reads = 0;
							return {
								async next() {
									reads += 1;
									if (reads === 1) {
										return {
											done: false,
											value: {
												to: "first@example.com",
												subject: "First",
												body: "Hello",
											},
										};
									}
									markBlockedReadStarted();
									return blockedRead;
								},
							};
						},
					},
				};
			},
		};
		const run = runToolRequest({
			pipeline: "draft | gog.gmail.send",
			ctx: {
				registry: withCommands(createDefaultRegistry(), source),
				signal: controller.signal,
				env: {
					...process.env,
					GOG_BIN: mockGog,
					MOCK_GOG_SEND_COMPLETED_FILE: sendCompleted,
					MOCK_GOG_SEND_INVOCATIONS_FILE: sendInvocations,
					MOCK_GOG_COMPLETION_DELAY_MS: "0",
				},
			},
		});

		await waitForFile(sendCompleted);
		await blockedReadStarted;
		controller.abort(new Error("abort while waiting for another draft"));
		const observed = await observeSettlement(run, 100);
		releaseBlockedRead();
		const envelope = observed.settled ? observed.value : await run;

		assert.equal(observed.settled, true, "cancellation must interrupt the blocked input read");
		assertCancellationEnvelope(envelope);
		assert.equal(envelope.error?.message, "abort while waiting for another draft");
		const invocations = (await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/);
		assert.equal(invocations.length, 1, "cancellation must not start another send");
	} finally {
		releaseBlockedRead?.();
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow pipeline halts after an in-flight send completes under cancellation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-cancel-send-"));
	try {
		const repoRoot = join(__dirname, "..", "..");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const filePath = join(dir, "workflow.lobster");
		const sendStarted = join(dir, "send-started");
		const sendTerminated = join(dir, "send-terminated");
		const sendCompleted = join(dir, "send-completed");
		const sendInvocations = join(dir, "send-invocations");
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{
						id: "draft",
						run: `${JSON.stringify(process.execPath)} -e "process.stdout.write(JSON.stringify({to:'user@example.com',subject:'Hello',body:'World'}))"`,
					},
					{
						id: "send",
						pipeline: "gog.gmail.send | test.nested-side-effect",
						stdin: "$draft.json",
					},
					{ id: "later", pipeline: "test.workflow-side-effect" },
				],
			}),
			"utf8",
		);
		let nestedStarted = false;
		const nestedSideEffect = {
			name: "test.nested-side-effect",
			async run({ input }: { input: AsyncIterable<unknown> }) {
				nestedStarted = true;
				const items = [];
				for await (const item of input) items.push(item);
				return { output: streamOf(items) };
			},
		};
		let laterStarted = false;
		const workflowSideEffect = {
			name: "test.workflow-side-effect",
			async run() {
				laterStarted = true;
				return { output: streamOf([{ ok: true }]) };
			},
		};
		const registry = withCommands(createDefaultRegistry(), nestedSideEffect, workflowSideEffect);
		const controller = new AbortController();
		const run = runToolRequest({
			filePath,
			ctx: {
				cwd: dir,
				registry,
				signal: controller.signal,
				env: {
					...process.env,
					LOBSTER_STATE_DIR: join(dir, "state"),
					GOG_BIN: mockGog,
					MOCK_GOG_SEND_STARTED_FILE: sendStarted,
					MOCK_GOG_SEND_TERMINATED_FILE: sendTerminated,
					MOCK_GOG_SEND_COMPLETED_FILE: sendCompleted,
					MOCK_GOG_SEND_INVOCATIONS_FILE: sendInvocations,
					MOCK_GOG_COMPLETION_DELAY_MS: "100",
				},
			},
		});

		await waitForFile(sendStarted);
		controller.abort();
		const immediate = await observeSettlement(run, 50);
		const envelope = await run;

		assert.equal(
			immediate.settled,
			false,
			"an already-started workflow send must return a definitive result",
		);
		assertCancellationEnvelope(envelope);
		await waitForFile(sendCompleted, 500);
		assert.equal(nestedStarted, false, "cancellation must stop the next nested pipeline stage");
		assert.equal(laterStarted, false, "cancellation must stop later workflow steps");
		const invocations = (await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/);
		assert.equal(invocations.length, 1);
		assert.equal(await fileExists(sendTerminated), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("parallel timeout waits for in-flight sends before retrying", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-parallel-timeout-send-settlement-"));
	try {
		const repoRoot = join(__dirname, "..", "..");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const filePath = join(dir, "workflow.lobster");
		const sendStarted = join(dir, "send-started");
		const sendCompleted = join(dir, "send-completed");
		const sendInvocations = join(dir, "send-invocations");
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{
						id: "draft",
						run: `${JSON.stringify(process.execPath)} -e "process.stdout.write(JSON.stringify({to:'user@example.com',subject:'Hello',body:'World'}))"`,
					},
					{
						id: "send",
						retry: { max: 2, delay_ms: 0 },
						parallel: {
							timeout_ms: 80,
							branches: [
								{
									id: "mail",
									pipeline: "gog.gmail.send",
									stdin: "$draft.json",
								},
							],
						},
					},
				],
			}),
			"utf8",
		);

		const run = runToolRequest({
			filePath,
			ctx: {
				cwd: dir,
				registry: createDefaultRegistry(),
				env: {
					...process.env,
					LOBSTER_STATE_DIR: join(dir, "state"),
					GOG_BIN: mockGog,
					MOCK_GOG_SEND_STARTED_FILE: sendStarted,
					MOCK_GOG_SEND_COMPLETED_FILE: sendCompleted,
					MOCK_GOG_SEND_INVOCATIONS_FILE: sendInvocations,
					MOCK_GOG_COMPLETION_DELAY_MS: "300",
				},
			},
		});

		await waitForFile(sendStarted);
		const result = await run;
		assert.equal(result.ok, false);
		assert.match(result.error?.message ?? "", /timed out|timeout|abort|cancel/i);
		assert.equal(
			await fileExists(sendCompleted),
			true,
			"a timeout must wait for its in-flight send before retry policy returns",
		);
		const invocations = (await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/);
		assert.equal(invocations.length, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("approval resume token cannot replay a send after downstream cancellation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-resume-cancel-replay-"));
	try {
		const repoRoot = join(__dirname, "..", "..");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const stateDir = join(dir, "state");
		const sendStarted = join(dir, "send-started");
		const sendCompleted = join(dir, "send-completed");
		const sendInvocations = join(dir, "send-invocations");
		const searchStarted = join(dir, "search-started");
		const searchTerminated = join(dir, "search-terminated");
		const defaultRegistry = createDefaultRegistry();
		const source = {
			name: "draft",
			async run() {
				return {
					output: streamOf([{ to: "user@example.com", subject: "Hello", body: "World" }]),
				};
			},
		};
		const registry = withCommands(defaultRegistry, source);
		const env = {
			...process.env,
			LOBSTER_STATE_DIR: stateDir,
			GOG_BIN: mockGog,
			MOCK_GOG_SEND_STARTED_FILE: sendStarted,
			MOCK_GOG_SEND_COMPLETED_FILE: sendCompleted,
			MOCK_GOG_SEND_INVOCATIONS_FILE: sendInvocations,
			MOCK_GOG_SEARCH_STARTED_FILE: searchStarted,
			MOCK_GOG_SEARCH_TERMINATED_FILE: searchTerminated,
			MOCK_GOG_COMPLETION_DELAY_MS: "100",
		};
		const first = await runToolRequest({
			pipeline:
				"draft | approve --prompt Send? | gog.gmail.send | gog.gmail.search --query newer_than:1d",
			ctx: { registry, env },
		});

		assert.equal(first.ok, true);
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.resumeToken);
		assert.ok(first.requiresApproval.approvalId);

		const controller = new AbortController();
		const resumed = resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { registry, signal: controller.signal, env },
		});
		await waitForFile(searchStarted, 3000);
		controller.abort();
		const envelope = await resumed;

		assertCancellationEnvelope(envelope);
		await waitForFile(sendCompleted, 1000);
		await waitForFile(searchTerminated, 1000);
		let invocations = (await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/);
		assert.equal(invocations.length, 1);

		const replayById = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: {
				registry,
				env: { ...env, MOCK_GOG_COMPLETION_DELAY_MS: "0" },
			},
		});
		assert.equal(replayById.ok, false);
		assert.match(replayById.error?.message ?? "", /not found or expired/);

		const replayByToken = await resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: {
				registry,
				env: { ...env, MOCK_GOG_COMPLETION_DELAY_MS: "0" },
			},
		});
		assert.equal(replayByToken.ok, false);
		assert.match(replayByToken.error?.message ?? "", /Pipeline resume state not found/);
		invocations = (await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/);
		assert.equal(invocations.length, 1, "retrying an aborted resume token must not resend");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pipeline resume state is consumed when cancellation uses a custom reason", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-resume-custom-abort-"));
	try {
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		const source = {
			name: "item",
			async run() {
				return { output: streamOf([{ value: 1 }]) };
			},
		};
		const sideEffect = createCustomAbortSideEffect();
		const registry = withCommands(createDefaultRegistry(), source, sideEffect.command);
		const first = await runToolRequest({
			pipeline: "item | approve --prompt Continue? | test.custom-abort-side-effect",
			ctx: { registry, env },
		});
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.resumeToken);

		const controller = new AbortController();
		const resumed = resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { registry, signal: controller.signal, env },
		});
		await sideEffect.started;
		controller.abort(new Error("shutdown"));
		const aborted = await resumed;
		assert.equal(aborted.ok, false);
		assert.match(aborted.error?.message ?? "", /shutdown/);

		const replay = await resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { registry, env },
		});
		assert.equal(replay.ok, false);
		assert.match(replay.error?.message ?? "", /Pipeline resume state not found/);
		assert.equal(
			sideEffect.invocations,
			1,
			"a custom abort reason must not leave the side effect replayable",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow resume state is consumed when cancellation uses a custom reason", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-custom-abort-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		const sideEffect = createCustomAbortSideEffect();
		const registry = withCommands(createDefaultRegistry(), sideEffect.command);
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "confirm", approval: "Continue?" },
					{
						id: "effect",
						pipeline: "test.custom-abort-side-effect",
						when: "$confirm.approved",
					},
				],
			}),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, registry, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.resumeToken);

		const controller = new AbortController();
		const resumed = resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { cwd: dir, registry, signal: controller.signal, env },
		});
		await sideEffect.started;
		controller.abort(new Error("shutdown"));
		const aborted = await resumed;
		assert.equal(aborted.ok, false);
		assert.match(aborted.error?.message ?? "", /shutdown/);

		const replay = await resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { cwd: dir, registry, env },
		});
		assert.equal(replay.ok, false);
		assert.match(replay.error?.message ?? "", /Workflow resume state not found/);
		assert.equal(
			sideEffect.invocations,
			1,
			"a custom abort reason must not leave the side effect replayable",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("aliased workflow resume state is consumed after cancellation starts execution", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-alias-custom-abort-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		const sideEffect = createCustomAbortSideEffect();
		const registry = withCommands(createDefaultRegistry(), sideEffect.command);
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "confirm", approval: "Continue?" },
					{
						id: "effect",
						pipeline: "test.custom-abort-side-effect",
						when: "$confirm.approved",
					},
				],
			}),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, registry, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);

		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		assert.equal(payload.kind, "workflow-file");
		assert.ok(payload.stateKey?.startsWith("workflow_resume_"));
		const aliasedStateKey = payload.stateKey.replace("workflow_resume_", "workflow-resume_");
		const aliasedToken = encodeToken({ ...payload, stateKey: aliasedStateKey });

		const controller = new AbortController();
		const resumed = resumeToolRequest({
			token: aliasedToken,
			approved: true,
			ctx: { cwd: dir, registry, signal: controller.signal, env },
		});
		await sideEffect.started;
		controller.abort(new Error("abort aliased workflow resume"));
		const aborted = await resumed;
		assertCancellationEnvelope(aborted);

		const replayById = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, registry, env },
		});
		assert.equal(replayById.ok, false);
		assert.match(replayById.error?.message ?? "", /not found or expired/);

		const replayByToken = await resumeToolRequest({
			token: aliasedToken,
			approved: true,
			ctx: { cwd: dir, registry, env },
		});
		assert.equal(replayByToken.ok, false);
		assert.match(replayByToken.error?.message ?? "", /Workflow resume state not found/);
		assert.equal(sideEffect.invocations, 1, "the canonical workflow state must not be replayable");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("explicit cancellation consumes an aliased workflow resume state", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-alias-explicit-cancel-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [{ id: "confirm", approval: "Continue?" }],
			}),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);

		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		assert.equal(payload.kind, "workflow-file");
		assert.ok(payload.stateKey?.startsWith("workflow_resume_"));
		const aliasedToken = encodeToken({
			...payload,
			stateKey: payload.stateKey.replace("workflow_resume_", "workflow-resume_"),
		});
		const cancelled = await resumeToolRequest({
			token: aliasedToken,
			cancel: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(cancelled.ok, true);
		assert.equal(cancelled.status, "cancelled");

		const replayById = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(replayById.ok, false);
		assert.match(replayById.error?.message ?? "", /not found or expired/);
		const replayByToken = await resumeToolRequest({
			token: aliasedToken,
			approved: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(replayByToken.ok, false);
		assert.match(replayByToken.error?.message ?? "", /Workflow resume state not found/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("explicit cancellation stops waiting for a state lock without orphaning its approval ID", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-explicit-cancel-lock-abort-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const first = await runToolRequest({
			pipeline: "approve --prompt Continue?",
			ctx: { cwd: dir, env },
		});
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);

		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		const lockPath = `${keyToPath(stateDir, payload.stateKey)}.lock`;
		const approvalIndexPath = join(stateDir, `approval_${first.requiresApproval.approvalId}.json`);
		await fsp.mkdir(lockPath);
		await fsp.writeFile(join(lockPath, "owner"), `${process.pid}::live-writer\n`, "utf8");

		const controller = new AbortController();
		const pending = resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			cancel: true,
			ctx: { cwd: dir, env, signal: controller.signal },
		});
		const completion = pending.then(
			() => ({ kind: "success" as const }),
			(error) => ({ kind: "error" as const, error }),
		);
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort(new Error("explicit cancellation stopped while waiting for a state lock"));
		const early = await Promise.race([
			completion,
			new Promise<{ kind: "timeout" }>((resolve) =>
				setTimeout(() => resolve({ kind: "timeout" }), 75),
			),
		]);
		if (early.kind === "timeout") await rm(lockPath, { recursive: true, force: true });
		const settled = early.kind === "timeout" ? await completion : early;

		assert.notEqual(
			early.kind,
			"timeout",
			"explicit cancellation must not remain blocked on a state lock",
		);
		assert.equal(settled.kind, "error");
		if (settled.kind === "error") {
			assert.match(
				settled.error?.message ?? "",
				/explicit cancellation stopped while waiting for a state lock/,
			);
		}
		assert.equal(
			await fileExists(approvalIndexPath),
			true,
			"the approval ID must remain usable after cancellation",
		);
		assert.equal(await fileExists(keyToPath(stateDir, payload.stateKey)), true);
		await rm(lockPath, { recursive: true, force: true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow explicit cancellation keeps canonical state when its alternate spelling is locked", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-alternate-cancel-lock-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const filePath = join(dir, "workflow.lobster");
		await writeFile(
			filePath,
			JSON.stringify({ steps: [{ id: "confirm", approval: "Continue?" }] }),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);

		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		assert.ok(payload.stateKey?.startsWith("workflow_resume_"));
		const alternateStateKey = payload.stateKey.replace("workflow_resume_", "workflow-resume_");
		const alternateLock = `${keyToPath(stateDir, alternateStateKey)}.lock`;
		const approvalIndexPath = join(stateDir, `approval_${first.requiresApproval.approvalId}.json`);
		await fsp.mkdir(alternateLock);
		await fsp.writeFile(join(alternateLock, "owner"), `${process.pid}::live-writer\n`, "utf8");

		const controller = new AbortController();
		const pending = resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			cancel: true,
			ctx: { cwd: dir, env, signal: controller.signal },
		}).then(
			(value) => ({ kind: "value" as const, value }),
			(error) => ({ kind: "error" as const, error }),
		);
		await new Promise((resolve) => setTimeout(resolve, 25));
		controller.abort(new Error("alternate cleanup lock interrupted cancellation"));
		const settled = await observeSettlement(pending, 500);
		assert.equal(settled.settled, true);
		if (settled.settled) {
			assert.equal(settled.value.kind, "error");
			if (settled.value.kind === "error") {
				assert.match(settled.value.error?.message ?? "", /alternate cleanup lock interrupted/);
			}
		}
		assert.equal(await fileExists(keyToPath(stateDir, payload.stateKey)), true);
		assert.equal(await fileExists(approvalIndexPath), true);
		await rm(alternateLock, { recursive: true, force: true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a failed post-effect resume cleanup leaves a non-replayable pipeline tombstone", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-consumed-pipeline-tombstone-"));
	const originalUnlink = fsp.unlink;
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const effect = createCountingSideEffect("test.tombstone-effect");
		const registry = withCommands(createDefaultRegistry(), effect.command);
		const first = await runToolRequest({
			pipeline: "approve --prompt Continue? | test.tombstone-effect",
			ctx: { cwd: dir, env, registry },
		});
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.resumeToken);
		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		const statePath = keyToPath(stateDir, payload.stateKey);
		Object.defineProperty(fsp, "unlink", {
			configurable: true,
			writable: true,
			async value(filePath: Parameters<typeof fsp.unlink>[0]) {
				if (String(filePath) === statePath) {
					throw Object.assign(new Error("injected resume unlink failure"), { code: "EIO" });
				}
				return originalUnlink(filePath);
			},
		});

		const resumed = await resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { cwd: dir, env, registry },
		});
		assert.equal(resumed.ok, false);
		assert.match(resumed.error?.message ?? "", /injected resume unlink failure/);
		assert.equal(effect.invocations, 1);

		const replay = await resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { cwd: dir, env, registry },
		});
		assert.equal(replay.ok, false);
		assert.match(replay.error?.message ?? "", /Pipeline resume state not found/);
		assert.equal(effect.invocations, 1, "a tombstoned token must not repeat its side effect");
	} finally {
		Object.defineProperty(fsp, "unlink", {
			configurable: true,
			writable: true,
			value: originalUnlink,
		});
		await rm(dir, { recursive: true, force: true });
	}
});

async function assertApprovalResumeIsExclusive({
	workflow,
	resumeBy,
}: {
	workflow: boolean;
	resumeBy: "token" | "approvalId";
}) {
	const dir = await mkdtemp(join(tmpdir(), "lobster-exclusive-resume-"));
	const originalRename = fsp.rename;
	let releaseFirstRename!: () => void;
	const firstRenameReached = new Promise<void>((resolve) => {
		releaseFirstRename = resolve;
	});
	let renamePaused = false;
	let releaseFirstEffect!: () => void;
	const firstEffectMayFinish = new Promise<void>((resolve) => {
		releaseFirstEffect = resolve;
	});
	let invocations = 0;
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const effect = {
			name: "test.exclusive-resume-effect",
			async run({ input }: { input: AsyncIterable<unknown> }) {
				invocations += 1;
				const items = [];
				for await (const item of input) items.push(item);
				if (invocations === 1) await firstEffectMayFinish;
				return { output: streamOf(items.length ? items : [{ ok: true }]) };
			},
		};
		const registry = withCommands(createDefaultRegistry(), effect);
		let first;
		if (workflow) {
			const filePath = join(dir, "workflow.lobster");
			await writeFile(
				filePath,
				JSON.stringify({
					steps: [
						{ id: "approve", approval: "Continue?" },
						{ id: "effect", pipeline: "test.exclusive-resume-effect" },
					],
				}),
				"utf8",
			);
			first = await runToolRequest({ filePath, ctx: { cwd: dir, env, registry } });
		} else {
			first = await runToolRequest({
				pipeline: "approve --prompt Continue? | test.exclusive-resume-effect",
				ctx: { cwd: dir, env, registry },
			});
		}
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.resumeToken);
		assert.ok(first.requiresApproval?.approvalId);
		const payload = decodeResumeToken(first.requiresApproval.resumeToken!);
		const statePath = keyToPath(stateDir, payload.stateKey);

		Object.defineProperty(fsp, "rename", {
			configurable: true,
			writable: true,
			async value(from: Parameters<typeof fsp.rename>[0], to: Parameters<typeof fsp.rename>[1]) {
				if (String(to) === statePath && !renamePaused) {
					renamePaused = true;
					await firstRenameReached;
				}
				return originalRename(from, to);
			},
		});

		const resumeArgs =
			resumeBy === "token"
				? { token: first.requiresApproval.resumeToken! }
				: { approvalId: first.requiresApproval.approvalId! };
		const firstResume = resumeToolRequest({
			...resumeArgs,
			approved: true,
			ctx: { cwd: dir, env, registry },
		});
		while (!renamePaused) await new Promise((resolve) => setImmediate(resolve));
		const secondResume = resumeToolRequest({
			...resumeArgs,
			approved: true,
			ctx: { cwd: dir, env, registry },
		});
		releaseFirstRename();
		// The first effect is held open. The second request has enough time to
		// reach the guarded claim, but cannot be allowed to observe cleanup as a
		// missing-state retry opportunity.
		await new Promise((resolve) => setTimeout(resolve, 30));
		releaseFirstEffect();
		const outcomes = await Promise.all([firstResume, secondResume]);

		assert.equal(invocations, 1, "one approval may dispatch exactly one effect");
		assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
		assert.equal(outcomes.filter((outcome) => !outcome.ok).length, 1);
		assert.match(
			outcomes.find((outcome) => !outcome.ok)?.error?.message ?? "",
			/resume state not found/i,
		);
	} finally {
		Object.defineProperty(fsp, "rename", {
			configurable: true,
			writable: true,
			value: originalRename,
		});
		await rm(dir, { recursive: true, force: true });
	}
}

test("pipeline approval token and short ID each dispatch an effect at most once", async () => {
	for (const resumeBy of ["token", "approvalId"] as const) {
		await assertApprovalResumeIsExclusive({ workflow: false, resumeBy });
	}
});

test("workflow approval token and short ID each dispatch an effect at most once", async () => {
	for (const resumeBy of ["token", "approvalId"] as const) {
		await assertApprovalResumeIsExclusive({ workflow: true, resumeBy });
	}
});

async function assertApprovalGateHandoffIsExclusive({
	workflow,
	resumeBy,
}: {
	workflow: boolean;
	resumeBy: "token" | "approvalId";
}) {
	const dir = await mkdtemp(join(tmpdir(), "lobster-exclusive-gate-handoff-"));
	let invocations = 0;
	try {
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		const effect = {
			name: "test.exclusive-gate-handoff-effect",
			async run() {
				invocations += 1;
				return { output: streamOf([{ ok: true }]) };
			},
		};
		const registry = withCommands(createDefaultRegistry(), effect);
		let first;
		if (workflow) {
			const filePath = join(dir, "workflow.lobster");
			await writeFile(
				filePath,
				JSON.stringify({
					steps: [
						{ id: "first", approval: "First?" },
						{ id: "second", pipeline: "ask --prompt Second?" },
						{ id: "effect", pipeline: "test.exclusive-gate-handoff-effect" },
					],
				}),
				"utf8",
			);
			first = await runToolRequest({ filePath, ctx: { cwd: dir, env, registry } });
		} else {
			first = await runToolRequest({
				pipeline:
					"approve --prompt First? | ask --prompt Second? | test.exclusive-gate-handoff-effect",
				ctx: { cwd: dir, env, registry },
			});
		}
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.resumeToken);
		assert.ok(first.requiresApproval?.approvalId);

		const resumeArgs =
			resumeBy === "token"
				? { token: first.requiresApproval.resumeToken! }
				: { approvalId: first.requiresApproval.approvalId! };
		const outcomes = await Promise.all([
			resumeToolRequest({ ...resumeArgs, approved: true, ctx: { cwd: dir, env, registry } }),
			resumeToolRequest({ ...resumeArgs, approved: true, ctx: { cwd: dir, env, registry } }),
		]);

		const successor = outcomes.find((outcome) => outcome.ok && outcome.status === "needs_input");
		assert.ok(successor?.requiresInput?.resumeToken, "exactly one successor gate must be returned");
		assert.equal(
			outcomes.filter((outcome) => outcome.ok && outcome.status === "needs_input").length,
			1,
		);
		assert.equal(outcomes.filter((outcome) => !outcome.ok).length, 1);
		assert.match(
			outcomes.find((outcome) => !outcome.ok)?.error?.message ?? "",
			/resume state not found/i,
		);

		const completed = await resumeToolRequest({
			token: successor!.requiresInput!.resumeToken!,
			response: { decision: "approve" },
			ctx: { cwd: dir, env, registry },
		});
		assert.equal(completed.ok, true);
		assert.equal(completed.status, "ok");
		assert.equal(invocations, 1, "only the winning successor may reach the effect");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("pipeline approval token and short ID cannot fork a next input gate", async () => {
	for (const resumeBy of ["token", "approvalId"] as const) {
		await assertApprovalGateHandoffIsExclusive({ workflow: false, resumeBy });
	}
});

test("workflow approval token and short ID cannot fork a next input gate", async () => {
	for (const resumeBy of ["token", "approvalId"] as const) {
		await assertApprovalGateHandoffIsExclusive({ workflow: true, resumeBy });
	}
});

test("a cancellation immediately after pipeline resume consumption restores the unstarted approval", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-consume-rename-abort-"));
	const originalRename = fsp.rename;
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const effect = createCountingSideEffect("test.consume-rename-effect");
		const registry = withCommands(createDefaultRegistry(), effect.command);
		const first = await runToolRequest({
			pipeline: "approve --prompt Continue? | test.consume-rename-effect",
			ctx: { cwd: dir, env, registry },
		});
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.resumeToken);
		const payload = decodeResumeToken(first.requiresApproval.resumeToken!);
		const statePath = keyToPath(stateDir, payload.stateKey);
		const controller = new AbortController();
		let abortedAtConsumption = false;
		Object.defineProperty(fsp, "rename", {
			configurable: true,
			writable: true,
			async value(from: Parameters<typeof fsp.rename>[0], to: Parameters<typeof fsp.rename>[1]) {
				await originalRename(from, to);
				if (String(to) === statePath && !abortedAtConsumption) {
					abortedAtConsumption = true;
					controller.abort(new Error("abort after consumed resume rename"));
				}
			},
		});

		const cancelled = await resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { cwd: dir, env, registry, signal: controller.signal },
		});
		assertCancellationEnvelope(cancelled);
		assert.equal(effect.invocations, 0);
		assert.equal(abortedAtConsumption, true);

		const retried = await resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { cwd: dir, env, registry },
		});
		assert.equal(retried.ok, true);
		assert.equal(effect.invocations, 1);
	} finally {
		Object.defineProperty(fsp, "rename", {
			configurable: true,
			writable: true,
			value: originalRename,
		});
		await rm(dir, { recursive: true, force: true });
	}
});

test("approval rejection stops waiting for a state lock without orphaning its approval ID", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-approval-rejection-lock-abort-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const first = await runToolRequest({
			pipeline: "approve --prompt Continue?",
			ctx: { cwd: dir, env },
		});
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);

		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		const lockPath = `${keyToPath(stateDir, payload.stateKey)}.lock`;
		const approvalIndexPath = join(stateDir, `approval_${first.requiresApproval.approvalId}.json`);
		await fsp.mkdir(lockPath);
		await fsp.writeFile(join(lockPath, "owner"), `${process.pid}::live-writer\n`, "utf8");

		const controller = new AbortController();
		const pending = resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: false,
			ctx: { cwd: dir, env, signal: controller.signal },
		});
		const completion = pending.then(
			() => ({ kind: "success" as const }),
			(error) => ({ kind: "error" as const, error }),
		);
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort(new Error("approval rejection stopped while waiting for a state lock"));
		const early = await Promise.race([
			completion,
			new Promise<{ kind: "timeout" }>((resolve) =>
				setTimeout(() => resolve({ kind: "timeout" }), 75),
			),
		]);
		if (early.kind === "timeout") await rm(lockPath, { recursive: true, force: true });
		const settled = early.kind === "timeout" ? await completion : early;

		assert.notEqual(
			early.kind,
			"timeout",
			"approval rejection must not remain blocked on a state lock",
		);
		assert.equal(settled.kind, "error");
		if (settled.kind === "error") {
			assert.match(
				settled.error?.message ?? "",
				/approval rejection stopped while waiting for a state lock/,
			);
		}
		assert.equal(
			await fileExists(approvalIndexPath),
			true,
			"the approval ID must remain usable after cancelled rejection cleanup",
		);
		assert.equal(await fileExists(keyToPath(stateDir, payload.stateKey)), true);
		await rm(lockPath, { recursive: true, force: true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow approval rejection keeps its approval ID when state cleanup is cancelled", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-approval-rejection-lock-abort-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		await writeFile(
			filePath,
			JSON.stringify({ steps: [{ id: "confirm", approval: "Continue?" }] }),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);

		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		const lockPath = `${keyToPath(stateDir, payload.stateKey)}.lock`;
		const approvalIndexPath = join(stateDir, `approval_${first.requiresApproval.approvalId}.json`);
		await fsp.mkdir(lockPath);
		await fsp.writeFile(join(lockPath, "owner"), `${process.pid}::live-writer\n`, "utf8");

		const controller = new AbortController();
		const pending = resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: false,
			ctx: { cwd: dir, env, signal: controller.signal },
		});
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort(new Error("workflow rejection stopped while waiting for a state lock"));
		const result = await observeSettlement(pending, 500);
		assert.equal(result.settled, true, "workflow rejection must stop waiting for the state lock");
		if (result.settled) {
			assert.equal(result.value.ok, false);
			assert.match(
				result.value.error?.message ?? "",
				/workflow rejection stopped while waiting for a state lock/,
			);
		}
		assert.equal(await fileExists(approvalIndexPath), true);
		assert.equal(await fileExists(keyToPath(stateDir, payload.stateKey)), true);
		await rm(lockPath, { recursive: true, force: true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("terminal pipeline resume cleanup stops waiting for a state lock", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-terminal-pipeline-lock-abort-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const first = await runToolRequest({
			pipeline: "approve --prompt Continue?",
			ctx: { cwd: dir, env },
		});
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);

		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		const lockPath = `${keyToPath(stateDir, payload.stateKey)}.lock`;
		const approvalIndexPath = join(stateDir, `approval_${first.requiresApproval.approvalId}.json`);
		await fsp.mkdir(lockPath);
		await fsp.writeFile(join(lockPath, "owner"), `${process.pid}::live-writer\n`, "utf8");

		const controller = new AbortController();
		const pending = resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env, signal: controller.signal },
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		controller.abort(new Error("terminal pipeline cleanup stopped while waiting for a state lock"));
		const early = await observeSettlement(pending, 75);
		if (!early.settled) await rm(lockPath, { recursive: true, force: true });
		const settled = early.settled ? early : await observeSettlement(pending, 75);

		assert.equal(settled.settled, true, "terminal cleanup must not remain blocked on a state lock");
		if (settled.settled) {
			assert.equal(settled.value.ok, false);
			assert.match(
				settled.value.error?.message ?? "",
				/terminal pipeline cleanup stopped while waiting for a state lock/,
			);
		}
		assert.equal(await fileExists(approvalIndexPath), true);
		assert.equal(await fileExists(keyToPath(stateDir, payload.stateKey)), true);
		await rm(lockPath, { recursive: true, force: true });

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(retried.status, "ok");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pipeline gate replacement stops waiting for a state lock", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-pipeline-gate-lock-abort-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const first = await runToolRequest({
			pipeline: "approve --prompt First? | approve --prompt Second?",
			ctx: { cwd: dir, env },
		});
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);

		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		const lockPath = `${keyToPath(stateDir, payload.stateKey)}.lock`;
		const approvalIndexPath = join(stateDir, `approval_${first.requiresApproval.approvalId}.json`);
		await fsp.mkdir(lockPath);
		await fsp.writeFile(join(lockPath, "owner"), `${process.pid}::live-writer\n`, "utf8");

		const controller = new AbortController();
		const originalMkdir = fsp.mkdir;
		let signalLockAttempt: ((value: boolean) => void) | undefined;
		const lockAttempted = new Promise<boolean>((resolve) => {
			signalLockAttempt = resolve;
		});
		let sawLockAttempt = false;
		Object.defineProperty(fsp, "mkdir", {
			configurable: true,
			writable: true,
			async value(
				filePath: Parameters<typeof fsp.mkdir>[0],
				options?: Parameters<typeof fsp.mkdir>[1],
			) {
				if (!sawLockAttempt && String(filePath) === lockPath) {
					sawLockAttempt = true;
					signalLockAttempt?.(true);
				}
				return originalMkdir(filePath, options);
			},
		});
		let settled;
		try {
			const pending = resumeToolRequest({
				approvalId: first.requiresApproval.approvalId,
				approved: true,
				ctx: { cwd: dir, env, signal: controller.signal },
			});
			const reachedLock = await Promise.race([
				lockAttempted,
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
			]);
			assert.equal(reachedLock, true, "resume must reach the held state lock");
			controller.abort(
				new Error("pipeline gate replacement stopped while waiting for a state lock"),
			);
			const early = await observeSettlement(pending, 75);
			if (!early.settled) await rm(lockPath, { recursive: true, force: true });
			settled = early.settled ? early : await observeSettlement(pending, 75);
		} finally {
			Object.defineProperty(fsp, "mkdir", {
				configurable: true,
				writable: true,
				value: originalMkdir,
			});
		}

		assert.equal(
			settled?.settled,
			true,
			"gate replacement must not remain blocked on a state lock",
		);
		if (settled?.settled) {
			assert.equal(settled.value.ok, false);
			assert.match(
				settled.value.error?.message ?? "",
				/pipeline gate replacement stopped while waiting for a state lock/,
			);
		}
		assert.equal(await fileExists(approvalIndexPath), true);
		assert.equal(await fileExists(keyToPath(stateDir, payload.stateKey)), true);
		await rm(lockPath, { recursive: true, force: true });

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(retried.status, "needs_approval");
		assert.equal(retried.requiresApproval?.prompt, "Second?");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("terminal workflow resume cleanup stops waiting for a state lock", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-terminal-workflow-lock-abort-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const filePath = join(dir, "workflow.lobster");
		await writeFile(
			filePath,
			JSON.stringify({ steps: [{ id: "approve", approval: "Continue?" }] }),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);

		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		const lockPath = `${keyToPath(stateDir, payload.stateKey)}.lock`;
		const approvalIndexPath = join(stateDir, `approval_${first.requiresApproval.approvalId}.json`);
		await fsp.mkdir(lockPath);
		await fsp.writeFile(join(lockPath, "owner"), `${process.pid}::live-writer\n`, "utf8");

		const controller = new AbortController();
		const pending = resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env, signal: controller.signal },
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		controller.abort(new Error("terminal workflow cleanup stopped while waiting for a state lock"));
		const early = await observeSettlement(pending, 75);
		if (!early.settled) await rm(lockPath, { recursive: true, force: true });
		const settled = early.settled ? early : await observeSettlement(pending, 75);
		assert.equal(
			settled.settled,
			true,
			"terminal workflow cleanup must not remain blocked on a state lock",
		);
		if (settled.settled) {
			assert.equal(settled.value.ok, false);
			assert.match(
				settled.value.error?.message ?? "",
				/terminal workflow cleanup stopped while waiting for a state lock/,
			);
		}
		assert.equal(await fileExists(approvalIndexPath), true);
		assert.equal(await fileExists(keyToPath(stateDir, payload.stateKey)), true);
		await rm(lockPath, { recursive: true, force: true });

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(retried.status, "ok");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow gate replacement stops waiting for a state lock", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-gate-lock-abort-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const filePath = join(dir, "workflow.lobster");
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "first", approval: "First?" },
					{ id: "second", approval: "Second?" },
				],
			}),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);

		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		const lockPath = `${keyToPath(stateDir, payload.stateKey)}.lock`;
		const approvalIndexPath = join(stateDir, `approval_${first.requiresApproval.approvalId}.json`);
		await fsp.mkdir(lockPath);
		await fsp.writeFile(join(lockPath, "owner"), `${process.pid}::live-writer\n`, "utf8");

		const controller = new AbortController();
		const pending = resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env, signal: controller.signal },
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		controller.abort(new Error("workflow gate replacement stopped while waiting for a state lock"));
		const early = await observeSettlement(pending, 75);
		if (!early.settled) await rm(lockPath, { recursive: true, force: true });
		const settled = early.settled ? early : await observeSettlement(pending, 75);
		assert.equal(settled.settled, true, "gate replacement must not remain blocked on a state lock");
		if (settled.settled) {
			assert.equal(settled.value.ok, false);
			assert.match(
				settled.value.error?.message ?? "",
				/workflow gate replacement stopped while waiting for a state lock/,
			);
		}
		assert.equal(await fileExists(approvalIndexPath), true);
		assert.equal(await fileExists(keyToPath(stateDir, payload.stateKey)), true);
		await rm(lockPath, { recursive: true, force: true });

		const retried = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(retried.status, "needs_approval");
		assert.equal(retried.requiresApproval?.prompt, "Second?");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("lazy output iterator acquisition failure closes the active stage", async () => {
	let inputClosed = false;
	const input = {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					return { done: false, value: { item: 1 } };
				},
				async return() {
					inputClosed = true;
					return { done: true, value: undefined };
				},
			};
		},
	};
	const command = {
		name: "test.throw-on-iterator-acquisition",
		async run({ input: stageInput }: { input: AsyncIterable<unknown> }) {
			await stageInput[Symbol.asyncIterator]().next();
			return {
				output: {
					[Symbol.asyncIterator]() {
						throw new Error("iterator acquisition failed");
					},
				},
			};
		},
	};

	await assert.rejects(
		runPipeline({
			pipeline: [{ name: command.name, args: {} }],
			registry: withCommands(createDefaultRegistry(), command),
			stdin: process.stdin,
			stdout: process.stdout,
			stderr: process.stderr,
			env: process.env,
			input,
		}),
		/iterator acquisition failed/,
	);
	assert.equal(inputClosed, true, "iterator acquisition failure must finish and close the stage");
});

test("explicit cancellation removes a corrupt workflow state through an aliased token", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-alias-corrupt-cancel-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [{ id: "confirm", approval: "Continue?" }],
			}),
			"utf8",
		);
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });
		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.approvalId);
		assert.ok(first.requiresApproval?.resumeToken);

		const payload = decodeResumeToken(first.requiresApproval.resumeToken);
		assert.equal(payload.kind, "workflow-file");
		assert.ok(payload.stateKey?.startsWith("workflow_resume_"));
		await writeFile(keyToPath(stateDir, payload.stateKey), '{"corrupt"', "utf8");
		const aliasedToken = encodeToken({
			...payload,
			stateKey: payload.stateKey.replace("workflow_resume_", "workflow-resume_"),
		});

		const cancelled = await resumeToolRequest({
			token: aliasedToken,
			cancel: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(cancelled.ok, true);
		assert.equal(cancelled.status, "cancelled");
		assert.equal(await fileExists(keyToPath(stateDir, payload.stateKey)), false);
		const replayById = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env },
		});
		assert.equal(replayById.ok, false);
		assert.match(replayById.error?.message ?? "", /not found or expired/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow on_error cannot swallow cancellation with a custom reason", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-on-error-custom-abort-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		const sideEffect = createCustomAbortSideEffect();
		const registry = withCommands(createDefaultRegistry(), sideEffect.command);
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{
						id: "effect",
						pipeline: "test.custom-abort-side-effect",
						on_error: "continue",
					},
					{
						id: "later",
						input: {
							prompt: "This input must not start",
							responseSchema: { type: "boolean" },
						},
					},
				],
			}),
			"utf8",
		);
		const controller = new AbortController();
		const run = runToolRequest({
			filePath,
			ctx: { cwd: dir, registry, signal: controller.signal, env },
		});
		await sideEffect.started;
		controller.abort(new Error("shutdown"));

		const envelope = await run;

		assert.equal(envelope.ok, false);
		assert.match(envelope.error?.message ?? "", /shutdown/);
		assert.equal(
			sideEffect.invocations,
			1,
			"custom cancellation must stop the workflow before later steps",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("approval resume token cannot replay after a non-abort failure past an unsafe boundary", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-resume-retry-"));
	try {
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		let attempts = 0;
		const source = {
			name: "item",
			async run() {
				return { output: streamOf([{ value: 1 }]) };
			},
		};
		const failOnce = {
			name: "test.fail-once",
			async run({ input }: { input: AsyncIterable<unknown> }) {
				attempts += 1;
				if (attempts === 1) throw new Error("retryable failure");
				const items = [];
				for await (const item of input) items.push(item);
				return { output: streamOf(items) };
			},
		};
		const registry = withCommands(createDefaultRegistry(), source, failOnce);
		const first = await runToolRequest({
			pipeline: "item | approve --prompt Continue? | test.fail-once",
			ctx: { registry, env },
		});

		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.resumeToken);
		const failed = await resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { registry, env },
		});
		assert.equal(failed.ok, false);
		assert.match(failed.error?.message ?? "", /retryable failure/);

		const replay = await resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { registry, env },
		});
		assert.equal(replay.ok, false);
		assert.match(replay.error?.message ?? "", /Pipeline resume state not found/);
		assert.equal(attempts, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("next-stage input resume cannot replay after a non-abort failure past an unsafe boundary", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-input-resume-retry-"));
	try {
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		let attempts = 0;
		const failOnce = {
			name: "test.fail-once",
			async run({ input }: { input: AsyncIterable<unknown> }) {
				attempts += 1;
				if (attempts === 1) throw new Error("retryable failure");
				const items = [];
				for await (const item of input) items.push(item);
				return { output: streamOf(items) };
			},
		};
		const registry = withCommands(createDefaultRegistry(), failOnce);
		const responseSchema = JSON.stringify({
			type: "object",
			properties: { value: { type: "number" } },
			required: ["value"],
		});
		const first = await runToolRequest({
			pipeline: `ask --emit --prompt Continue? --schema '${responseSchema}' | test.fail-once`,
			ctx: { registry, env },
		});

		assert.equal(first.status, "needs_input");
		assert.ok(first.requiresInput?.resumeToken);
		const failed = await resumeToolRequest({
			token: first.requiresInput.resumeToken,
			response: { value: 1 },
			ctx: { registry, env },
		});
		assert.equal(failed.ok, false);
		assert.match(failed.error?.message ?? "", /retryable failure/);
		const replay = await resumeToolRequest({
			token: first.requiresInput.resumeToken,
			response: { value: 1 },
			ctx: { registry, env },
		});
		assert.equal(replay.ok, false);
		assert.match(replay.error?.message ?? "", /Pipeline resume state not found/);
		assert.equal(attempts, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow resume cannot replay after a non-abort failure past an unsafe boundary", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-resume-retry-"));
	try {
		const filePath = join(dir, "workflow.lobster");
		const env = { ...process.env, LOBSTER_STATE_DIR: join(dir, "state") };
		let attempts = 0;
		const failOnce = {
			name: "test.fail-once",
			async run() {
				attempts += 1;
				if (attempts === 1) throw new Error("retryable failure");
				return { output: streamOf([{ ok: true }]) };
			},
		};
		const registry = withCommands(createDefaultRegistry(), failOnce);
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "confirm", approval: "Continue?" },
					{
						id: "finish",
						pipeline: "test.fail-once",
						when: "$confirm.approved",
					},
				],
			}),
			"utf8",
		);
		const first = await runToolRequest({
			filePath,
			ctx: { cwd: dir, registry, env },
		});

		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.resumeToken);
		const failed = await resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { cwd: dir, registry, env },
		});
		assert.equal(failed.ok, false);
		assert.match(failed.error?.message ?? "", /retryable failure/);
		const replay = await resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { cwd: dir, registry, env },
		});
		assert.equal(replay.ok, false);
		assert.match(replay.error?.message ?? "", /Workflow resume state not found/);
		assert.equal(attempts, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("next-stage input resume cannot replay a send after downstream cancellation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-input-resume-cancel-replay-"));
	try {
		const repoRoot = join(__dirname, "..", "..");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const stateDir = join(dir, "state");
		const sendCompleted = join(dir, "send-completed");
		const sendInvocations = join(dir, "send-invocations");
		const searchStarted = join(dir, "search-started");
		const searchTerminated = join(dir, "search-terminated");
		const env = {
			...process.env,
			LOBSTER_STATE_DIR: stateDir,
			GOG_BIN: mockGog,
			MOCK_GOG_SEND_COMPLETED_FILE: sendCompleted,
			MOCK_GOG_SEND_INVOCATIONS_FILE: sendInvocations,
			MOCK_GOG_SEARCH_STARTED_FILE: searchStarted,
			MOCK_GOG_SEARCH_TERMINATED_FILE: searchTerminated,
			MOCK_GOG_COMPLETION_DELAY_MS: "100",
		};
		const responseSchema = JSON.stringify({
			type: "object",
			properties: {
				to: { type: "string" },
				subject: { type: "string" },
				body: { type: "string" },
			},
			required: ["to", "subject", "body"],
		});
		const pipeline = `ask --emit --prompt Draft --schema '${responseSchema}' | gog.gmail.send | gog.gmail.search --query newer_than:1d`;
		const response = { to: "user@example.com", subject: "Hello", body: "World" };
		const first = await runToolRequest({ pipeline, ctx: { env } });

		assert.equal(first.status, "needs_input");
		assert.ok(first.requiresInput?.resumeToken);
		const controller = new AbortController();
		const resumed = resumeToolRequest({
			token: first.requiresInput.resumeToken,
			response,
			ctx: { signal: controller.signal, env },
		});
		await waitForFile(searchStarted, 3000);
		controller.abort();
		const envelope = await resumed;

		assertCancellationEnvelope(envelope);
		await waitForFile(sendCompleted, 1000);
		await waitForFile(searchTerminated, 1000);
		let invocations = (await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/);
		assert.equal(invocations.length, 1);

		const replay = await resumeToolRequest({
			token: first.requiresInput.resumeToken,
			response,
			ctx: { env: { ...env, MOCK_GOG_COMPLETION_DELAY_MS: "0" } },
		});
		assert.equal(replay.ok, false);
		assert.match(replay.error?.message ?? "", /Pipeline resume state not found/);
		invocations = (await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/);
		assert.equal(invocations.length, 1, "retrying an aborted input token must not resend");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow approval resume cannot replay a send after downstream cancellation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-approval-cancel-replay-"));
	try {
		const repoRoot = join(__dirname, "..", "..");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const filePath = join(dir, "workflow.lobster");
		const stateDir = join(dir, "state");
		const sendCompleted = join(dir, "send-completed");
		const sendInvocations = join(dir, "send-invocations");
		const searchStarted = join(dir, "search-started");
		const searchTerminated = join(dir, "search-terminated");
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{
						id: "draft",
						run: `${JSON.stringify(process.execPath)} -e "process.stdout.write(JSON.stringify({to:'user@example.com',subject:'Hello',body:'World'}))"`,
					},
					{ id: "confirm", approval: "Send?", stdin: "$draft.json" },
					{
						id: "send",
						pipeline: "gog.gmail.send",
						stdin: "$draft.json",
						when: "$confirm.approved",
					},
					{
						id: "search",
						pipeline: "gog.gmail.search --query newer_than:1d",
						when: "$confirm.approved",
					},
				],
			}),
			"utf8",
		);
		const env = {
			...process.env,
			LOBSTER_STATE_DIR: stateDir,
			GOG_BIN: mockGog,
			MOCK_GOG_SEND_COMPLETED_FILE: sendCompleted,
			MOCK_GOG_SEND_INVOCATIONS_FILE: sendInvocations,
			MOCK_GOG_SEARCH_STARTED_FILE: searchStarted,
			MOCK_GOG_SEARCH_TERMINATED_FILE: searchTerminated,
			MOCK_GOG_COMPLETION_DELAY_MS: "100",
		};
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });

		assert.equal(first.status, "needs_approval");
		assert.ok(first.requiresApproval?.resumeToken);
		assert.ok(first.requiresApproval.approvalId);
		const controller = new AbortController();
		const resumed = resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { cwd: dir, signal: controller.signal, env },
		});
		await waitForFile(searchStarted, 3000);
		controller.abort();
		const envelope = await resumed;

		assertCancellationEnvelope(envelope);
		await waitForFile(sendCompleted, 1000);
		await waitForFile(searchTerminated, 1000);
		let invocations = (await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/);
		assert.equal(invocations.length, 1);

		const replayById = await resumeToolRequest({
			approvalId: first.requiresApproval.approvalId,
			approved: true,
			ctx: { cwd: dir, env: { ...env, MOCK_GOG_COMPLETION_DELAY_MS: "0" } },
		});
		assert.equal(replayById.ok, false);
		assert.match(replayById.error?.message ?? "", /not found or expired/);
		const replayByToken = await resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { cwd: dir, env: { ...env, MOCK_GOG_COMPLETION_DELAY_MS: "0" } },
		});
		assert.equal(replayByToken.ok, false);
		assert.match(replayByToken.error?.message ?? "", /Workflow resume state not found/);
		invocations = (await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/);
		assert.equal(invocations.length, 1, "retrying an aborted workflow approval must not resend");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("workflow input resume cannot replay a send after downstream cancellation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-workflow-input-cancel-replay-"));
	try {
		const repoRoot = join(__dirname, "..", "..");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const filePath = join(dir, "workflow.lobster");
		const stateDir = join(dir, "state");
		const sendCompleted = join(dir, "send-completed");
		const sendInvocations = join(dir, "send-invocations");
		const searchStarted = join(dir, "search-started");
		const searchTerminated = join(dir, "search-terminated");
		const responseSchema = {
			type: "object",
			properties: {
				to: { type: "string" },
				subject: { type: "string" },
				body: { type: "string" },
			},
			required: ["to", "subject", "body"],
		};
		await writeFile(
			filePath,
			JSON.stringify({
				steps: [
					{ id: "draft", input: { prompt: "Draft?", responseSchema } },
					{ id: "send", pipeline: "gog.gmail.send", stdin: "$draft.response" },
					{
						id: "search",
						pipeline: "gog.gmail.search --query newer_than:1d",
					},
				],
			}),
			"utf8",
		);
		const env = {
			...process.env,
			LOBSTER_STATE_DIR: stateDir,
			GOG_BIN: mockGog,
			MOCK_GOG_SEND_COMPLETED_FILE: sendCompleted,
			MOCK_GOG_SEND_INVOCATIONS_FILE: sendInvocations,
			MOCK_GOG_SEARCH_STARTED_FILE: searchStarted,
			MOCK_GOG_SEARCH_TERMINATED_FILE: searchTerminated,
			MOCK_GOG_COMPLETION_DELAY_MS: "100",
		};
		const response = { to: "user@example.com", subject: "Hello", body: "World" };
		const first = await runToolRequest({ filePath, ctx: { cwd: dir, env } });

		assert.equal(first.status, "needs_input");
		assert.ok(first.requiresInput?.resumeToken);
		const controller = new AbortController();
		const resumed = resumeToolRequest({
			token: first.requiresInput.resumeToken,
			response,
			ctx: { cwd: dir, signal: controller.signal, env },
		});
		await waitForFile(searchStarted, 3000);
		controller.abort();
		const envelope = await resumed;

		assertCancellationEnvelope(envelope);
		await waitForFile(sendCompleted, 1000);
		await waitForFile(searchTerminated, 1000);
		let invocations = (await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/);
		assert.equal(invocations.length, 1);

		const replay = await resumeToolRequest({
			token: first.requiresInput.resumeToken,
			response,
			ctx: { cwd: dir, env: { ...env, MOCK_GOG_COMPLETION_DELAY_MS: "0" } },
		});
		assert.equal(replay.ok, false);
		assert.match(replay.error?.message ?? "", /Workflow resume state not found/);
		invocations = (await readFile(sendInvocations, "utf8")).trim().split(/\r?\n/);
		assert.equal(invocations.length, 1, "retrying an aborted workflow input must not resend");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test(
	"parent cancellation terminates the default github.pr.monitor subprocess",
	{ skip: process.platform === "win32" },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "lobster-cancel-gh-"));
		try {
			const repoRoot = join(__dirname, "..", "..");
			const mockGh = join(repoRoot, "test", "fixtures", "mock-gh-cancellation.mjs");
			const ghBin = join(dir, "gh");
			const started = join(dir, "gh-started");
			const terminated = join(dir, "gh-terminated");
			const completed = join(dir, "gh-completed");
			await copyFile(mockGh, ghBin);
			await chmod(ghBin, 0o755);
			const controller = new AbortController();
			const run = runToolRequest({
				pipeline:
					'workflows.run --name github.pr.monitor --args-json \'{"repo":"openclaw/lobster","pr":1}\'',
				ctx: {
					signal: controller.signal,
					env: {
						...process.env,
						PATH: `${dir}:${process.env.PATH ?? ""}`,
						LOBSTER_STATE_DIR: join(dir, "state"),
						MOCK_GH_STARTED_FILE: started,
						MOCK_GH_TERMINATED_FILE: terminated,
						MOCK_GH_COMPLETED_FILE: completed,
						MOCK_GH_TERMINATION_DELAY_MS: "1000",
					},
				},
			});

			await waitForFile(started, 5000);
			const childPid = Number(await readFile(started, "utf8"));
			controller.abort();
			const immediate = await observeSettlement(run, 50);
			const observed = await observeSettlement(run, 500);
			const envelope = observed.settled ? observed.value : await run;

			assert.equal(immediate.settled, false, "workflow must wait for gh to exit");
			assert.equal(observed.settled, true, "workflow subprocess should stop after abort");
			assertCancellationEnvelope(envelope);
			await waitForFile(terminated, 500);
			assert.equal(processIsRunning(childPid), false);
			assert.equal(await fileExists(terminated), true);
			assert.equal(await fileExists(completed), false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"cancellation before github.pr.monitor persistence does not advance state",
	{ skip: process.platform === "win32" },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "lobster-cancel-gh-state-"));
		try {
			const repoRoot = join(__dirname, "..", "..");
			const mockGh = join(repoRoot, "test", "fixtures", "mock-gh-cancellation.mjs");
			const ghBin = join(dir, "gh");
			const stateDir = join(dir, "state");
			await copyFile(mockGh, ghBin);
			await chmod(ghBin, 0o755);
			const controller = new AbortController();
			const signal = controller.signal;
			const throwIfAborted = signal.throwIfAborted.bind(signal);
			let signalChecks = 0;
			Object.defineProperty(signal, "throwIfAborted", {
				value() {
					signalChecks += 1;
					if (signalChecks === 4) {
						controller.abort(new Error("abort before monitor state write"));
					}
					throwIfAborted();
				},
			});
			const key = "github.pr:openclaw/lobster#1";

			const envelope = await runToolRequest({
				pipeline:
					'workflows.run --name github.pr.monitor --args-json \'{"repo":"openclaw/lobster","pr":1,"changesOnly":true}\'',
				ctx: {
					signal,
					env: {
						...process.env,
						PATH: `${dir}:${process.env.PATH ?? ""}`,
						LOBSTER_STATE_DIR: stateDir,
						MOCK_GH_COMPLETION_DELAY_MS: "0",
					},
				},
			});

			assertCancellationEnvelope(envelope);
			assert.equal(signalChecks, 4);
			assert.equal(
				await fileExists(keyToPath(stateDir, key)),
				false,
				"cancelled monitor must not persist its snapshot",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);
