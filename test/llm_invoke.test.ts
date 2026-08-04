import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { promises as fsp } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { keyToPath, stableStringify } from "../src/state/store.js";

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

test("llm.invoke re-invokes the adapter when --temperature changes", async () => {
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
						runId: `pi_${requestLog.length}`,
						model: parsed.model,
						prompt: parsed.prompt,
						output: { format: "text", text: `temperature=${parsed.temperature}` },
					},
				}),
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	const ctxEnv = {
		LOBSTER_PI_LLM_ADAPTER_URL: `http://127.0.0.1:${port}`,
		LOBSTER_CACHE_DIR: cacheDir,
	};

	try {
		const runWith = async (temperature: number) => {
			const result = await cmd.run({
				input: streamOf([]),
				args: {
					_: [],
					provider: "pi",
					model: "test-model",
					prompt: "Sampling parameters matter",
					"schema-version": "v1",
					temperature,
				},
				ctx: baseCtx(ctxEnv, registry),
			} as any);
			return collect(result.output!);
		};

		const cold = await runWith(0.1);
		assert.equal(cold[0].source, "pi");
		assert.equal(requestLog.length, 1);
		assert.equal(requestLog[0].temperature, 0.1);

		const changed = await runWith(0.9);
		assert.equal(changed[0].source, "pi");
		assert.equal(requestLog.length, 2);
		assert.equal(requestLog[1].temperature, 0.9);
		assert.notEqual(changed[0].cacheKey, cold[0].cacheKey);

		const replay = await runWith(0.1);
		assert.equal(replay[0].source, "cache");
		assert.equal(replay[0].cacheKey, cold[0].cacheKey);
		assert.equal(requestLog.length, 2);
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
		await closeServer(server);
	}
});

test("llm.invoke re-invokes the adapter when --max-output-tokens changes", async () => {
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
						runId: `pi_${requestLog.length}`,
						output: { format: "text", text: `budget=${parsed.maxOutputTokens}` },
					},
				}),
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	const ctxEnv = {
		LOBSTER_PI_LLM_ADAPTER_URL: `http://127.0.0.1:${port}`,
		LOBSTER_CACHE_DIR: cacheDir,
	};

	try {
		const runWith = async (maxOutputTokens: number) => {
			const result = await cmd.run({
				input: streamOf([]),
				args: {
					_: [],
					provider: "pi",
					model: "test-model",
					prompt: "Token budget matters",
					"schema-version": "v1",
					"max-output-tokens": maxOutputTokens,
				},
				ctx: baseCtx(ctxEnv, registry),
			} as any);
			return collect(result.output!);
		};

		const cold = await runWith(64);
		assert.equal(cold[0].source, "pi");
		assert.equal(requestLog.length, 1);
		assert.equal(requestLog[0].maxOutputTokens, 64);

		const changed = await runWith(4096);
		assert.equal(changed[0].source, "pi");
		assert.equal(requestLog.length, 2);
		assert.equal(requestLog[1].maxOutputTokens, 4096);
		assert.notEqual(changed[0].cacheKey, cold[0].cacheKey);
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
		await closeServer(server);
	}
});

