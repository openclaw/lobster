import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { CostTracker } from "../src/core/cost_tracker.js";
import {
	createLlmSpendLedger,
	llmProvenanceOf,
	restoreLlmProvenance,
} from "../src/commands/stdlib/llm_invoke.js";
import type { LlmOutstandingCharge } from "../src/commands/stdlib/llm_invoke.js";
import { runWorkflowFile } from "../src/workflows/file.js";
import { decodeToken } from "../src/token.js";

test("CostTracker records usage and computes totals", () => {
	const tracker = new CostTracker();
	tracker.recordUsage("step1", "gpt-4o", { inputTokens: 1000, outputTokens: 500 });
	const summary = tracker.getSummary();
	assert.equal(summary.totalInputTokens, 1000);
	assert.equal(summary.totalOutputTokens, 500);
	assert.equal(summary.estimatedCostUsd, 0.0075);
	assert.equal(summary.byStep.length, 1);
	assert.equal(summary.byStep[0].stepId, "step1");
});

test("CostTracker handles OpenAI token field names", () => {
	const tracker = new CostTracker();
	tracker.recordUsage("step1", "gpt-4o", { prompt_tokens: 1000, completion_tokens: 500 });
	const summary = tracker.getSummary();
	assert.equal(summary.totalInputTokens, 1000);
	assert.equal(summary.totalOutputTokens, 500);
});

function captureWritable() {
	const stream = new PassThrough();
	let output = "";
	stream.on("data", (d: Buffer | string) => {
		output += String(d);
	});
	return { stream, output: () => output };
}

test("CostTracker uses zero cost for unknown models and warns once", () => {
	const stderr = captureWritable();
	const tracker = new CostTracker(undefined, stderr.stream);
	tracker.recordUsage("step1", "unknown-model", { inputTokens: 1000, outputTokens: 500 });
	tracker.recordUsage("step2", "unknown-model", { inputTokens: 1000, outputTokens: 500 });
	const summary = tracker.getSummary();
	assert.equal(summary.estimatedCostUsd, 0);
	assert.equal(
		stderr.output().match(/No LLM pricing configured for model "unknown-model"/g)?.length,
		1,
	);
});

test("CostTracker warns when usage omits the model id", () => {
	const stderr = captureWritable();
	const tracker = new CostTracker({ "": { input: 100, output: 100 } }, stderr.stream);
	tracker.recordUsage("step1", null, { inputTokens: 1000, outputTokens: 500 });
	tracker.recordUsage("step2", "", { inputTokens: 1000, outputTokens: 500 });
	tracker.recordUsage("step3", "   ", { inputTokens: 1000, outputTokens: 500 });
	const summary = tracker.getSummary();
	assert.equal(summary.estimatedCostUsd, 0);
	assert.equal(stderr.output().match(/model "<missing>"/g)?.length, 1);
});

test("CostTracker treats inherited object keys as unknown model ids", () => {
	const stderr = captureWritable();
	const tracker = new CostTracker(undefined, stderr.stream);
	tracker.recordUsage("step1", "constructor", { inputTokens: 1000, outputTokens: 500 });
	const summary = tracker.getSummary();
	assert.equal(summary.estimatedCostUsd, 0);
	assert.equal(Number.isNaN(summary.byStep[0].costUsd), false);
	assert.match(stderr.output(), /No LLM pricing configured for model "constructor"/);
});

test("CostTracker warns when pricing env json is invalid", () => {
	const stderr = captureWritable();
	const pricing = CostTracker.parsePricingFromEnv(
		{
			LOBSTER_LLM_PRICING_JSON: "{not-json",
		},
		stderr.stream,
	);
	assert.equal(pricing, undefined);
	assert.match(stderr.output(), /Ignoring invalid LOBSTER_LLM_PRICING_JSON/);
});

test("CostTracker rejects structurally invalid pricing env json", () => {
	const stderr = captureWritable();
	const pricing = CostTracker.parsePricingFromEnv(
		{
			LOBSTER_LLM_PRICING_JSON: '{"my-model":{"input":1.0}}',
		},
		stderr.stream,
	);
	assert.equal(pricing, undefined);
	assert.match(stderr.output(), /Ignoring invalid LOBSTER_LLM_PRICING_JSON/);
});

test("CostTracker rejects blank pricing model keys", () => {
	const stderr = captureWritable();
	const pricing = CostTracker.parsePricingFromEnv(
		{
			LOBSTER_LLM_PRICING_JSON: '{"":{"input":1.0,"output":2.0}}',
		},
		stderr.stream,
	);
	assert.equal(pricing, undefined);
	assert.match(stderr.output(), /Ignoring invalid LOBSTER_LLM_PRICING_JSON/);
});

