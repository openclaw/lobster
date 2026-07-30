import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fsp } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDefaultRegistry } from "../src/commands/registry.js";

function streamOf(items: any[]) {
	return (async function* () {
		for (const item of items) yield item;
	})();
}

async function collect(iterable: AsyncIterable<any>) {
	const items = [];
	for await (const item of iterable) items.push(item);
	return items;
}

test("llm.invoke auto-detects OpenClaw provider and normalizes output", async () => {
	const registry = createDefaultRegistry();
	const cmd = registry.get("llm.invoke");
	assert.ok(cmd, "llm.invoke should be registered");
	const cacheDir = await mkdtemp(path.join(tmpdir(), "lobster-cache-"));

	const bodyLog: any[] = [];
	const server = http.createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/tools/invoke") {
			res.writeHead(404);
			res.end("nope");
			return;
		}
		let buf = "";
		req.setEncoding("utf8");
		req.on("data", (d) => (buf += d));
		req.on("end", () => {
			const parsed = JSON.parse(buf || "{}");
			bodyLog.push(parsed);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					ok: true,
					result: {
						ok: true,
						result: {
							runId: "invoke_1",
							model: parsed.args?.model,
							prompt: parsed.args?.prompt,
							output: { data: { summary: "hello" } },
						},
					},
				}),
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;

	try {
		const result = await cmd.run({
			input: streamOf([{ kind: "text", text: "doc" }]),
			args: {
				_: [],
				model: "claude-3-sonnet",
				prompt: "Summarize",
			},
			ctx: baseCtx(
				{ OPENCLAW_URL: `http://localhost:${port}`, LOBSTER_CACHE_DIR: cacheDir },
				registry,
			),
		} as any);

		const items = await collect(result.output!);
		assert.equal(items.length, 1);
		assert.equal(items[0].kind, "llm.invoke");
		assert.equal(items[0].source, "openclaw");
		assert.equal(items[0].runId, "invoke_1");
		assert.equal(items[0].output.data.summary, "hello");
		assert.equal(bodyLog.length, 1);
		assert.equal(bodyLog[0].tool, "llm-task");
		assert.equal(bodyLog[0].args.prompt, "Summarize");
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
		await closeServer(server);
	}
});

test("llm.invoke uses Pi adapter over local HTTP bridge", async () => {
	const registry = createDefaultRegistry();
	const cmd = registry.get("llm.invoke");
	assert.ok(cmd);
	const cacheDir = await mkdtemp(path.join(tmpdir(), "lobster-cache-"));

	const requestLog: any[] = [];
	const server = http.createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/invoke") {
			res.writeHead(404);
			res.end("nope");
			return;
		}
		let buf = "";
		req.setEncoding("utf8");
		req.on("data", (d) => (buf += d));
		req.on("end", () => {
			const parsed = JSON.parse(buf || "{}");
			requestLog.push(parsed);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					ok: true,
					result: {
						runId: "pi_1",
						model: parsed.model,
						prompt: parsed.prompt,
						output: {
							format: "json",
							text: '{"decision":"reply"}',
							data: { decision: "reply" },
						},
						diagnostics: { adapter: "pi" },
					},
				}),
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;

	try {
		const result = await cmd.run({
			input: streamOf([{ kind: "text", text: "draft this" }]),
			args: {
				_: [],
				provider: "pi",
				prompt: "Decide",
				"output-schema": '{"type":"object","required":["decision"]}',
			},
			ctx: baseCtx(
				{
					LOBSTER_PI_LLM_ADAPTER_URL: `http://127.0.0.1:${port}`,
					LOBSTER_LLM_MODEL: "anthropic/claude-sonnet-4-5",
					LOBSTER_CACHE_DIR: cacheDir,
				},
				registry,
			),
		} as any);

		const items = await collect(result.output!);
		assert.equal(items.length, 1);
		assert.equal(items[0].kind, "llm.invoke");
		assert.equal(items[0].source, "pi");
		assert.equal(items[0].model, "anthropic/claude-sonnet-4-5");
		assert.equal(items[0].output.data.decision, "reply");
		assert.equal(requestLog.length, 1);
		assert.equal(requestLog[0].prompt, "Decide");
		assert.equal(requestLog[0].model, "anthropic/claude-sonnet-4-5");
		assert.equal(requestLog[0].artifacts.length, 1);
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
		await closeServer(server);
	}
});

