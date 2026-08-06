import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { loadWorkflowFile, runWorkflowFile } from "../src/workflows/file.js";
import { createDefaultRegistry } from "../src/commands/registry.js";

async function runWorkflow(
	workflow: unknown,
	opts?: {
		signal?: AbortSignal;
		dryRun?: boolean;
		env?: Record<string, string>;
		llmAdapters?: Record<string, unknown>;
	},
) {
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-step-timeout-"));
	const stateDir = path.join(tmpDir, "state");
	const filePath = path.join(tmpDir, "workflow.lobster");
	await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

	const stderr = new PassThrough();
	const chunks: string[] = [];
	stderr.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));

	const result = await runWorkflowFile({
		filePath,
		ctx: {
			stdin: process.stdin,
			stdout: process.stdout,
			stderr,
			env: { ...process.env, LOBSTER_STATE_DIR: stateDir, ...opts?.env },
			mode: "tool",
			signal: opts?.signal,
			dryRun: opts?.dryRun,
			llmAdapters: opts?.llmAdapters,
			registry: createDefaultRegistry(),
		},
	});

	return { result, stderrOutput: chunks.join("") };
}

async function writeWorkflow(workflow: unknown) {
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-step-timeout-load-"));
	const filePath = path.join(tmpDir, "workflow.lobster");
	await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");
	return filePath;
}

test("timeout_ms validation rejects non-numeric values", async () => {
	const filePath = await writeWorkflow({
		steps: [{ id: "x", command: "echo hi", timeout_ms: "fast" }],
	});
	await assert.rejects(
		() => loadWorkflowFile(filePath),
		/timeout_ms must be a positive integer between 1 and 2147483647/,
	);
});

test("timeout_ms validation rejects 0", async () => {
	const filePath = await writeWorkflow({
		steps: [{ id: "x", command: "echo hi", timeout_ms: 0 }],
	});
	await assert.rejects(
		() => loadWorkflowFile(filePath),
		/timeout_ms must be a positive integer between 1 and 2147483647/,
	);
});

test("timeout_ms validation rejects non-integer values", async () => {
	const filePath = await writeWorkflow({
		steps: [{ id: "x", command: "echo hi", timeout_ms: 1.5 }],
	});
	await assert.rejects(
		() => loadWorkflowFile(filePath),
		/timeout_ms must be a positive integer between 1 and 2147483647/,
	);
});

test("timeout_ms validation rejects values above Node timer max", async () => {
	const filePath = await writeWorkflow({
		steps: [{ id: "x", command: "echo hi", timeout_ms: 2_147_483_648 }],
	});
	await assert.rejects(
		() => loadWorkflowFile(filePath),
		/timeout_ms must be a positive integer between 1 and 2147483647/,
	);
});

test("on_error validation rejects unsupported values", async () => {
	const filePath = await writeWorkflow({
		steps: [{ id: "x", command: "echo hi", on_error: "retry" }],
	});
	await assert.rejects(
		() => loadWorkflowFile(filePath),
		/on_error must be "stop", "continue", or "skip_rest"/,
	);
});

test("timed-out step fails by default (on_error: stop)", async () => {
	await assert.rejects(
		() =>
			runWorkflow({
				steps: [{ id: "slow", command: 'node -e "setTimeout(() => {}, 5000)"', timeout_ms: 100 }],
			}),
		/timed out after 100ms/,
	);
});

test("timed-out step with on_error: continue records error and continues", async () => {
	const { result } = await runWorkflow({
		steps: [
			{
				id: "slow",
				command: 'node -e "setTimeout(() => {}, 5000)"',
				timeout_ms: 100,
				on_error: "continue",
			},
			{ id: "after", command: 'node -e "process.stdout.write(JSON.stringify({ok:true}))"' },
		],
	});
	assert.equal(result.status, "ok");
	assert.deepEqual(result.output, [{ ok: true }]);
});