test("CostTracker supports custom pricing from env json", () => {
	const pricing = CostTracker.parsePricingFromEnv({
		LOBSTER_LLM_PRICING_JSON: '{"my-model":{"input":1.0,"output":2.0}}',
	});
	const tracker = new CostTracker(pricing);
	tracker.recordUsage("step1", "my-model", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
	assert.equal(tracker.getSummary().estimatedCostUsd, 3);
});

test("CostTracker checkLimit throws when action=stop and limit exceeded", () => {
	const tracker = new CostTracker();
	tracker.recordUsage("step1", "gpt-4o", { inputTokens: 10_000_000, outputTokens: 10_000_000 });
	assert.throws(() => tracker.checkLimit({ max_usd: 0.01, action: "stop" }), /Cost limit exceeded/);
});

test("CostTracker checkLimit warns when action=warn and limit exceeded", () => {
	const tracker = new CostTracker();
	tracker.recordUsage("step1", "gpt-4o", { inputTokens: 10_000_000, outputTokens: 10_000_000 });
	const stderr = new PassThrough();
	let out = "";
	stderr.on("data", (d: Buffer | string) => {
		out += String(d);
	});
	tracker.checkLimit({ max_usd: 0.01, action: "warn" }, stderr);
	assert.match(out, /\[WARN\] Cost/);
});

async function runWorkflow(
	workflow: unknown,
	envOverride?: Record<string, string>,
	llmAdapters?: Record<string, unknown>,
) {
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-"));
	const stateDir = path.join(tmpDir, "state");
	const filePath = path.join(tmpDir, "workflow.lobster");
	await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");
	const stderr = new PassThrough();
	let stderrOutput = "";
	stderr.on("data", (d: Buffer | string) => {
		stderrOutput += String(d);
	});

	const result = await runWorkflowFile({
		filePath,
		ctx: {
			stdin: process.stdin,
			stdout: process.stdout,
			stderr,
			env: { ...process.env, LOBSTER_STATE_DIR: stateDir, ...envOverride },
			mode: "tool",
			registry: createDefaultRegistry(),
			llmAdapters,
		},
	});

	return { result, stderrOutput };
}

test("workflow result includes _meta.cost when usage is present", async () => {
	const { result } = await runWorkflow({
		steps: [
			{
				id: "llm",
				command:
					"node -e \"process.stdout.write(JSON.stringify({model:'gpt-4o',usage:{inputTokens:100,outputTokens:50},output:{text:'hi'}}))\"",
			},
		],
	});

	assert.equal(result.status, "ok");
	assert.ok(result._meta?.cost);
	assert.equal(result._meta!.cost!.totalInputTokens, 100);
	assert.equal(result._meta!.cost!.totalOutputTokens, 50);
	assert.equal(result._meta!.cost!.byStep[0].model, "gpt-4o");
});

test("workflow result omits _meta.cost when no usage exists", async () => {
	const { result } = await runWorkflow({
		steps: [{ id: "plain", command: 'echo "hello"' }],
	});
	assert.equal(result.status, "ok");
	assert.equal(result._meta, undefined);
});

test("cost_limit warn logs warning and continues", async () => {
	const { result, stderrOutput } = await runWorkflow({
		cost_limit: { max_usd: 0.00001, action: "warn" },
		steps: [
			{
				id: "llm",
				command:
					"node -e \"process.stdout.write(JSON.stringify({model:'gpt-4o',usage:{inputTokens:1000,outputTokens:1000}}))\"",
			},
			{ id: "after", command: "echo done" },
		],
	});
	assert.equal(result.status, "ok");
	assert.match(stderrOutput, /\[WARN\] Cost/);
	assert.deepEqual(result.output, ["done\n"]);
});

test("cost_limit stop throws when exceeded", async () => {
	await assert.rejects(
		() =>
			runWorkflow({
				cost_limit: { max_usd: 0.00001, action: "stop" },
				steps: [
					{
						id: "llm",
						command:
							"node -e \"process.stdout.write(JSON.stringify({model:'gpt-4o',usage:{inputTokens:1000,outputTokens:1000}}))\"",
					},
				],
			}).then((x) => x.result),
		/Cost limit exceeded/,
	);
});

test("workflow cost tracking warns for unknown model ids", async () => {
	const { result, stderrOutput } = await runWorkflow({
		cost_limit: { max_usd: 0.00001, action: "warn" },
		steps: [
			{
				id: "llm",
				command:
					"node -e \"process.stdout.write(JSON.stringify({model:'unknown-model',usage:{inputTokens:1000,outputTokens:1000}}))\"",
			},
		],
	});

	assert.equal(result.status, "ok");
	assert.equal(result._meta?.cost?.estimatedCostUsd, 0);
	assert.match(stderrOutput, /No LLM pricing configured for model "unknown-model"/);
});

test("workflow cost tracking warns for invalid pricing env json", async () => {
	const { result, stderrOutput } = await runWorkflow(
		{
			steps: [
				{
					id: "llm",
					command:
						"node -e \"process.stdout.write(JSON.stringify({model:'gpt-4o',usage:{inputTokens:1000,outputTokens:1000}}))\"",
				},
			],
		},
		{ LOBSTER_LLM_PRICING_JSON: "{not-json" },
	);

	assert.equal(result.status, "ok");
	assert.match(stderrOutput, /Ignoring invalid LOBSTER_LLM_PRICING_JSON/);
});

test("workflow cost tracking warns when usage omits the model id", async () => {
	const { result, stderrOutput } = await runWorkflow({
		steps: [
			{
				id: "llm",
				command:
					'node -e "process.stdout.write(JSON.stringify({usage:{inputTokens:1000,outputTokens:1000}}))"',
			},
		],
	});

	assert.equal(result.status, "ok");
	assert.equal(result._meta?.cost?.estimatedCostUsd, 0);
	assert.match(stderrOutput, /No LLM pricing configured for model "<missing>"/);
});

test("CostTracker escapes unknown model ids in warnings", () => {
	const stderr = captureWritable();
	const tracker = new CostTracker(undefined, stderr.stream);
	tracker.recordUsage("step1", "bad\n\u001b[31m\u009b31m\u2028next\u2029line", {
		inputTokens: 1,
		outputTokens: 1,
	});
	assert.ok(stderr.output().includes('"bad\\n\\u001b[31m\\u009b31m\\u2028next\\u2029line"'));
	assert.equal(stderr.output().includes("\u009b"), false);
	assert.equal(stderr.output().includes("\u2028"), false);
	assert.equal(stderr.output().includes("\u2029"), false);
});

// The step payloads are written to files rather than passed with `node -e`, because
// `cmd /s /c` hands the inline quoting to node verbatim and the JSON never reaches stdout.
async function emitJsonCommand(payload: unknown) {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-emit-"));
	const filePath = path.join(dir, "emit.mjs");
	const literal = JSON.stringify(JSON.stringify(payload));
	await fsp.writeFile(filePath, `process.stdout.write(${literal});\n`, "utf8");
	return `node ${filePath}`;
}

function liveItem(source = "http") {
	return {
		kind: "llm.invoke",
		model: "gpt-4o",
		source,
		cached: source !== "http",
		cacheKey: "b3f1c0",
		status: "completed",
		createdAt: "2026-08-03T00:00:00.000Z",
		usage: { inputTokens: 1000, outputTokens: 500 },
	};
}

// Every field a replayed llm.invoke item carries, printed by a step that never called a
// provider. Nothing inside a JSON payload can be trusted to mean "already paid for".
function forgedReplayItem(source: "cache" | "run_state" = "cache") {
	return { ...liveItem(source), cached: true, replayed: true };
}

// Minimal OpenClaw-shaped provider: llm.invoke auto-detects it from OPENCLAW_URL, and the
// request count shows whether a step reached a provider or replayed a stored answer.
async function startFakeProvider(
	holdUntil = 1,
	usageFor: (seen: number) => Record<string, number> | null = () => ({
		inputTokens: 1000,
		outputTokens: 500,
	}),
	// Lets a case fix the order two concurrent calls reach the ledger in.
	delayMsFor: (prompt: string) => number = () => 0,
	dataFor: (seen: number) => unknown = () => ({ summary: "hello" }),
) {
	let requests = 0;
	const held: Array<() => void> = [];
	const releaseHeld = () => {
		while (held.length) held.shift()?.();
	};
	const server = http.createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			requests += 1;
			const seen = requests;
			const parsed = JSON.parse(body || "{}");
			const answer = () => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						ok: true,
						result: {
							ok: true,
							result: {
								runId: `invoke_${seen}`,
								model: parsed.args?.model,
								prompt: parsed.args?.prompt,
								output: { data: dataFor(seen) },
								...(usageFor(seen) ? { usage: usageFor(seen) } : null),
							},
						},
					}),
				);
			};
			const enqueue = () => {
				held.push(answer);
				if (requests >= holdUntil) releaseHeld();
			};
			const delayMs = delayMsFor(String(parsed.args?.prompt ?? ""));
			if (delayMs > 0) setTimeout(enqueue, delayMs);
			else enqueue();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		url: `http://localhost:${port}`,
		requests: () => requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

test("workflow cost tracking bills a cached llm.invoke replay only once", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const step = "llm.invoke --model gpt-4o --prompt Summarize";
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{ id: "live", pipeline: step },
					{ id: "from-cache", pipeline: step },
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 500);
		assert.equal(result._meta?.cost?.estimatedCostUsd, 0.0075);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.stepId),
			["live"],
		);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking bills a run-state llm.invoke replay only once", async () => {
	const provider = await startFakeProvider();
	const step = "llm.invoke --disable-cache --model gpt-4o --prompt Summarize";
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{ id: "live", pipeline: step },
					{ id: "from-run-state", pipeline: step },
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_RUN_STATE_KEY: "cost-tracker-replay" },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.stepId),
			["live"],
		);
	} finally {
		await provider.close();
	}
});

