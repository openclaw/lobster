import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { runToolRequest } from "../src/core/tool_runtime.js";
import { finalizePipelineToolRun } from "../src/pipeline_resume_state.js";

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

function withCommand(defaultRegistry: ReturnType<typeof createDefaultRegistry>, command: any) {
	return {
		get(name: string) {
			return name === command.name ? command : defaultRegistry.get(name);
		},
	};
}

function assertCancellationEnvelope(envelope: Awaited<ReturnType<typeof runToolRequest>>) {
	assert.equal(envelope.ok, false);
	assert.equal(envelope.status, undefined);
	assert.equal(envelope.error?.type, "runtime_error");
	assert.match(envelope.error?.message ?? "", /abort/i);
}

function abortOnCheck(controller: AbortController, abortAtCall: number) {
	let checks = 0;
	return {
		get aborted() {
			return controller.signal.aborted;
		},
		get reason() {
			return controller.signal.reason;
		},
		throwIfAborted() {
			checks += 1;
			if (checks === abortAtCall) controller.abort();
			controller.signal.throwIfAborted();
		},
	} as AbortSignal;
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
				},
			},
		});

		await waitForFile(searchStarted);
		const abortedAt = Date.now();
		controller.abort();
		const observed = await observeSettlement(run, 500);
		const envelope = observed.settled ? observed.value : await run;

		assert.equal(observed.settled, true, "workflow should settle promptly after parent abort");
		assertCancellationEnvelope(envelope);
		await waitForFile(searchTerminated, 500);
		assert.equal(await fileExists(searchTerminated), true);
		assert.equal(await fileExists(searchCompleted), false);
		assert.equal(await fileExists(sendStarted), false);
		assert.equal(await fileExists(sendCompleted), false);
		if (observed.settled) assert.ok(observed.settledAt - abortedAt < 500);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("parent cancellation terminates an in-flight gog.gmail.send", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-cancel-send-"));
	try {
		const repoRoot = join(__dirname, "..", "..");
		const mockGog = join(repoRoot, "test", "fixtures", "mock-gog-cancellation.mjs");
		const sendStarted = join(dir, "send-started");
		const sendTerminated = join(dir, "send-terminated");
		const sendCompleted = join(dir, "send-completed");
		const controller = new AbortController();
		const defaultRegistry = createDefaultRegistry();
		const source = {
			name: "draft",
			async run() {
				return {
					output: streamOf([{ to: "user@example.com", subject: "Reply", body: "Hello" }]),
				};
			},
		};
		const run = runToolRequest({
			pipeline: "draft | gog.gmail.send",
			ctx: {
				registry: withCommand(defaultRegistry, source),
				signal: controller.signal,
				env: {
					...process.env,
					GOG_BIN: mockGog,
					MOCK_GOG_SEND_STARTED_FILE: sendStarted,
					MOCK_GOG_SEND_TERMINATED_FILE: sendTerminated,
					MOCK_GOG_SEND_COMPLETED_FILE: sendCompleted,
				},
			},
		});

		await waitForFile(sendStarted);
		controller.abort();
		const observed = await observeSettlement(run, 500);
		const envelope = observed.settled ? observed.value : await run;

		assert.equal(observed.settled, true, "send should settle promptly after parent abort");
		assertCancellationEnvelope(envelope);
		await waitForFile(sendTerminated, 500);
		assert.equal(await fileExists(sendTerminated), true);
		assert.equal(await fileExists(sendCompleted), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an abort between pipeline stages prevents the next stage from starting", async () => {
	let slowStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		slowStarted = resolve;
	});
	let sideEffectRan = false;
	const controller = new AbortController();
	const commands = new Map([
		[
			"slow",
			{
				name: "slow",
				async run() {
					slowStarted();
					await new Promise((resolve) => setTimeout(resolve, 100));
					return { output: streamOf(["ready"]) };
				},
			},
		],
		[
			"side-effect",
			{
				name: "side-effect",
				async run({ input }: any) {
					for await (const _item of input) {
						// Drain input before the side effect.
					}
					sideEffectRan = true;
					return { output: streamOf([]) };
				},
			},
		],
	]);
	const run = runToolRequest({
		pipeline: "slow | side-effect",
		ctx: {
			signal: controller.signal,
			registry: { get: (name: string) => commands.get(name) },
		},
	});

	await started;
	controller.abort();
	const envelope = await run;

	assertCancellationEnvelope(envelope);
	assert.equal(sideEffectRan, false);
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
					},
				},
			});

			await waitForFile(started);
			controller.abort();
			const observed = await observeSettlement(run, 500);
			const envelope = observed.settled ? observed.value : await run;

			assert.equal(observed.settled, true, "workflow subprocess should stop after abort");
			assertCancellationEnvelope(envelope);
			await waitForFile(terminated, 500);
			assert.equal(await fileExists(terminated), true);
			assert.equal(await fileExists(completed), false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("parent cancellation wins over a terminal input suspension", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-cancel-input-"));
	try {
		const stateDir = join(dir, "state");
		let generatorStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			generatorStarted = resolve;
		});
		const controller = new AbortController();
		const terminal = {
			name: "terminal-input",
			async run({ ctx }: any) {
				return {
					output: (async function* () {
						yield* [];
						generatorStarted();
						await new Promise((resolve) => setTimeout(resolve, 100));
						await ctx.requestInput({
							prompt: "Continue?",
							responseSchema: { type: "object" },
						});
					})(),
				};
			},
		};
		const run = runToolRequest({
			pipeline: "terminal-input",
			ctx: {
				signal: controller.signal,
				registry: { get: (name: string) => (name === terminal.name ? terminal : undefined) },
				env: { ...process.env, LOBSTER_STATE_DIR: stateDir },
			},
		});

		await started;
		controller.abort();
		const envelope = await run;
		const stateEntries = (await fileExists(stateDir))
			? await readdir(stateDir, { recursive: true })
			: [];

		assertCancellationEnvelope(envelope);
		assert.equal(stateEntries.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("input finalization removes resume state when cancellation wins the write race", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-cancel-input-finalize-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const controller = new AbortController();

		await assert.rejects(
			() =>
				finalizePipelineToolRun({
					env,
					pipeline: [{ name: "ask", args: {}, raw: "ask" }],
					output: {
						halted: true,
						haltedAt: { index: 0 },
						items: [
							{
								type: "input_request",
								prompt: "Continue?",
								responseSchema: { type: "object" },
							},
						],
					},
					signal: abortOnCheck(controller, 2),
				}),
			(err: any) => err?.name === "AbortError",
		);

		const stateEntries = (await fileExists(stateDir))
			? await readdir(stateDir, { recursive: true })
			: [];
		assert.equal(stateEntries.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("approval finalization removes resume state and index when cancellation wins", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-cancel-approval-finalize-"));
	try {
		const stateDir = join(dir, "state");
		const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };
		const controller = new AbortController();

		await assert.rejects(
			() =>
				finalizePipelineToolRun({
					env,
					pipeline: [{ name: "approve", args: {}, raw: "approve" }],
					output: {
						halted: true,
						haltedAt: { index: 0 },
						items: [
							{
								type: "approval_request",
								prompt: "Approve?",
								items: [{ id: 1 }],
							},
						],
					},
					signal: abortOnCheck(controller, 3),
				}),
			(err: any) => err?.name === "AbortError",
		);

		const stateEntries = (await fileExists(stateDir))
			? await readdir(stateDir, { recursive: true })
			: [];
		assert.equal(stateEntries.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
