import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { resumeToolRequest, runToolRequest } from "../src/core/tool_runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function streamOf(items: unknown[]) {
	return (async function* () {
		for (const item of items) yield item;
	})();
}

async function fileExists(path: string) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
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

test("parent cancellation terminates gog.gmail.search and skips gog.gmail.send", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-cancel-search-"));
	try {
		const repoRoot = join(__dirname, "..", "..");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const searchStarted = join(dir, "search-started");
		const searchTerminated = join(dir, "search-terminated");
		const searchCompleted = join(dir, "search-completed");
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
					MOCK_GOG_SEND_STARTED_FILE: sendStarted,
					MOCK_GOG_SEND_COMPLETED_FILE: sendCompleted,
					MOCK_GOG_TERMINATION_DELAY_MS: "1000",
				},
			},
		});

		await waitForFile(searchStarted);
		const childPid = Number(await readFile(searchStarted, "utf8"));
		const abortedAt = Date.now();
		controller.abort();
		const immediate = await observeSettlement(run, 50);
		const observed = await observeSettlement(run, 500);
		const envelope = observed.settled ? observed.value : await run;

		assert.equal(immediate.settled, false, "workflow must wait for the child to exit");
		assert.equal(observed.settled, true, "workflow should settle promptly after parent abort");
		assertCancellationEnvelope(envelope);
		await waitForFile(searchTerminated, 500);
		assert.equal(processIsRunning(childPid), false);
		assert.equal(await fileExists(searchTerminated), true);
		assert.equal(await fileExists(searchCompleted), false);
		assert.equal(await fileExists(sendStarted), false);
		assert.equal(await fileExists(sendCompleted), false);
		if (observed.settled) assert.ok(observed.settledAt - abortedAt < 500);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

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
	assert.equal(envelope.ok, true);
	assert.deepEqual(envelope.output, [{ ok: true }]);
	assert.equal(downstreamStarted, false, "cleanup cancellation must stop the next stage");
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
		assert.equal(envelope.ok, true);
		assert.deepEqual(envelope.output, [{ ok: true }]);
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

test("approval resume token remains retryable after a non-abort failure", async () => {
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

		const retried = await resumeToolRequest({
			token: first.requiresApproval.resumeToken,
			approved: true,
			ctx: { registry, env },
		});
		assert.equal(retried.ok, true);
		assert.deepEqual(retried.output, [{ value: 1 }]);
		assert.equal(attempts, 2);
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

			await waitForFile(started);
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