test("cost_limit stop is not tripped by a replayed llm.invoke", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const step = "llm.invoke --model gpt-4o --prompt Summarize";
	try {
		const { result } = await runWorkflow(
			{
				cost_limit: { max_usd: 0.01, action: "stop" },
				steps: [
					{ id: "live", pipeline: step },
					{ id: "from-cache", pipeline: step },
					{ id: "after", command: "echo done" },
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(result._meta?.cost?.estimatedCostUsd, 0.0075);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

test("cost_limit stop still trips on repeated live calls", async () => {
	const live = await emitJsonCommand(liveItem());
	await assert.rejects(
		() =>
			runWorkflow({
				cost_limit: { max_usd: 0.01, action: "stop" },
				steps: [
					{ id: "live", command: live },
					{ id: "live-again", command: live },
				],
			}).then((x) => x.result),
		/Cost limit exceeded/,
	);
});

test("workflow cost tracking bills a live call from an adapter named like a replay source", async () => {
	const { result } = await runWorkflow({
		steps: [
			{ id: "live-cache-provider", command: await emitJsonCommand(liveItem("cache")) },
			{ id: "live-run-state-provider", command: await emitJsonCommand(liveItem("run_state")) },
		],
	});

	assert.equal(result.status, "ok");
	assert.equal(result._meta?.cost?.totalInputTokens, 2000);
	assert.deepEqual(
		result._meta?.cost?.byStep.map((entry) => entry.stepId),
		["live-cache-provider", "live-run-state-provider"],
	);
});

test("workflow cost tracking bills a step that prints the full replay shape", async () => {
	const { result } = await runWorkflow({
		steps: [
			{ id: "forged-cache", command: await emitJsonCommand(forgedReplayItem("cache")) },
			{ id: "forged-run-state", command: await emitJsonCommand(forgedReplayItem("run_state")) },
			{
				id: "partial-shape",
				command: await emitJsonCommand({
					replayed: true,
					model: "gpt-4o",
					usage: { inputTokens: 1000, outputTokens: 500 },
				}),
			},
		],
	});

	assert.equal(result.status, "ok");
	assert.equal(result._meta?.cost?.totalInputTokens, 3000);
	assert.deepEqual(
		result._meta?.cost?.byStep.map((entry) => entry.stepId),
		["forged-cache", "forged-run-state", "partial-shape"],
	);
});

test("cost_limit stop cannot be bypassed by a step that prints the full replay shape", async () => {
	const live = await emitJsonCommand(liveItem());
	const forged = await emitJsonCommand(forgedReplayItem());

	await assert.rejects(
		() =>
			runWorkflow({
				cost_limit: { max_usd: 0.01, action: "stop" },
				steps: [
					{ id: "live", command: live },
					{ id: "forged-replay", command: forged },
				],
			}).then((x) => x.result),
		/Cost limit exceeded/,
	);
});

test("cost_limit stop cannot be bypassed by copying a settled call's public fields", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const copy = await copyJsonStdinPath();
	try {
		await assert.rejects(
			() =>
				runWorkflow(
					{
						cost_limit: { max_usd: 0.01, action: "stop" },
						steps: [
							{
								id: "live",
								pipeline: "llm.invoke --model gpt-4o --prompt Summarize",
							},
							{
								id: "public-copy",
								pipeline: `exec --stdin json --json=true node ${copy}`,
								stdin: "$live.json",
							},
						],
					},
					{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
				).then((x) => x.result),
			/Cost limit exceeded/,
		);
		assert.equal(provider.requests(), 1);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

// `... | json` is a supported step shape: the renderer prints the items and returns an empty
// stream, so the workflow reads the step's JSON back from stdout. Accounting must still tell a
// replay from a live call there, and must still bill output that only looks replayed.
// Runs a parent workflow that composes a child through a `workflow:` step. Both files live in
// one directory so the parent can name the child by relative path.
async function runComposedWorkflow(
	parent: Record<string, unknown>,
	child: unknown,
	envOverride?: Record<string, string>,
) {
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-"));
	const stateDir = path.join(tmpDir, "state");
	const parentPath = path.join(tmpDir, "workflow.lobster");
	const childPath = path.join(tmpDir, "child.lobster");
	await fsp.writeFile(parentPath, JSON.stringify(parent, null, 2), "utf8");
	await fsp.writeFile(childPath, JSON.stringify(child, null, 2), "utf8");
	const stderr = new PassThrough();
	let stderrOutput = "";
	stderr.on("data", (d: Buffer | string) => {
		stderrOutput += String(d);
	});

	const result = await runWorkflowFile({
		filePath: parentPath,
		ctx: {
			stdin: process.stdin,
			stdout: process.stdout,
			stderr,
			env: { ...process.env, LOBSTER_STATE_DIR: stateDir, ...envOverride },
			mode: "tool",
			registry: createDefaultRegistry(),
		},
	});

	return { result, stderrOutput };
}

test("workflow cost tracking bills a live call a nested workflow made", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	try {
		const { result } = await runComposedWorkflow(
			{ steps: [{ id: "child", workflow: "child.lobster" }] },
			{ steps: [{ id: "llm", pipeline: "llm.invoke --model gpt-4o --prompt Summarize | json" }] },
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		// The composing run counts the spend its child handed back, exactly once.
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 500);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.stepId),
			["child"],
		);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking bills a cached replay a nested workflow returned only once", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const step = "llm.invoke --model gpt-4o --prompt Summarize | json";
	try {
		const { result } = await runComposedWorkflow(
			{
				steps: [
					{ id: "live", pipeline: step },
					{ id: "child", workflow: "child.lobster" },
				],
			},
			{ steps: [{ id: "llm", pipeline: step }] },
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		// The child replayed the answer the parent already paid for; billing it again would
		// charge the run for tokens no provider was asked to spend.
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 500);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.stepId),
			["live"],
		);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

test("cost_limit stop is not tripped by a replay a nested workflow returned", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const step = "llm.invoke --model gpt-4o --prompt Summarize | json";
	try {
		const { result } = await runComposedWorkflow(
			{
				cost_limit: { max_usd: 0.01, action: "stop" },
				steps: [
					{ id: "live", pipeline: step },
					{ id: "child", workflow: "child.lobster" },
				],
			},
			{ steps: [{ id: "llm", pipeline: step }] },
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		// One call is $0.0075; billing the child's replay too would exceed the $0.01 limit.
		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(result._meta?.cost?.estimatedCostUsd, 0.0075);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking bills a nested workflow that prints the full replay shape", async () => {
	const emitPath = await emitJsonPath(forgedReplayItem());
	const { result } = await runComposedWorkflow(
		{ steps: [{ id: "child", workflow: "child.lobster" }] },
		{ steps: [{ id: "forged", command: `node ${emitPath}` }] },
	);

	// Nothing a child prints can exempt itself: provenance is a symbol this process attaches.
	assert.equal(result.status, "ok");
	assert.equal(result._meta?.cost?.totalInputTokens, 1000);
	assert.equal(result._meta?.cost?.totalOutputTokens, 500);
});

async function emitJsonPath(payload: unknown) {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-emit-"));
	const filePath = path.join(dir, "emit.mjs");
	const literal = JSON.stringify(JSON.stringify(payload));
	await fsp.writeFile(filePath, `process.stdout.write(${literal});\n`, "utf8");
	return filePath.split(path.sep).join("/");
}

async function copyJsonStdinPath() {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-copy-"));
	const filePath = path.join(dir, "copy.mjs");
	await fsp.writeFile(
		filePath,
		'let input = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (chunk) => (input += chunk));\nprocess.stdin.on("end", () => process.stdout.write(input));\n',
		"utf8",
	);
	return filePath.split(path.sep).join("/");
}

test("workflow cost tracking bills a cached llm.invoke replay only once behind a renderer", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const step = "llm.invoke --model gpt-4o --prompt Summarize | json";
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{ id: "live", pipeline: step },
					{ id: "from-cache", pipeline: step },
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 500);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.stepId),
			["live"],
		);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking bills a run-state llm.invoke replay only once behind a renderer", async () => {
	const provider = await startFakeProvider();
	const step = "llm.invoke --disable-cache --model gpt-4o --prompt Summarize | json";
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{ id: "live", pipeline: step },
					{ id: "from-run-state", pipeline: step },
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_RUN_STATE_KEY: "cost-tracker-rendered-replay" },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.stepId),
			["live"],
		);
	} finally {
		await provider.close();
	}
});

test("cost_limit stop is not tripped by a replayed llm.invoke behind a renderer", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const step = "llm.invoke --model gpt-4o --prompt Summarize | json";
	try {
		const { result } = await runWorkflow(
			{
				cost_limit: { max_usd: 0.01, action: "stop" },
				steps: [
					{ id: "live", pipeline: step },
					{ id: "from-cache", pipeline: step },
					{ id: "after", command: "echo done" },
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(result._meta?.cost?.estimatedCostUsd, 0.0075);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking bills a rendered step that prints the full replay shape", async () => {
	const forgedCache = await emitJsonPath(forgedReplayItem("cache"));
	const forgedRunState = await emitJsonPath(forgedReplayItem("run_state"));
	const { result } = await runWorkflow({
		steps: [
			{ id: "forged-cache", pipeline: `exec --json=true node ${forgedCache} | json` },
			{ id: "forged-run-state", pipeline: `exec --json=true node ${forgedRunState} | json` },
		],
	});

	assert.equal(result.status, "ok");
	assert.equal(result._meta?.cost?.totalInputTokens, 2000);
	assert.deepEqual(
		result._meta?.cost?.byStep.map((entry) => entry.stepId),
		["forged-cache", "forged-run-state"],
	);
});

test("cost_limit stop cannot be bypassed by a rendered step that prints the replay shape", async () => {
	const live = await emitJsonCommand(liveItem());
	const forged = await emitJsonPath(forgedReplayItem());

	await assert.rejects(
		() =>
			runWorkflow({
				cost_limit: { max_usd: 0.01, action: "stop" },
				steps: [
					{ id: "live", command: live },
					{ id: "forged-replay", pipeline: `exec --json=true node ${forged} | json` },
				],
			}).then((x) => x.result),
		/Cost limit exceeded/,
	);
});

// A projection such as `pick model,usage` builds a new object from named fields, so an item's
// own marker does not reach accounting. The usage record it carries is the thing being billed,
// and it crosses the projection by reference.
test("workflow cost tracking bills a cached llm.invoke replay only once through a projection", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const step = "llm.invoke --model gpt-4o --prompt Summarize | pick model,usage";
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{ id: "live", pipeline: step },
					{ id: "from-cache", pipeline: step },
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.stepId),
			["live"],
		);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking bills a run-state llm.invoke replay only once through a projection", async () => {
	const provider = await startFakeProvider();
	const step = "llm.invoke --disable-cache --model gpt-4o --prompt Summarize | pick model,usage";
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{ id: "live", pipeline: step },
					{ id: "from-run-state", pipeline: step },
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_RUN_STATE_KEY: "cost-tracker-projected-replay" },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.stepId),
			["live"],
		);
	} finally {
		await provider.close();
	}
});

test("workflow cost tracking prices a projected live call from the charge it settled", async () => {
	const provider = await startFakeProvider();
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{
						id: "live",
						pipeline: "llm.invoke --disable-cache --model gpt-4o --prompt Summarize | pick usage",
					},
				],
			},
			{ OPENCLAW_URL: provider.url },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.equal(result._meta?.cost?.estimatedCostUsd, 0.0075);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.model),
			["gpt-4o"],
		);
	} finally {
		await provider.close();
	}
});

