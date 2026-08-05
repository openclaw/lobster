import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

test(
	"llm.invoke aborts the in-flight adapter request when ctx.signal aborts",
	{ timeout: 20_000 },
	async () => {
		const registry = createDefaultRegistry();
		const cmd = registry.get("llm.invoke");
		assert.ok(cmd);

		const stalled = createStalledAdapter();
		await stalled.listen();

		const controller = new AbortController();
		try {
			const pending = cmd.run({
				input: streamOf([]),
				args: { _: [], provider: "http", prompt: "Summarize", "disable-cache": true },
				ctx: {
					...baseCtx(
						{ LOBSTER_LLM_ADAPTER_URL: `http://127.0.0.1:${stalled.port}/invoke` },
						registry,
					),
					signal: controller.signal,
				},
			} as any);

			await stalled.requestReceived;
			controller.abort();

			const err = await pending.then(
				() => null,
				(e: any) => e,
			);
			assert.ok(err, "llm.invoke should reject once the run is aborted");
			assert.ok(
				err.name === "AbortError" || err.code === "ABORT_ERR",
				`expected an abort error, got ${err.name}: ${err.message}`,
			);
			// The abort must stay recognizable; wrapping it hides the cancellation from
			// workflow timeout and abort handling.
			assert.doesNotMatch(String(err.message), /request failed/);
			await stalled.requestClosed;
		} finally {
			controller.abort();
			await stalled.close();
		}
	},
);

test(
	"llm.invoke stops waiting for a direct adapter that ignores ctx.signal",
	{ timeout: 20_000 },
	async () => {
		const registry = createDefaultRegistry();
		const cmd = registry.get("llm.invoke");
		assert.ok(cmd);

		let invoked = () => {};
		const adapterInvoked = new Promise<void>((resolve) => (invoked = resolve));
		// A supported ctx.llmAdapters adapter that never resolves and never looks
		// at ctx.signal.
		const stubborn = {
			invoke() {
				invoked();
				return new Promise<never>(() => {});
			},
		};

		const controller = new AbortController();
		const pending = cmd.run({
			input: streamOf([]),
			args: { _: [], provider: "stubborn", prompt: "Summarize", "disable-cache": true },
			ctx: {
				...baseCtx({}, registry),
				llmAdapters: { stubborn },
				signal: controller.signal,
			},
		} as any);

		await adapterInvoked;
		controller.abort();

		const err = await pending.then(
			() => null,
			(e: any) => e,
		);
		assert.ok(err, "llm.invoke should reject once the run is aborted");
		assert.ok(
			err.name === "AbortError" || err.code === "ABORT_ERR",
			`expected an abort error, got ${err.name}: ${err.message}`,
		);
		assert.doesNotMatch(String(err.message), /request failed/);
	},
);

test("llm.invoke does not complete from cache when ctx.signal is already aborted", async () => {
	const registry = createDefaultRegistry();
	const cmd = registry.get("llm.invoke");
	assert.ok(cmd);
	const cacheDir = await mkdtemp(path.join(tmpdir(), "lobster-cache-"));
	await mkdir(path.join(cacheDir, "llm.invoke"), { recursive: true });

	let requests = 0;
	const server = http.createServer((req, res) => {
		requests += 1;
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					ok: true,
					result: { runId: "cached_1", output: { text: "hello", data: null } },
				}),
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	const env = {
		LOBSTER_LLM_ADAPTER_URL: `http://127.0.0.1:${port}/invoke`,
		LOBSTER_CACHE_DIR: cacheDir,
	};
	const args = { _: [], provider: "http", prompt: "Summarize" };

	try {
		// Populate the cache, then repeat the same call on a cancelled run.
		const warm = await cmd.run({
			input: streamOf([]),
			args,
			ctx: baseCtx(env, registry),
		} as any);
		assert.equal((await collect(warm.output!))[0].cached, false);
		assert.equal(requests, 1);

		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			() =>
				cmd.run({
					input: streamOf([]),
					args,
					ctx: { ...baseCtx(env, registry), signal: controller.signal },
				} as any),
			(err: any) => err?.name === "AbortError" || err?.code === "ABORT_ERR",
		);
		assert.equal(requests, 1, "the cached run must not reach the adapter either");
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
		await closeServer(server);
	}
});