test("llm.invoke does not replay a cache entry written before sampling was keyed", async () => {
	const registry = createDefaultRegistry();
	const cmd = registry.get("llm.invoke");
	assert.ok(cmd);
	const cacheDir = await mkdtemp(path.join(tmpdir(), "lobster-cache-"));
	const args = {
		_: [],
		provider: "pi",
		model: "test-model",
		prompt: "Cache key stability",
		"schema-version": "v1",
	};

	// The identity earlier releases hashed: sampling parameters were absent from the payload,
	// so an answer sampled at temperature 0.9 was stored under the same key a request that
	// omits sampling computes. Reading that entry back would serve sampling nobody asked for.
	const legacyKey = createHash("sha256")
		.update(
			stableStringify({
				provider: "pi",
				prompt: "Cache key stability",
				model: "test-model",
				schemaVersion: "v1",
				artifactHashes: [],
				outputSchema: null,
			}),
		)
		.digest("hex");

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
			requestLog.push(JSON.parse(buf || "{}"));
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					ok: true,
					result: { runId: "pi_1", output: { format: "text", text: "fresh" } },
				}),
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;

	try {
		await mkdir(path.join(cacheDir, "llm.invoke"), { recursive: true });
		await writeFile(
			path.join(cacheDir, "llm.invoke", `${legacyKey}.json`),
			JSON.stringify({
				cacheKey: legacyKey,
				storedAt: "2026-08-01T00:00:00.000Z",
				items: [
					{
						kind: "llm.invoke",
						cacheKey: legacyKey,
						status: "completed",
						source: "pi",
						cached: false,
						output: { format: "text", text: "sampled at 0.9" },
					},
				],
			}),
			"utf8",
		);

		const result = await cmd.run({
			input: streamOf([]),
			args,
			ctx: baseCtx(
				{
					LOBSTER_PI_LLM_ADAPTER_URL: `http://127.0.0.1:${port}`,
					LOBSTER_CACHE_DIR: cacheDir,
				},
				registry,
			),
		} as any);

		const items = await collect(result.output!);
		assert.equal(requestLog.length, 1);
		assert.equal(items[0].source, "pi");
		assert.equal(items[0].output.text, "fresh");
		assert.notEqual(items[0].cacheKey, legacyKey);
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

test("llm.invoke aborts while waiting for its reusable run-state lock", async () => {
	const registry = createDefaultRegistry();
	const cmd = registry.get("llm.invoke");
	assert.ok(cmd);
	const cacheDir = await mkdtemp(path.join(tmpdir(), "lobster-llm-state-lock-abort-"));
	const stateDir = path.join(cacheDir, "state");
	const stateKey = "blocked-run-state";
	const lockPath = `${keyToPath(stateDir, stateKey)}.lock`;
	await fsp.mkdir(lockPath, { recursive: true });
	await fsp.writeFile(path.join(lockPath, "owner"), `${process.pid}::live-writer\n`, "utf8");

	try {
		const controller = new AbortController();
		const pending = cmd.run({
			input: streamOf([]),
			args: {
				_: [],
				provider: "state-lock-abort-test",
				prompt: "Decide",
				"state-key": stateKey,
			},
			ctx: {
				...baseCtx({ LOBSTER_CACHE_DIR: cacheDir, LOBSTER_STATE_DIR: stateDir }, registry),
				signal: controller.signal,
				llmAdapters: {
					"state-lock-abort-test": {
						source: "state-lock-abort-test",
						async invoke() {
							throw new Error("adapter must not run while the state read is locked");
						},
					},
				},
			},
		} as any);
		const completion = pending.then(
			() => ({ kind: "success" as const }),
			(error) => ({ kind: "error" as const, error }),
		);
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort(new Error("LLM state read cancelled"));
		const early = await Promise.race([
			completion,
			new Promise<{ kind: "timeout" }>((resolve) =>
				setTimeout(() => resolve({ kind: "timeout" }), 75),
			),
		]);
		if (early.kind === "timeout") await fsp.rm(lockPath, { recursive: true, force: true });
		const settled = early.kind === "timeout" ? await completion : early;
		assert.notEqual(
			early.kind,
			"timeout",
			"state-key reads must observe cancellation while locked",
		);
		assert.equal(settled.kind, "error");
		if (settled.kind === "error") {
			assert.match(settled.error?.message ?? "", /LLM state read cancelled/);
		}
	} finally {
		await fsp.rm(cacheDir, { recursive: true, force: true });
	}
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
	const args = {
		_: [],
		provider: "cache-cancel-test",
		prompt: "Decide",
		"state-key": "cancelled-cache-publication",
	};

	try {
		Object.defineProperty(fsp, "rename", {
			configurable: true,
			writable: true,
			async value(from: Parameters<typeof fsp.rename>[0], to: Parameters<typeof fsp.rename>[1]) {
				const result = await originalRename(from, to);
				if (
					!cacheCommitAborted &&
					String(to).startsWith(`${path.join(cacheDir, "llm.invoke")}${path.sep}`) &&
					String(to).endsWith(".json")
				) {
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
	assert.equal(
		calls,
		2,
		"a cancelled invocation must not satisfy a later request from cache or run state",
	);
	assert.equal(retriedItems[0]?.source, "cache-cancel-test");

	await rm(cacheDir, { recursive: true, force: true });
});

test("llm.invoke restores the previous cache entry when a refresh is cancelled after commit", async () => {
	const registry = createDefaultRegistry();
	const cmd = registry.get("llm.invoke");
	assert.ok(cmd);
	const cacheDir = await mkdtemp(path.join(tmpdir(), "lobster-cache-refresh-cancel-"));
	const stateDir = path.join(cacheDir, "state");
	let calls = 0;
	const adapter = {
		source: "cache-refresh-cancel-test",
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
	const args = {
		_: [],
		provider: "cache-refresh-cancel-test",
		prompt: "Decide",
		"state-key": "refresh-cache-publication",
	};

	try {
		const first = await cmd.run({
			input: streamOf([]),
			args,
			ctx: {
				...baseCtx({ LOBSTER_CACHE_DIR: cacheDir, LOBSTER_STATE_DIR: stateDir }, registry),
				llmAdapters: { "cache-refresh-cancel-test": adapter },
			},
		} as any);
		assert.deepEqual((await collect(first.output!))[0]?.output.data, { call: 1 });

		const controller = new AbortController();
		const originalRename = fsp.rename;
		let cacheCommitAborted = false;
		try {
			Object.defineProperty(fsp, "rename", {
				configurable: true,
				writable: true,
				async value(from: Parameters<typeof fsp.rename>[0], to: Parameters<typeof fsp.rename>[1]) {
					const result = await originalRename(from, to);
					if (
						!cacheCommitAborted &&
						String(to).startsWith(`${path.join(cacheDir, "llm.invoke")}${path.sep}`)
					) {
						cacheCommitAborted = true;
						controller.abort(new Error("cancelled during cache refresh publication"));
					}
					return result;
				},
			});

			await assert.rejects(
				cmd.run({
					input: streamOf([]),
					args: { ...args, refresh: true },
					ctx: {
						...baseCtx({ LOBSTER_CACHE_DIR: cacheDir, LOBSTER_STATE_DIR: stateDir }, registry),
						signal: controller.signal,
						llmAdapters: { "cache-refresh-cancel-test": adapter },
					},
				} as any),
				/cancelled during cache refresh publication/,
			);
		} finally {
			Object.defineProperty(fsp, "rename", {
				configurable: true,
				writable: true,
				value: originalRename,
			});
		}

		const recovered = await cmd.run({
			input: streamOf([]),
			args,
			ctx: {
				...baseCtx({ LOBSTER_CACHE_DIR: cacheDir, LOBSTER_STATE_DIR: stateDir }, registry),
				llmAdapters: { "cache-refresh-cancel-test": adapter },
			},
		} as any);
		const recoveredItems = await collect(recovered.output!);
		assert.equal(calls, 2, "the cancelled refresh must restore the existing run state");
		assert.equal(recoveredItems[0]?.source, "run_state");
		assert.deepEqual(recoveredItems[0]?.output.data, { call: 1 });

		const recoveredCache = await cmd.run({
			input: streamOf([]),
			args: { _: [], provider: "cache-refresh-cancel-test", prompt: "Decide" },
			ctx: {
				...baseCtx({ LOBSTER_CACHE_DIR: cacheDir, LOBSTER_STATE_DIR: stateDir }, registry),
				llmAdapters: { "cache-refresh-cancel-test": adapter },
			},
		} as any);
		const recoveredCacheItems = await collect(recoveredCache.output!);
		assert.equal(recoveredCacheItems[0]?.source, "cache");
		assert.deepEqual(recoveredCacheItems[0]?.output.data, { call: 1 });
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
	}
});

test("llm.invoke rolls back cache and run-state publications after a cache directory sync failure", async () => {
	const registry = createDefaultRegistry();
	const cmd = registry.get("llm.invoke");
	assert.ok(cmd);
	const cacheDir = await mkdtemp(path.join(tmpdir(), "lobster-cache-dir-sync-failure-"));
	const stateDir = path.join(cacheDir, "state");
	const cacheNamespaceDir = path.join(cacheDir, "llm.invoke");
	const originalOpen = fsp.open;
	const fault = Object.assign(new Error("cache directory sync failed"), { code: "EIO" });
	let failNextCacheDirectorySync = true;
	let calls = 0;
	const adapter = {
		source: "cache-dir-sync-test",
		async invoke() {
			calls += 1;
			return { ok: true, result: { runId: `call-${calls}`, output: { data: { call: calls } } } };
		},
	};
	const args = {
		_: [],
		provider: "cache-dir-sync-test",
		prompt: "Decide",
		"state-key": "cache-directory-sync-failure",
	};

	try {
		await fsp.mkdir(cacheNamespaceDir, { recursive: true });
		Object.defineProperty(fsp, "open", {
			configurable: true,
			writable: true,
			async value(...openArgs: any[]) {
				const handle = await (originalOpen as any)(...openArgs);
				if (
					failNextCacheDirectorySync &&
					String(openArgs[0]) === cacheNamespaceDir &&
					openArgs[1] === "r"
				) {
					failNextCacheDirectorySync = false;
					return new Proxy(handle, {
						get(target, property, receiver) {
							if (property === "sync") return async () => Promise.reject(fault);
							const value = Reflect.get(target, property, receiver);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
				}
				return handle;
			},
		});

		await assert.rejects(
			cmd.run({
				input: streamOf([]),
				args,
				ctx: {
					...baseCtx({ LOBSTER_CACHE_DIR: cacheDir, LOBSTER_STATE_DIR: stateDir }, registry),
					llmAdapters: { "cache-dir-sync-test": adapter },
				},
			} as any),
			/cache directory sync failed/,
		);
	} finally {
		Object.defineProperty(fsp, "open", {
			configurable: true,
			writable: true,
			value: originalOpen,
		});
	}

	const retried = await cmd.run({
		input: streamOf([]),
		args,
		ctx: {
			...baseCtx({ LOBSTER_CACHE_DIR: cacheDir, LOBSTER_STATE_DIR: stateDir }, registry),
			llmAdapters: { "cache-dir-sync-test": adapter },
		},
	} as any);
	const items = await collect(retried.output!);
	assert.equal(calls, 2, "a failed publication must not be reused from cache or run state");
	assert.equal(items[0]?.source, "cache-dir-sync-test");
	await rm(cacheDir, { recursive: true, force: true });
});

test("llm.invoke reads a populated cache when lock creation is forbidden", async () => {
	const registry = createDefaultRegistry();
	const cmd = registry.get("llm.invoke");
	assert.ok(cmd);
	const cacheDir = await mkdtemp(path.join(tmpdir(), "lobster-readonly-cache-"));
	const originalMkdir = fsp.mkdir;
	let calls = 0;
	const adapter = {
		source: "readonly-cache-test",
		async invoke() {
			calls += 1;
			return { ok: true, result: { runId: `call-${calls}`, output: { data: { call: calls } } } };
		},
	};
	const args = { _: [], provider: "readonly-cache-test", prompt: "Decide" };

	try {
		const first = await cmd.run({
			input: streamOf([]),
			args,
			ctx: {
				...baseCtx({ LOBSTER_CACHE_DIR: cacheDir }, registry),
				llmAdapters: { "readonly-cache-test": adapter },
			},
		} as any);
		await collect(first.output!);

		Object.defineProperty(fsp, "mkdir", {
			configurable: true,
			writable: true,
			async value(
				filePath: Parameters<typeof fsp.mkdir>[0],
				options?: Parameters<typeof fsp.mkdir>[1],
			) {
				if (String(filePath).endsWith(".lock")) {
					throw Object.assign(new Error("read-only cache directory"), { code: "EACCES" });
				}
				return originalMkdir(filePath, options);
			},
		});

		const cached = await cmd.run({
			input: streamOf([]),
			args,
			ctx: {
				...baseCtx({ LOBSTER_CACHE_DIR: cacheDir }, registry),
				llmAdapters: { "readonly-cache-test": adapter },
			},
		} as any);
		const items = await collect(cached.output!);
		assert.equal(calls, 1);
		assert.equal(items[0]?.source, "cache");
	} finally {
		Object.defineProperty(fsp, "mkdir", {
			configurable: true,
			writable: true,
			value: originalMkdir,
		});
		await rm(cacheDir, { recursive: true, force: true });
	}
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