test("workflow cost tracking prices a live call whose model field a step rewrote", async () => {
	const provider = await startFakeProvider();
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{
						id: "live",
						pipeline:
							"llm.invoke --disable-cache --model gpt-4o --prompt Summarize | map model=gpt-3.5-turbo",
					},
				],
			},
			{ OPENCLAW_URL: provider.url },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(result._meta?.cost?.estimatedCostUsd, 0.0075);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.model),
			["gpt-4o"],
		);
	} finally {
		await provider.close();
	}
});

test("workflow cost tracking bills a projected step that prints the full replay shape", async () => {
	const forged = await emitJsonPath(forgedReplayItem("cache"));
	const { result } = await runWorkflow({
		steps: [
			{ id: "forged-picked", pipeline: `exec --json=true node ${forged} | pick model,usage` },
			{
				id: "forged-picked-rendered",
				pipeline: `exec --json=true node ${forged} | pick model,usage | json`,
			},
		],
	});

	assert.equal(result.status, "ok");
	assert.equal(result._meta?.cost?.totalInputTokens, 2000);
	assert.deepEqual(
		result._meta?.cost?.byStep.map((entry) => entry.stepId),
		["forged-picked", "forged-picked-rendered"],
	);
});

// A command that fails the first time it runs and succeeds afterwards, so a step carrying it
// takes exactly two attempts under `retry`.
async function failsOnceCommand() {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-flaky-"));
	const marker = JSON.stringify(path.join(dir, "attempted"));
	const filePath = path.join(dir, "flaky.mjs");
	await fsp.writeFile(
		filePath,
		`import fs from "node:fs";\n` +
			`if (fs.existsSync(${marker})) process.stdout.write("ok");\n` +
			`else { fs.writeFileSync(${marker}, "1"); process.exit(1); }\n`,
		"utf8",
	);
	return `node ${filePath}`;
}

// `llm.invoke` stores the live answer before it returns, and a step's cost is recorded only
// once the step succeeds. So when a later part of a retried step fails, the provider has
// already been paid and the retry replays that answer: the replay is the only place the spend
// can still be recorded, and exempting it would report $0 for a call that really happened.
test("workflow cost tracking bills a replay standing in for a retried step's live call", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const flaky = await failsOnceCommand();
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{
						id: "invoke-then-fail",
						retry: { max: 2, delay_ms: 1 },
						parallel: {
							branches: [
								{ id: "invoke", pipeline: "llm.invoke --model gpt-4o --prompt Summarize" },
								{ id: "flaky", command: flaky },
							],
						},
					},
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 500);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.stepId),
			["invoke"],
		);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