test("llm.invoke does not retry schema validation after adapter cancellation", async () => {
	const registry = createDefaultRegistry();
	const cmd = registry.get("llm.invoke");
	assert.ok(cmd);
	const controller = new AbortController();
	let calls = 0;

	await assert.rejects(
		cmd.run({
			input: streamOf([]),
			args: {
				_: [],
				provider: "cancel-test",
				prompt: "Decide",
				"output-schema": '{"type":"object","required":["decision"]}',
				"max-validation-retries": 2,
			},
			ctx: {
				...baseCtx({}, registry),
				signal: controller.signal,
				llmAdapters: {
					"cancel-test": {
						source: "cancel-test",
						async invoke() {
							calls += 1;
							controller.abort(new Error("adapter cancelled during validation"));
							return {
								ok: true,
								result: {
									runId: "cancelled-attempt",
									output: { data: { unexpected: true } },
								},
							};
						},
					},
				},
			},
		} as any),
		/adapter cancelled during validation/,
	);
	assert.equal(calls, 1, "cancellation after an invalid response must suppress retries");
});

test("llm.invoke does not publish a reusable cache entry when cancellation races cache commit", async () => {
	const registry = createDefaultRegistry();
	const cmd = registry.get("llm.invoke");
	assert.ok(cmd);
	const cacheDir = await mkdtemp(path.join(tmpdir(), "lobster-cache-cancel-publication-"));
	const stateDir = path.join(cacheDir, "state");
	const controller = new AbortController();
	const originalRename = fsp.rename;
	let cacheCommitAborted = false;
	let calls = 0;
	const adapter = {
		source: "cache-cancel-test",
		async invoke() {
			calls += 1;
			return {
				ok: true,
				result: {
					runId: `call-${calls}`,
					output: { data: { call: calls } },
				},
			};
		},
	};
	const args = { _: [], provider: "cache-cancel-test", prompt: "Decide" };

	try {
		Object.defineProperty(fsp, "rename", {
			configurable: true,
			writable: true,
			async value(from: Parameters<typeof fsp.rename>[0], to: Parameters<typeof fsp.rename>[1]) {
				const result = await originalRename(from, to);
				if (!cacheCommitAborted && String(to).startsWith(`${cacheDir}${path.sep}`)) {
					cacheCommitAborted = true;
					controller.abort(new Error("cancelled during cache publication"));
				}
				return result;
			},
		});

		await assert.rejects(
			cmd.run({
				input: streamOf([]),
				args,
				ctx: {
					...baseCtx({ LOBSTER_CACHE_DIR: cacheDir, LOBSTER_STATE_DIR: stateDir }, registry),
					signal: controller.signal,
					llmAdapters: { "cache-cancel-test": adapter },
				},
			} as any),
			/cancelled during cache publication/,
		);
	} finally {
		Object.defineProperty(fsp, "rename", {
			configurable: true,
			writable: true,
			value: originalRename,
		});
	}

	const retried = await cmd.run({
		input: streamOf([]),
		args,
		ctx: {
			...baseCtx({ LOBSTER_CACHE_DIR: cacheDir, LOBSTER_STATE_DIR: stateDir }, registry),
			llmAdapters: { "cache-cancel-test": adapter },
		},
	} as any);
	const retriedItems = await collect(retried.output!);
	assert.equal(calls, 2, "a cancelled invocation must not satisfy a later request from cache");
	assert.equal(retriedItems[0]?.source, "cache-cancel-test");

	await rm(cacheDir, { recursive: true, force: true });
});

function baseCtx(envOverrides: Record<string, string>, registry?: any) {
	return {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		env: { ...process.env, ...envOverrides },
		registry: registry ?? null,
		mode: "tool",
		render: { json() {}, lines() {} },
	};
}

async function closeServer(server: http.Server) {
	if (!server.listening) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}
