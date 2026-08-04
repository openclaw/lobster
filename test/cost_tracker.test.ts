import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { CostTracker } from "../src/core/cost_tracker.js";
import { runWorkflowFile } from "../src/workflows/file.js";

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

async function runWorkflow(workflow: unknown, envOverride?: Record<string, string>) {
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
async function startFakeProvider(holdUntil = 1) {
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
								output: { data: { summary: "hello" } },
								usage: { inputTokens: 1000, outputTokens: 500 },
							},
						},
					}),
				);
			};
			held.push(answer);
			if (requests >= holdUntil) releaseHeld();
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

// `... | json` is a supported step shape: the renderer prints the items and returns an empty
// stream, so the workflow reads the step's JSON back from stdout. Accounting must still tell a
// replay from a live call there, and must still bill output that only looks replayed.
async function emitJsonPath(payload: unknown) {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-cost-emit-"));
	const filePath = path.join(dir, "emit.mjs");
	const literal = JSON.stringify(JSON.stringify(payload));
	await fsp.writeFile(filePath, `process.stdout.write(${literal});\n`, "utf8");
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
		assert.equal(first.result._meta?.cost, undefined);

		const second = await runWorkflow({ steps: [{ id: "replays", pipeline: invoke }] }, env);
		assert.equal(second.result.status, "ok");
		assert.equal(provider.requests(), 1);
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