// The spend a retried step recovers is real money, so it has to reach `cost_limit` too.
test("cost_limit stop counts the live call a retried step's replay stands in for", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const flaky = await failsOnceCommand();
	try {
		await assert.rejects(
			() =>
				runWorkflow(
					{
						cost_limit: { max_usd: 0.001, action: "stop" },
						steps: [
							{
								id: "invoke-then-fail",
								retry: { max: 2, delay_ms: 1 },
								parallel: {
									branches: [
										{ id: "invoke", pipeline: "llm.invoke --model gpt-4o --prompt Summarize" },
										{ id: "flaky", command: flaky },
									],
								},
							},
							{ id: "after", command: "echo done" },
						],
					},
					{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
				).then((x) => x.result),
			/Cost limit exceeded/,
		);
		assert.equal(provider.requests(), 1);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

// A command that always fails, so a step carrying it never succeeds.
async function alwaysFailsCommand() {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-fail-"));
	const filePath = path.join(dir, "fail.mjs");
	await fsp.writeFile(filePath, "process.exit(1);\n", "utf8");
	return `node ${filePath}`;
}

// The charge a run opens belongs to that run. If its step never succeeds, the charge is never
// recovered — and a later run that replays the same stored answer called no provider, so
// billing it there would move one run's spend onto another. The ledger is per-run, so it
// cannot: this also covers a live call made outside any cost accounting, such as the SDK
// pipeline API, whose cache entry a workflow may later reuse.
test("workflow cost tracking does not bill a replay of a call another run paid for", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const failing = await alwaysFailsCommand();
	const invoke = "llm.invoke --model gpt-4o --prompt Summarize";
	const env = { OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir };
	try {
		const first = await runWorkflow(
			{
				steps: [
					{
						id: "spends",
						on_error: "continue",
						parallel: {
							branches: [
								{ id: "invoke", pipeline: invoke },
								{ id: "fails", command: failing },
							],
						},
					},
				],
			},
			env,
		);
		assert.equal(first.result.status, "ok");
		// The step failed, so no item of it was ever billed -- but the provider had already
		// answered, and the charge that survives it is the only record of that. The run that
		// made the call is where it belongs; the alternative is that it is billed nowhere at all.
		assert.equal(first.result._meta?.cost?.totalInputTokens, 1000);
		assert.deepEqual(
			first.result._meta?.cost?.byStep.map((entry) => entry.stepId),
			["invoke"],
		);

		const second = await runWorkflow({ steps: [{ id: "replays", pipeline: invoke }] }, env);
		assert.equal(second.result.status, "ok");
		assert.equal(provider.requests(), 1);
		// The point of the case: this run paid for nothing, so it is charged nothing.
		assert.equal(second.result._meta?.cost, undefined);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

// Two identical calls that race on a cold cache are two provider charges under one cache key.
// If the step is then retried, both replays have to be billable: a ledger that only remembered
// "this key is unpaid" would settle once and silently drop the second real charge.
test("workflow cost tracking bills both live calls a retried step's replays stand in for", async () => {
	const provider = await startFakeProvider(2);
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const flaky = await failsOnceCommand();
	const invoke = "llm.invoke --model gpt-4o --prompt Summarize";
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{
						id: "invoke-twice-then-fail",
						retry: { max: 2, delay_ms: 1 },
						parallel: {
							branches: [
								{ id: "invoke-a", pipeline: invoke },
								{ id: "invoke-b", pipeline: invoke },
								{ id: "flaky", command: flaky },
							],
						},
					},
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 2);
		assert.equal(result._meta?.cost?.totalInputTokens, 2000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 1000);
		assert.deepEqual(result._meta?.cost?.byStep.map((entry) => entry.stepId).sort(), [
			"invoke-a",
			"invoke-b",
		]);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

// A gate pauses a run rather than resetting what it spent. The resume is a different run — a
// different process, even — so the call made before the gate is only in the paused run's
// record; if a later step repeats the prompt, it replays and correctly bills nothing. Without
// carrying that record forward, the provider call before the gate would appear in no total at
// all, and a `cost_limit` could be walked past one gate at a time.
// A gate pauses a run, it does not reset what the run has spent. The resume is a separate run
// with its own accounting, so a call made before the gate lives only in the paused run's
// record: if a later step repeats the prompt it replays, correctly bills nothing, and the
// provider call would end up in no total at all. Carrying the record forward also stops a
// `cost_limit` being walked past one gate at a time.
test("workflow cost tracking carries spend across an approval resume", async () => {
	const provider = await startFakeProvider();
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-resume-"));
	const cacheDir = path.join(tmpDir, "cache");
	const stateDir = path.join(tmpDir, "state");
	await fsp.mkdir(cacheDir, { recursive: true });
	const invoke = "llm.invoke --model gpt-4o --prompt Summarize";
	const filePath = path.join(tmpDir, "workflow.lobster");
	await fsp.writeFile(
		filePath,
		JSON.stringify({
			steps: [
				{ id: "live", pipeline: invoke },
				{ id: "gate", run: "echo gate", approval: "Continue?" },
				{ id: "replay", pipeline: invoke },
			],
		}),
		"utf8",
	);

	const env = {
		...process.env,
		LOBSTER_STATE_DIR: stateDir,
		LOBSTER_CACHE_DIR: cacheDir,
		OPENCLAW_URL: provider.url,
	};
	const ctx = () => ({
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: new PassThrough(),
		env,
		mode: "tool" as const,
		registry: createDefaultRegistry(),
	});

	try {
		const paused = await runWorkflowFile({ filePath, ctx: ctx() });
		assert.equal(paused.status, "needs_approval");
		const token = paused.requiresApproval?.resumeToken;
		assert.equal(typeof token, "string");

		const resumed = await runWorkflowFile({
			filePath,
			ctx: ctx(),
			resume: decodeToken(token as string),
			approved: true,
		});

		assert.equal(resumed.status, "ok");
		assert.equal(provider.requests(), 1);
		// The live call happened before the gate; the step after it only replayed.
		assert.equal(resumed._meta?.cost?.totalInputTokens, 1000);
		assert.equal(resumed._meta?.cost?.totalOutputTokens, 500);
		assert.deepEqual(
			resumed._meta?.cost?.byStep.map((entry) => entry.stepId),
			["live"],
		);
	} finally {
		await provider.close();
		await fsp.rm(tmpDir, { recursive: true, force: true });
	}
});

// A pipeline can pause *between* paying for a call and billing it: `llm.invoke | ask` in tool
// mode suspends after the model answered, and `ask` consumes the items, so the usage never
// reaches accounting. The charge exists only as an outstanding entry in the paused run's
// ledger — if that does not travel with the resume state, the replay a later step produces is
// exempt and the call is billed nowhere.
test("workflow cost tracking carries an unbilled call across a pipeline input resume", async () => {
	const provider = await startFakeProvider();
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-input-"));
	const cacheDir = path.join(tmpDir, "cache");
	const stateDir = path.join(tmpDir, "state");
	await fsp.mkdir(cacheDir, { recursive: true });
	const invoke = "llm.invoke --model gpt-4o --prompt Summarize";
	const filePath = path.join(tmpDir, "workflow.lobster");
	await fsp.writeFile(
		filePath,
		JSON.stringify({
			steps: [
				{ id: "ask-after-invoke", pipeline: `${invoke} | ask --prompt Continue?` },
				{ id: "replay", pipeline: invoke },
			],
		}),
		"utf8",
	);

	const env = {
		...process.env,
		LOBSTER_STATE_DIR: stateDir,
		LOBSTER_CACHE_DIR: cacheDir,
		OPENCLAW_URL: provider.url,
	};
	const ctx = () => ({
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: new PassThrough(),
		env,
		mode: "tool" as const,
		registry: createDefaultRegistry(),
	});

	try {
		const paused = await runWorkflowFile({ filePath, ctx: ctx() });
		assert.equal(paused.status, "needs_input");
		const token = paused.requiresInput?.resumeToken;
		assert.equal(typeof token, "string");

		const resumed = await runWorkflowFile({
			filePath,
			ctx: ctx(),
			resume: decodeToken(token as string),
			response: { decision: "approve" },
		});

		assert.equal(resumed.status, "ok");
		assert.equal(provider.requests(), 1);
		// `ask` swallowed the item that carried the usage, so the replay in the next step is
		// the only carrier left for a call the provider really answered.
		assert.equal(resumed._meta?.cost?.totalInputTokens, 1000);
		assert.equal(resumed._meta?.cost?.totalOutputTokens, 500);
	} finally {
		await provider.close();
		await fsp.rm(tmpDir, { recursive: true, force: true });
	}
});

// The provider is paid the moment it answers, before Lobster stores anything. A coordinated
// state/cache publication failure rolls both stores back, so the retry makes another live call.
// Both calls must be charged even though only the retry produces a step result.
test("workflow cost tracking bills both calls when the first cache write fails", async () => {
	const provider = await startFakeProvider();
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-unwritable-"));
	const cacheDir = path.join(tmpDir, "cache");
	const cacheNamespaceDir = path.join(cacheDir, "llm.invoke");
	const originalMkdir = fsp.mkdir;
	let cacheNamespaceMkdirs = 0;
	try {
		Object.defineProperty(fsp, "mkdir", {
			configurable: true,
			writable: true,
			async value(
				target: Parameters<typeof fsp.mkdir>[0],
				options?: Parameters<typeof fsp.mkdir>[1],
			) {
				if (String(target) === cacheNamespaceDir && ++cacheNamespaceMkdirs === 2) {
					throw Object.assign(new Error("cache directory unavailable"), { code: "EIO" });
				}
				return originalMkdir(target, options);
			},
		});
		const { result } = await runWorkflow(
			{
				steps: [
					{
						id: "invoke",
						retry: { max: 2, delay_ms: 1 },
						pipeline: "llm.invoke --model gpt-4o --prompt Summarize",
					},
				],
			},
			{
				OPENCLAW_URL: provider.url,
				LOBSTER_CACHE_DIR: cacheDir,
				LOBSTER_RUN_STATE_KEY: "cost-tracker-unwritable-cache",
			},
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 2);
		assert.equal(result._meta?.cost?.totalInputTokens, 2000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 1000);
	} finally {
		Object.defineProperty(fsp, "mkdir", {
			configurable: true,
			writable: true,
			value: originalMkdir,
		});
		await provider.close();
		await fsp.rm(tmpDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking bills one call when a parallel replay branch is declared first", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const step = "llm.invoke --model gpt-4o --prompt Summarize";
	try {
		// The replay branch is declared before the live one, so it is accounted first: without
		// holding replays back it claims the charge the refresh branch opened and is billed for
		// it, and the refresh branch -- billed whatever its own claim returns -- is billed again.
		const { result } = await runWorkflow(
			{
				steps: [
					{ id: "warm", pipeline: step },
					{
						id: "both",
						parallel: {
							wait: "all",
							branches: [
								{ id: "replay", pipeline: step },
								{ id: "refresh", pipeline: `${step} --refresh` },
							],
						},
					},
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 2, "one warm-up call and one refresh");
		assert.equal(result._meta?.cost?.totalInputTokens, 2000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 1000);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.stepId),
			["warm", "refresh"],
		);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

test("cost_limit stop is not tripped by a parallel replay branch declared first", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const step = "llm.invoke --model gpt-4o --prompt Summarize";
	try {
		// Two provider calls cost $0.0150; the third charge the ordering bug added took the run
		// to $0.0225 and stopped it at a budget it had not spent.
		const { result } = await runWorkflow(
			{
				cost_limit: { max_usd: 0.02, action: "stop" },
				steps: [
					{ id: "warm", pipeline: step },
					{
						id: "both",
						parallel: {
							wait: "all",
							branches: [
								{ id: "replay", pipeline: step },
								{ id: "refresh", pipeline: `${step} --refresh` },
							],
						},
					},
					{ id: "after", command: "echo done" },
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(result._meta?.cost?.estimatedCostUsd, 0.015);
		assert.equal(String(result.output?.[0]).trim(), "done", "the step after ran");
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking bills a call a nested workflow made before a plain final step", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	try {
		const { result } = await runComposedWorkflow(
			{ steps: [{ id: "child", workflow: "child.lobster" }] },
			{
				steps: [
					{ id: "llm", pipeline: "llm.invoke --model gpt-4o --prompt Summarize | json" },
					{ id: "done", command: "echo done" },
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		// Only the child's last step crosses the composition boundary, and it carries no items.
		// The charge the child opened in this run's ledger is still a call this run paid for.
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 500);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking bills a call whose only item an ask gate consumed", async () => {
	const provider = await startFakeProvider();
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-input-"));
	const cacheDir = path.join(tmpDir, "cache");
	const stateDir = path.join(tmpDir, "state");
	await fsp.mkdir(cacheDir, { recursive: true });
	const filePath = path.join(tmpDir, "workflow.lobster");
	// Nothing replays the call after the resume, so the item `ask` swallowed was the only
	// carrier its usage ever had.
	await fsp.writeFile(
		filePath,
		JSON.stringify({
			steps: [
				{
					id: "ask-after-invoke",
					pipeline: "llm.invoke --model gpt-4o --prompt Summarize | ask --prompt Continue?",
				},
				{ id: "done", command: "echo done" },
			],
		}),
		"utf8",
	);

	const env = {
		...process.env,
		LOBSTER_STATE_DIR: stateDir,
		LOBSTER_CACHE_DIR: cacheDir,
		OPENCLAW_URL: provider.url,
	};
	const ctx = () => ({
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: new PassThrough(),
		env,
		mode: "tool" as const,
		registry: createDefaultRegistry(),
	});

	try {
		const paused = await runWorkflowFile({ filePath, ctx: ctx() });
		assert.equal(paused.status, "needs_input");
		const token = paused.requiresInput?.resumeToken;
		assert.equal(typeof token, "string");

		const resumed = await runWorkflowFile({
			filePath,
			ctx: ctx(),
			resume: decodeToken(token as string),
			response: { decision: "approve" },
		});

		assert.equal(resumed.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(resumed._meta?.cost?.totalInputTokens, 1000);
		assert.equal(resumed._meta?.cost?.totalOutputTokens, 500);
	} finally {
		await provider.close();
		await fsp.rm(tmpDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking bills a rendered call when a later stage emits its own items", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-state-"));
	try {
		// `json` records the model items it rendered and hands the next stage an empty stream;
		// `state.get` then emits an item of its own, which carries no usage.
		const { result } = await runWorkflow(
			{
				steps: [
					{
						id: "render-then-read",
						pipeline: "llm.invoke --model gpt-4o --prompt Summarize | json | state.get cost-probe",
					},
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir, LOBSTER_STATE_DIR: stateDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 500);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
		await fsp.rm(stateDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking bills a call once when only a JSON round trip of its item survives", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-state-"));
	try {
		// `state.set` stores the model item and `state.get` reads it back as a plain object: the
		// numbers survive, the in-process mark does not. Nothing bills the original -- the step
		// ends on an unrelated key -- so the call is billed to the step that made it, and the
		// copy surfacing a step later must not be billed on top of it.
		const { result } = await runWorkflow(
			{
				steps: [
					{
						id: "store",
						pipeline:
							"llm.invoke --model gpt-4o --prompt Summarize | state.set probe | state.get sink",
					},
					{ id: "reload", pipeline: "state.get probe" },
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir, LOBSTER_STATE_DIR: stateDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 500);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.stepId),
			["store"],
		);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
		await fsp.rm(stateDir, { recursive: true, force: true });
	}
});

test("llm spend ledger bills a copy of an item only for a call nothing accounted for", () => {
	const ledger = createLlmSpendLedger();
	ledger.record("key-a", { model: "gpt-4o", usage: { inputTokens: 1000, outputTokens: 500 } });

	// A step can print any cache key it likes, so a key alone settles nothing: an item whose
	// cost the run never recorded is billed on its own account and leaves the charge open, which
	// is what stops an invented item from hiding real spend.
	assert.equal(ledger.billCopy("key-a", "gpt-4o", { inputTokens: 1, outputTokens: 1 }), true);
	assert.equal(ledger.billCopy("key-b", "gpt-4o", { inputTokens: 1000, outputTokens: 500 }), true);
	assert.equal(ledger.billCopy("key-a", "gpt-5", { inputTokens: 1000, outputTokens: 500 }), true);
	assert.equal(ledger.outstanding().length, 1);

	// The recorded cost settles the charge, and the copy is billed as its carrier. Key order
	// changes across a JSON round trip; the numbers do not.
	assert.equal(ledger.billCopy("key-a", "gpt-4o", { outputTokens: 500, inputTokens: 1000 }), true);
	assert.deepEqual(ledger.outstanding(), []);

	// Public fields never prove that a later item is the same call.
	assert.equal(ledger.billCopy("key-a", "gpt-4o", { inputTokens: 1000, outputTokens: 500 }), true);
});

test("llm spend ledger does not trust a copy of a call the run already settled", () => {
	const ledger = createLlmSpendLedger();
	const usage = { inputTokens: 1000, outputTokens: 500 };
	ledger.record("key-a", { model: "gpt-4o", usage });

	// However the call was accounted for, ordinary JSON cannot prove it came from that call.
	assert.ok(ledger.claim("key-a"));
	assert.equal(ledger.billCopy("key-a", "gpt-4o", { ...usage }), true);
	assert.equal(ledger.billCopy("key-a", "gpt-4o", { inputTokens: 7 }), true);
});

// Two identical calls that race on a cold cache do not cost the same: output length varies with
// sampling. Only one of the two answers is stored, so every replay of them carries that one
// answer's numbers -- billing each replay by the copy it holds reports both calls at the price
// of whichever won the cache write.
test("workflow cost tracking bills each retried replay at what its own call cost", async () => {
	const provider = await startFakeProvider(2, (seen) => ({
		inputTokens: seen === 1 ? 1000 : 3000,
		outputTokens: seen === 1 ? 500 : 100,
	}));
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const flaky = await failsOnceCommand();
	const invoke = "llm.invoke --model gpt-4o --prompt Summarize";
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{
						id: "invoke-twice-then-fail",
						retry: { max: 2, delay_ms: 1 },
						parallel: {
							branches: [
								{ id: "invoke-a", pipeline: invoke },
								{ id: "invoke-b", pipeline: invoke },
								{ id: "flaky", command: flaky },
							],
						},
					},
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 2);
		// 1000 + 3000 and 500 + 100: what the provider was actually paid, whichever answer the
		// two replays ended up carrying.
		assert.equal(result._meta?.cost?.totalInputTokens, 4000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 600);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

test("cost_limit stop halts before the next step when no item carried the call's usage", async () => {
	const provider = await startFakeProvider();
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-limit-"));
	const marker = path.join(tmpDir, "ran.txt").replaceAll(path.sep, "/");
	const script = path.join(tmpDir, "touch.mjs");
	await fsp.writeFile(
		script,
		`import fs from "node:fs";
fs.writeFileSync("${marker}", "ran");
`,
		"utf8",
	);

	try {
		// The renderer consumes the model item and `state.get` emits one of its own, so the step
		// completes with nothing carrying the call's usage. The budget is already blown when the
		// step ends, and the step after it must not get to run its side effect.
		await assert.rejects(
			() =>
				runWorkflow(
					{
						cost_limit: { max_usd: 0.001, action: "stop" },
						steps: [
							{
								id: "spends",
								pipeline: "llm.invoke --model gpt-4o --prompt Summarize | json | state.get sink",
							},
							{ id: "after", command: `node ${script}` },
						],
					},
					{
						OPENCLAW_URL: provider.url,
						LOBSTER_CACHE_DIR: path.join(tmpDir, "cache"),
						LOBSTER_STATE_DIR: path.join(tmpDir, "state"),
					},
				).then((run) => run.result),
			/Cost limit exceeded/,
		);
		await assert.rejects(() => fsp.access(marker), "the step after the limit must not run");
	} finally {
		await provider.close();
		await fsp.rm(tmpDir, { recursive: true, force: true });
	}
});

test("cost_limit stop halts before the next step when the step that spent it failed", async () => {
	const provider = await startFakeProvider();
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-limit-"));
	const marker = path.join(tmpDir, "ran.txt").replaceAll(path.sep, "/");
	const script = path.join(tmpDir, "touch.mjs");
	await fsp.writeFile(
		script,
		`import fs from "node:fs";
fs.writeFileSync("${marker}", "ran");
`,
		"utf8",
	);
	const failing = await alwaysFailsCommand();

	try {
		// One branch pays a provider, another fails, and `on_error: continue` advances the run.
		// No item of the failed step is ever billed, so the charge it left behind is the only
		// record of the spend -- and the budget is already gone by the time the next step is
		// asked to run its side effect.
		await assert.rejects(
			() =>
				runWorkflow(
					{
						cost_limit: { max_usd: 0.001, action: "stop" },
						steps: [
							{
								id: "spends",
								on_error: "continue",
								parallel: {
									branches: [
										{ id: "invoke", pipeline: "llm.invoke --model gpt-4o --prompt Summarize" },
										{ id: "fails", command: failing },
									],
								},
							},
							{ id: "after", command: `node ${script}` },
						],
					},
					{
						OPENCLAW_URL: provider.url,
						LOBSTER_CACHE_DIR: path.join(tmpDir, "cache"),
					},
				).then((run) => run.result),
			/Cost limit exceeded/,
		);
		await assert.rejects(() => fsp.access(marker), "the step after the limit must not run");
	} finally {
		await provider.close();
		await fsp.rm(tmpDir, { recursive: true, force: true });
	}
});

test("llm spend ledger matches a copy on the token counts that are billed", () => {
	const ledger = createLlmSpendLedger();
	ledger.record("key-a", {
		model: "gpt-4o",
		usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
	});

	// A stage that rebuilds an item can drop or recompute a field nothing is charged for. The
	// charge is the same charge, so the copy has to settle it rather than be billed beside it.
	assert.equal(ledger.billCopy("key-a", "gpt-4o", { inputTokens: 1000, outputTokens: 500 }), true);
	assert.deepEqual(ledger.outstanding(), []);
});

test("llm spend ledger matches a copy across the token field names providers use", () => {
	const ledger = createLlmSpendLedger();
	ledger.record("key-a", { model: "gpt-4o", usage: { inputTokens: 1000, outputTokens: 500 } });

	// `CostTracker` bills these spellings as the same tokens, so the ledger has to read them as
	// the same charge.
	assert.equal(
		ledger.billCopy("key-a", "gpt-4o", { prompt_tokens: 1000, completion_tokens: 500 }),
		true,
	);
	assert.deepEqual(ledger.outstanding(), []);

	// A cost the run never recorded still settles nothing.
	ledger.record("key-b", { model: "gpt-4o", usage: { inputTokens: 1000, outputTokens: 500 } });
	assert.equal(ledger.billCopy("key-b", "gpt-4o", { prompt_tokens: 999 }), true);
	assert.equal(ledger.outstanding().length, 1);
});

test("workflow cost tracking bills a call once when the copy of its item lost the cache key", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-state-"));
	try {
		// `state.get` reads the stored item back without its marks and `pick` projects it down to
		// the two fields that matter, dropping the cache key with them. All that reaches the
		// accounting is a cost, and it is the cost of the call whose charge is still open.
		const { result } = await runWorkflow(
			{
				steps: [
					{
						id: "invoke",
						pipeline:
							"llm.invoke --model gpt-4o --prompt Summarize | state.set probe | state.get probe | pick model,usage",
					},
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir, LOBSTER_STATE_DIR: stateDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 500);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
		await fsp.rm(stateDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking does not let an answer that cost nothing stand in for one that did", async () => {
	// The first answer reports no usage at all, so nothing bills it and nothing ever will. A
	// charge for it would be the one handed to the refresh below, leaving the refresh's own
	// charge open for the end-of-step settlement to bill on top of the item already recorded.
	const provider = await startFakeProvider(1, (seen) =>
		seen === 1 ? null : { inputTokens: 1000, outputTokens: 500 },
	);
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const invoke = "llm.invoke --model gpt-4o --prompt Summarize";
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{ id: "no-usage", pipeline: `${invoke} | json` },
					{ id: "refresh", pipeline: `${invoke} --refresh | json` },
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 2);
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 500);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

test("llm spend ledger reads a copy that kept no cache key by what it cost", () => {
	const ledger = createLlmSpendLedger();
	const usage = { inputTokens: 1000, outputTokens: 500 };
	ledger.record("key-a", { model: "gpt-4o", usage });

	// Without a key the cost is the only evidence, and it is enough to settle an open charge --
	// which only ever adds a record of a call, never removes one.
	assert.equal(ledger.billCopy(null, "gpt-4o", { inputTokens: 7 }), true);
	assert.equal(ledger.outstanding().length, 1);
	assert.equal(ledger.billCopy(null, "gpt-4o", { ...usage }), true);
	assert.deepEqual(ledger.outstanding(), []);
});

test("llm spend ledger never lets a keyless item withhold its own record", () => {
	const ledger = createLlmSpendLedger();
	const usage = { inputTokens: 1000, outputTokens: 500 };
	ledger.record("key-a", { model: "gpt-4o", usage });
	assert.ok(ledger.claim("key-a"));

	// Resembling a call this run already billed is not evidence of being a copy of it: two
	// unrelated objects can carry the same model and the same counts, and an ordinary step
	// printing `{ model, usage }` must not be able to drop out of `cost_limit` that way. With
	// a matching public key remains forgeable, so both forms are billed.
	assert.equal(ledger.billCopy(null, "gpt-4o", { ...usage }), true);
	assert.equal(ledger.billCopy("key-a", "gpt-4o", { ...usage }), true);
});

test("llm spend ledger keeps a copy naming one call from settling another", () => {
	const ledger = createLlmSpendLedger();
	ledger.record("key-a", { model: "gpt-4o", usage: { inputTokens: 1000, outputTokens: 500 } });

	// The key a copy still carries says which call it came from, so it is read against that
	// call rather than against whichever other charge happens to have cost the same.
	assert.equal(ledger.billCopy("key-b", "gpt-4o", { inputTokens: 1000, outputTokens: 500 }), true);
	assert.equal(ledger.outstanding().length, 1);
});

// A step that pays a provider and then fails is retried, and `--refresh` makes the retry pay
// again rather than replay. Two charges under one key, and they did not cost the same: only the
// retry produces an item, so the charge it settles decides what the failed attempt is billed as.
test("workflow cost tracking bills a retried live call and the attempt before it at their own costs", async () => {
	const provider = await startFakeProvider(1, (seen) =>
		seen === 1
			? { inputTokens: 1000, outputTokens: 500 }
			: { inputTokens: 3000, outputTokens: 100 },
	);
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const flaky = await failsOnceCommand();
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{
						id: "pay-fail-pay",
						retry: { max: 2, delay_ms: 1 },
						parallel: {
							branches: [
								{
									id: "invoke",
									pipeline: "llm.invoke --model gpt-4o --prompt Summarize --refresh",
								},
								{ id: "flaky", command: flaky },
							],
						},
					},
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 2);
		// 1000 + 3000 and 500 + 100. Billing the retry's item against the failed attempt's charge
		// would report the retry twice and the attempt before it not at all.
		assert.equal(result._meta?.cost?.totalInputTokens, 4000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 600);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking bills a keyless step that resembles a call already billed", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const lookalike = await emitJsonCommand({
		model: "gpt-4o",
		usage: { inputTokens: 1000, outputTokens: 500 },
	});
	try {
		// The second step prints the same model and the same counts as the call the first one
		// paid for, and names no cache key. That is not evidence of being a copy of it, so it is
		// billed on its own account -- the run is charged for both.
		const { result } = await runWorkflow(
			{
				steps: [
					{ id: "live", pipeline: "llm.invoke --model gpt-4o --prompt Summarize | json" },
					{ id: "lookalike", command: lookalike },
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(result._meta?.cost?.totalInputTokens, 2000);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.stepId),
			["live", "lookalike"],
		);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

// Two live calls in one step, costing the same and made under different cache keys. One branch
// hands on a copy that lost its mark and its key, so all the ledger can read it by is the cost --
// and until the marked branch has settled its own charge, the other call's charge answers to that
// cost just as well.
test("workflow cost tracking does not let a keyless copy settle another call's charge", async () => {
	const provider = await startFakeProvider(1, undefined, (prompt) => (prompt === "Beta" ? 60 : 0));
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-state-"));
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{
						id: "two-calls",
						parallel: {
							wait: "all",
							branches: [
								{
									// Declared first, so it is accounted first; its own call answers last.
									id: "filtered",
									pipeline:
										"llm.invoke --model gpt-4o --prompt Beta | state.set probe | state.get probe | pick model,usage",
								},
								{ id: "marked", pipeline: "llm.invoke --model gpt-4o --prompt Alpha | json" },
							],
						},
					},
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir, LOBSTER_STATE_DIR: stateDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 2);
		// Two calls, two records. Reading the copy before the marked branch settles leaves the
		// copy on one charge, the marked branch billed regardless, and the third charge for the
		// step settlement to find.
		assert.equal(result._meta?.cost?.totalInputTokens, 2000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 1000);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
		await fsp.rm(stateDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking does not bill a replay routed through state storage", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-state-"));
	const invoke = "llm.invoke --model gpt-4o --prompt Summarize";
	const env = {
		OPENCLAW_URL: provider.url,
		LOBSTER_CACHE_DIR: cacheDir,
		LOBSTER_STATE_DIR: stateDir,
	};
	try {
		// An earlier run paid for the answer, so this run has no charge of its own to settle: it
		// is billed nothing whether or not it stores the replay on the way past. `state.get`
		// rebuilds the item from its own JSON, which carries none of the marks this process
		// attached -- but the command wrote those bytes itself a moment earlier, so it knows what
		// the value it hands back stands in for.
		const first = await runWorkflow({ steps: [{ id: "warm", pipeline: `${invoke} | json` }] }, env);
		assert.equal(first.result._meta?.cost?.totalInputTokens, 1000);

		const { result } = await runWorkflow(
			{
				steps: [
					{ id: "through-state", pipeline: `${invoke} | state.set probe | state.get probe | json` },
				],
			},
			env,
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 1);
		assert.equal(result._meta?.cost, undefined);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
		await fsp.rm(stateDir, { recursive: true, force: true });
	}
});

test("workflow cost tracking still bills a state value this process never wrote", async () => {
	const provider = await startFakeProvider();
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-state-"));
	// A state file some other run -- or some other program -- left behind. It looks exactly like
	// a replay and says so, and it is still billed: the bytes on disk were never handed to this
	// process to be marked, so nothing about them can claim the call was already paid for.
	await fsp.writeFile(
		path.join(stateDir, "planted.json"),
		JSON.stringify(forgedReplayItem("cache"), null, 2) + "\n",
		"utf8",
	);
	try {
		const { result } = await runWorkflow(
			{ steps: [{ id: "planted", pipeline: "state.get planted | json" }] },
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir, LOBSTER_STATE_DIR: stateDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(result._meta?.cost?.totalInputTokens, 1000);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
		await fsp.rm(stateDir, { recursive: true, force: true });
	}
});

// A response the local validator rejects was still answered by a provider, and paid for. The
// command asks again inside the same step, so nothing downstream ever sees the rejected attempt
// -- the charge it opened is the only record that the call happened.
test("workflow cost tracking bills a provider call the schema validator rejected", async () => {
	const provider = await startFakeProvider(
		1,
		(seen) =>
			seen === 1
				? { inputTokens: 1000, outputTokens: 500 }
				: { inputTokens: 3000, outputTokens: 100 },
		() => 0,
		(seen) => (seen === 1 ? {} : { summary: "hello" }),
	);
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	const schema = JSON.stringify({
		type: "object",
		required: ["summary"],
		properties: { summary: { type: "string" } },
	});
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{
						id: "validated",
						pipeline: `llm.invoke --model gpt-4o --prompt Summarize --output-schema '${schema}' | json`,
					},
				],
			},
			{ OPENCLAW_URL: provider.url, LOBSTER_CACHE_DIR: cacheDir },
		);

		assert.equal(result.status, "ok");
		assert.equal(provider.requests(), 2, "the first answer failed the schema and was asked again");
		// 1000 + 3000 and 500 + 100: both calls, not just the one that satisfied the schema.
		assert.equal(result._meta?.cost?.totalInputTokens, 4000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 600);
	} finally {
		await provider.close();
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
});

// Restoring what a paused run spent without restoring what it spent it on counts one call
// twice. The steps come back from the resume state as JSON, so a completed `llm.invoke` output
// among them carries no mark this process put there — only the cache key, which is an ordinary
// field. A later step that re-emits that output is then a copy of a call the fresh ledger has
// never heard of, and it is billed on top of the restored total.
test("workflow cost tracking does not rebill a pre-pause call re-emitted after a resume", async () => {
	const provider = await startFakeProvider();
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-rebill-"));
	const cacheDir = path.join(tmpDir, "cache");
	const stateDir = path.join(tmpDir, "state");
	await fsp.mkdir(cacheDir, { recursive: true });
	const filePath = path.join(tmpDir, "workflow.lobster");
	await fsp.writeFile(
		filePath,
		JSON.stringify({
			steps: [
				{ id: "live", pipeline: "llm.invoke --model gpt-4o --prompt Summarize" },
				{ id: "gate", run: "echo gate", approval: "Continue?" },
				// Re-emits the answer the run paid for before the gate, as a plain JSON copy.
				{ id: "echo", pipeline: "head --n 1", stdin: "$live.json" },
			],
		}),
		"utf8",
	);

	const env = {
		...process.env,
		LOBSTER_STATE_DIR: stateDir,
		LOBSTER_CACHE_DIR: cacheDir,
		OPENCLAW_URL: provider.url,
	};
	const ctx = () => ({
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: new PassThrough(),
		env,
		mode: "tool" as const,
		registry: createDefaultRegistry(),
	});

	try {
		const paused = await runWorkflowFile({ filePath, ctx: ctx() });
		assert.equal(paused.status, "needs_approval");
		const token = paused.requiresApproval?.resumeToken;
		assert.equal(typeof token, "string");

		const resumed = await runWorkflowFile({
			filePath,
			ctx: ctx(),
			resume: decodeToken(token as string),
			approved: true,
		});

		assert.equal(resumed.status, "ok");
		// One provider call, so one call's worth of tokens however many steps show its answer.
		assert.equal(provider.requests(), 1);
		assert.equal(resumed._meta?.cost?.totalInputTokens, 1000);
		assert.equal(resumed._meta?.cost?.totalOutputTokens, 500);
		assert.deepEqual(
			resumed._meta?.cost?.byStep.map((entry) => entry.stepId),
			["live"],
		);
	} finally {
		await provider.close();
		await fsp.rm(tmpDir, { recursive: true, force: true });
	}
});

// A settled charge is read only against the cache key it names, so restored state cannot excuse
// a call it does not name. An entry invented for one key leaves a copy of a different call
// billed exactly as it would have been.
test("restored billed charges mark only the call they name", async () => {
	const ledger = createLlmSpendLedger();
	const settled = [
		{
			cacheKey: "key-a",
			count: 1,
			model: "gpt-4o",
			usage: { inputTokens: 1000, outputTokens: 500 },
		},
	] satisfies LlmOutstandingCharge[];
	ledger.restoreSettled(settled);
	const matching = {
		cacheKey: "key-a",
		model: "gpt-4o",
		usage: { inputTokens: 1000, outputTokens: 500 },
	};
	const other = {
		cacheKey: "key-b",
		model: "gpt-4o",
		usage: { inputTokens: 1000, outputTokens: 500 },
	};
	restoreLlmProvenance({ matching, other }, settled);
	assert.deepEqual(llmProvenanceOf(matching), { cacheKey: "key-a", replayed: true });
	assert.equal(llmProvenanceOf(other), null);
	// Outside the trusted restore boundary, the same public fields remain billable.
	assert.equal(ledger.billCopy("key-a", "gpt-4o", { inputTokens: 1000, outputTokens: 500 }), true);
	assert.equal(ledger.claim("key-a"), null);
});

// What the ledger hands to a pausing run has to be readable by the run that resumes it: a
// charge already billed travels as billed, and one still open travels as open.
test("a ledger's settled and open charges survive a round trip through resume state", () => {
	const source = createLlmSpendLedger();
	source.record("billed-key", {
		stepId: "one",
		model: "gpt-4o",
		usage: { inputTokens: 100, outputTokens: 20 },
	});
	source.record("open-key", {
		stepId: "two",
		model: "gpt-4o",
		usage: { inputTokens: 300, outputTokens: 40 },
	});
	source.claim("billed-key", { model: "gpt-4o", usage: { inputTokens: 100, outputTokens: 20 } });

	const carried = JSON.parse(
		JSON.stringify({ llmSpend: source.outstanding(), llmBilled: source.settled() }),
	);
	assert.deepEqual(
		carried.llmSpend.map((charge: LlmOutstandingCharge) => charge.cacheKey),
		["open-key"],
	);
	assert.deepEqual(
		carried.llmBilled.map((charge: LlmOutstandingCharge) => charge.cacheKey),
		["billed-key"],
	);

	const resumed = createLlmSpendLedger();
	resumed.restore(carried.llmSpend);
	resumed.restoreSettled(carried.llmBilled);
	// The open charge is still the resumed run's to settle...
	assert.deepEqual(resumed.claim("open-key")?.usage, { inputTokens: 300, outputTokens: 40 });
	// ...and the trusted resume boundary restores private provenance for the billed one.
	const billedCopy = {
		cacheKey: "billed-key",
		model: "gpt-4o",
		usage: { inputTokens: 100, outputTokens: 20 },
	};
	restoreLlmProvenance(billedCopy, carried.llmBilled);
	assert.deepEqual(llmProvenanceOf(billedCopy), { cacheKey: "billed-key", replayed: true });
});

// A `wait: "any"` step keeps the first branch to answer and abandons the rest, but an abandoned
// branch is not a stopped one: it can still be waiting on a provider, and it pays when the answer
// arrives. Whether that spend reached the workflow's own total used to depend on nothing but how
// long the run happened to live afterwards, so the same workflow over the same three calls billed
// two of them or three. The discarded branch's output is thrown away and its cost goes with it.
async function runDiscardedBranchRace(finishSlowDuringRun: boolean) {
	let requests = 0;
	let slowStarted: () => void;
	const slowEntered = new Promise<void>((resolve) => (slowStarted = resolve));
	let releaseSlow: () => void;
	const slowReleased = new Promise<void>((resolve) => (releaseSlow = resolve));
	const response = {
		ok: true,
		result: {
			model: "gpt-4o",
			output: { data: { summary: "hello" } },
			usage: { inputTokens: 1000, outputTokens: 500 },
		},
	};
	let slowFinished = false;
	const slowResponse = slowReleased.then(() => {
		slowFinished = true;
		return response;
	});
	const adapter = async ({ payload }: { payload: { prompt: string } }) => {
		requests += 1;
		if (payload.prompt === "Slow") {
			slowStarted();
			return slowResponse;
		}
		if (payload.prompt === "Fast") {
			// Both calls must start, but only Fast can finish before the tail begins.
			await slowEntered;
		} else if (finishSlowDuringRun) {
			releaseSlow();
			await slowResponse;
		}
		return response;
	};
	const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-cache-"));
	try {
		const { result } = await runWorkflow(
			{
				steps: [
					{
						id: "race",
						parallel: {
							wait: "any",
							branches: [
								{ id: "fast", pipeline: "llm.invoke --model gpt-4o --prompt Fast | json" },
								{ id: "slow", pipeline: "llm.invoke --model gpt-4o --prompt Slow | json" },
							],
						},
					},
					{ id: "tail", pipeline: "llm.invoke --model gpt-4o --prompt Tail | json" },
				],
			},
			{ LOBSTER_LLM_PROVIDER: "race", LOBSTER_CACHE_DIR: cacheDir },
			{ race: adapter },
		);
		assert.equal(slowFinished, finishSlowDuringRun);
		return { result, requests };
	} finally {
		releaseSlow();
		await slowResponse;
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
}

test("workflow cost tracking leaves a discarded wait:any branch out of the total", async () => {
	// The run ends while the losing branch is still waiting on its provider.
	const ended = await runDiscardedBranchRace(false);
	// The run is still going when that branch pays.
	const running = await runDiscardedBranchRace(true);

	for (const { result, requests } of [ended, running]) {
		assert.equal(result.status, "ok");
		// All three calls really were made; only two of them are the workflow's.
		assert.equal(requests, 3);
		assert.equal(result._meta?.cost?.totalInputTokens, 2000);
		assert.equal(result._meta?.cost?.totalOutputTokens, 1000);
		assert.deepEqual(
			result._meta?.cost?.byStep.map((entry) => entry.stepId),
			["fast", "tail"],
		);
	}

	// The total is the same either way: it does not turn on the losing branch's timing.
	assert.equal(
		ended.result._meta?.cost?.totalInputTokens,
		running.result._meta?.cost?.totalInputTokens,
	);
});