test("timed-out step with on_error: skip_rest stops remaining steps", async () => {
	const { result } = await runWorkflow({
		steps: [
			{ id: "start", command: 'node -e "process.stdout.write(JSON.stringify({kept:true}))"' },
			{
				id: "slow",
				command: 'node -e "setTimeout(() => {}, 5000)"',
				timeout_ms: 100,
				on_error: "skip_rest",
			},
			{ id: "after", command: 'node -e "process.stdout.write(JSON.stringify({shouldRun:false}))"' },
		],
	});
	assert.equal(result.status, "ok");
	assert.deepEqual(result.output, [{ kept: true }]);
});

test("step error marker is available to conditions after on_error: continue", async () => {
	const { result } = await runWorkflow({
		steps: [
			{
				id: "slow",
				command: 'node -e "setTimeout(() => {}, 5000)"',
				timeout_ms: 100,
				on_error: "continue",
			},
			{
				id: "check",
				command:
					'node -e "process.stdout.write(JSON.stringify({timedOut: process.env.TIMED_OUT}))"',
				env: {
					TIMED_OUT: "$slow.error",
				},
				when: "$slow.error == true",
			},
		],
	});
	assert.equal(result.status, "ok");
	assert.deepEqual(result.output, [{ timedOut: "true" }]);
});

test("external abort still propagates when timeout is configured", async () => {
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		() =>
			runWorkflow(
				{
					steps: [
						{
							id: "slow",
							command: 'node -e "setTimeout(() => {}, 5000)"',
							timeout_ms: 5000,
							on_error: "continue",
						},
					],
				},
				{ signal: controller.signal },
			),
		(err: any) => err?.name === "AbortError" || err?.code === "ABORT_ERR",
	);
});

test("timed-out llm.invoke step stops waiting for the adapter", { timeout: 20_000 }, async () => {
	const sockets = new Set<import("node:net").Socket>();
	let markClosed = () => {};
	const requestClosed = new Promise<void>((resolve) => (markClosed = resolve));

	// An adapter that accepts the request and never answers.
	const server = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => res.on("close", () => markClosed()));
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;

	try {
		const started = Date.now();
		await assert.rejects(
			() =>
				runWorkflow(
					{
						steps: [
							{
								id: "ask",
								pipeline: 'llm.invoke --prompt "Summarize" --disable-cache',
								timeout_ms: 300,
							},
						],
					},
					{ env: { LOBSTER_LLM_ADAPTER_URL: `http://127.0.0.1:${port}/invoke` } },
				),
			/timed out after 300ms/,
		);
		assert.ok(Date.now() - started < 10_000, "the step must not wait for the adapter");
		await requestClosed;
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("dry-run renders timeout and on_error details", async () => {
	const { stderrOutput } = await runWorkflow(
		{
			steps: [
				{
					id: "fetch",
					command: "curl https://example.com",
					timeout_ms: 5000,
					on_error: "continue",
				},
			],
		},
		{ dryRun: true },
	);
	assert.match(stderrOutput, /timeout: 5000ms/);
	assert.match(stderrOutput, /on_error: continue/);
});

test(
	"external abort with a custom reason still stops the workflow",
	{ timeout: 20_000 },
	async () => {
		let invoked = () => {};
		const adapterInvoked = new Promise<void>((resolve) => (invoked = resolve));
		// Ignores ctx.signal, so what the runner classifies is llm.invoke's own
		// abort rejection rather than a cancelled socket.
		const stubborn = {
			invoke() {
				invoked();
				return new Promise<never>(() => {});
			},
		};

		const controller = new AbortController();
		// A host may abort with any reason. A plain Error must still read as
		// cancellation, not as an ordinary step failure.
		void adapterInvoked.then(() => controller.abort(new Error("cancelled by host")));

		await assert.rejects(
			() =>
				runWorkflow(
					{
						steps: [
							{
								id: "ask",
								// on_error: continue is what makes a misclassified abort
								// visible -- the run would otherwise report success.
								pipeline: 'llm.invoke --provider stubborn --prompt "Summarize" --disable-cache',
								on_error: "continue",
							},
						],
					},
					{ signal: controller.signal, llmAdapters: { stubborn } },
				),
			(err: any) =>
				(err?.name === "AbortError" || err?.code === "ABORT_ERR") &&
				/cancelled by host/.test(String(err?.message)),
		);
	},
);