test("llm.invoke does not replay a cache hit when ctx.signal aborts while input is drained", async () => {
	const registry = createDefaultRegistry();
	const cmd = registry.get("llm.invoke");
	assert.ok(cmd);
	const cacheDir = await mkdtemp(path.join(tmpdir(), "lobster-cache-"));
	await mkdir(path.join(cacheDir, "llm.invoke"), { recursive: true });

	let requests = 0;
	const server = http.createServer((req, res) => {
		requests += 1;
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					ok: true,
					result: { runId: "cached_1", output: { text: "hello", data: null } },
				}),
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	const env = {
		LOBSTER_LLM_ADAPTER_URL: `http://127.0.0.1:${port}/invoke`,
		LOBSTER_CACHE_DIR: cacheDir,
	};
	const args = { _: [], provider: "http", prompt: "Summarize" };

	try {
		const warm = await cmd.run({
			input: streamOf([]),
			args,
			ctx: baseCtx(env, registry),
		} as any);
		assert.equal((await collect(warm.output!))[0].cached, false);
		assert.equal(requests, 1);

		// The step timeout fires while the upstream step is still producing input,
		// which is after the entry check and before the cache lookup.
		const controller = new AbortController();
		const abortingInput = (async function* () {
			await new Promise((resolve) => setTimeout(resolve, 5));
			controller.abort();
		})();

		await assert.rejects(
			() =>
				cmd.run({
					input: abortingInput,
					args,
					ctx: { ...baseCtx(env, registry), signal: controller.signal },
				} as any),
			(err: any) => err?.name === "AbortError" || err?.code === "ABORT_ERR",
		);
		assert.equal(requests, 1, "a cancelled run must not reach the adapter either");
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
		await closeServer(server);
	}
});

test("llm.invoke does not replay run state when ctx.signal aborts while input is drained", async () => {
	const registry = createDefaultRegistry();
	const cmd = registry.get("llm.invoke");
	assert.ok(cmd);
	const stateDir = await mkdtemp(path.join(tmpdir(), "lobster-state-"));

	let requests = 0;
	const server = http.createServer((req, res) => {
		requests += 1;
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					ok: true,
					result: { runId: "state_1", output: { text: "hello", data: null } },
				}),
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	const env = {
		LOBSTER_LLM_ADAPTER_URL: `http://127.0.0.1:${port}/invoke`,
		LOBSTER_STATE_DIR: stateDir,
	};
	const args = {
		_: [],
		provider: "http",
		prompt: "Summarize",
		"state-key": "step-1",
		"disable-cache": true,
	};

	try {
		const warm = await cmd.run({
			input: streamOf([]),
			args,
			ctx: baseCtx(env, registry),
		} as any);
		assert.equal((await collect(warm.output!))[0].cached, false);
		assert.equal(requests, 1);

		const controller = new AbortController();
		const abortingInput = (async function* () {
			await new Promise((resolve) => setTimeout(resolve, 5));
			controller.abort();
		})();

		await assert.rejects(
			() =>
				cmd.run({
					input: abortingInput,
					args,
					ctx: { ...baseCtx(env, registry), signal: controller.signal },
				} as any),
			(err: any) => err?.name === "AbortError" || err?.code === "ABORT_ERR",
		);
		assert.equal(requests, 1, "a cancelled run must not reach the adapter either");
	} finally {
		await rm(stateDir, { recursive: true, force: true });
		await closeServer(server);
	}
});

test("llm.invoke does not call the adapter when ctx.signal is already aborted", async () => {
	const registry = createDefaultRegistry();
	const cmd = registry.get("llm.invoke");
	assert.ok(cmd);

	let requests = 0;
	const server = http.createServer((req, res) => {
		requests += 1;
		req.resume();
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, result: { runId: "r1", output: { data: {} } } }));
	});

	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;

	try {
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(
			() =>
				cmd.run({
					input: streamOf([]),
					args: { _: [], provider: "http", prompt: "Summarize", "disable-cache": true },
					ctx: {
						...baseCtx({ LOBSTER_LLM_ADAPTER_URL: `http://127.0.0.1:${port}/invoke` }, registry),
						signal: controller.signal,
					},
				} as any),
			(err: any) => err?.name === "AbortError" || err?.code === "ABORT_ERR",
		);
		assert.equal(requests, 0, "an already-cancelled run must not reach the adapter");
	} finally {
		await closeServer(server);
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

// An adapter that accepts the request and never answers, so the only thing that
// can end the call is the caller cancelling it.
function createStalledAdapter() {
	const sockets = new Set<import("node:net").Socket>();
	let markReceived = () => {};
	let markClosed = () => {};
	const requestReceived = new Promise<void>((resolve) => (markReceived = resolve));
	const requestClosed = new Promise<void>((resolve) => (markClosed = resolve));

	const server = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.on("close", () => markClosed());
			markReceived();
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	return {
		requestReceived,
		requestClosed,
		port: 0,
		async listen() {
			await new Promise<void>((resolve) => server.listen(0, resolve));
			const addr = server.address();
			this.port = typeof addr === "object" && addr ? addr.port : 0;
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			if (!server.listening) return;
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function closeServer(server: http.Server) {
	if (!server.listening) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}
