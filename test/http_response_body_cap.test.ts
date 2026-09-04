import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { HTTP_RESPONSE_MAX_BYTES, readResponseTextCapped } from "../src/read_response_text.js";

const OVER_LIMIT_BYTES = HTTP_RESPONSE_MAX_BYTES + 1;

function streamOf(items: unknown[]) {
	return (async function* () {
		for (const item of items) yield item;
	})();
}

function invokeCtx(registry: ReturnType<typeof createDefaultRegistry>) {
	return {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		env: process.env,
		registry,
		mode: "tool" as const,
		render: { json() {}, lines() {} },
	};
}

function listen(server: http.Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			resolve(typeof addr === "object" && addr ? addr.port : 0);
		});
	});
}

function closeServer(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
}

function repeatingStream(chunkBytes: number, onPull?: () => void): ReadableStream<Uint8Array> {
	const chunk = new Uint8Array(chunkBytes).fill(0x61);
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			onPull?.();
			controller.enqueue(chunk);
		},
	});
}

test("readResponseTextCapped rejects Content-Length over the cap without reading the body", async () => {
	let pulls = 0;
	const res = new Response(
		repeatingStream(1024, () => {
			pulls += 1;
		}),
		{
			headers: { "content-length": String(OVER_LIMIT_BYTES) },
		},
	);

	await assert.rejects(
		() => readResponseTextCapped(res, HTTP_RESPONSE_MAX_BYTES),
		/HTTP response body exceeded 10485760 bytes/,
	);
	assert.equal(pulls, 0);
});

test("readResponseTextCapped rejects a streaming body once it passes the cap", async () => {
	const maxBytes = 4096;
	let pulledBytes = 0;
	const res = new Response(
		repeatingStream(1024, () => {
			pulledBytes += 1024;
		}),
	);

	await assert.rejects(
		() => readResponseTextCapped(res, maxBytes),
		/HTTP response body exceeded 4096 bytes/,
	);
	assert.ok(pulledBytes > maxBytes, `expected the stream to cross ${maxBytes}, got ${pulledBytes}`);
	assert.ok(
		pulledBytes <= maxBytes + 1024,
		`expected the reader to stop near the cap, got ${pulledBytes}`,
	);
});

test("readResponseTextCapped returns a small JSON body", async () => {
	const payload = JSON.stringify({ ok: true, result: { echo: "hi" } });
	const res = new Response(payload, { headers: { "content-type": "application/json" } });
	const text = await readResponseTextCapped(res, HTTP_RESPONSE_MAX_BYTES);
	assert.equal(text, payload);
	assert.deepEqual(JSON.parse(text), { ok: true, result: { echo: "hi" } });
});

test("openclaw.invoke still parses a small JSON envelope", async () => {
	const server = http.createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/tools/invoke") {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, result: [{ ok: true, echo: "small" }] }));
	});

	const port = await listen(server);
	try {
		const registry = createDefaultRegistry();
		const cmd = registry.get("openclaw.invoke");
		const result = await cmd.run({
			input: streamOf([]),
			args: {
				_: [],
				url: `http://127.0.0.1:${port}`,
				tool: "demo",
				action: "ping",
			},
			ctx: invokeCtx(registry),
		});
		const items: unknown[] = [];
		for await (const item of result.output) items.push(item);
		assert.deepEqual(items, [{ ok: true, echo: "small" }]);
	} finally {
		await closeServer(server);
	}
});

test("openclaw.invoke rejects a Content-Length over 10 MiB", async () => {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, {
			"content-type": "application/json",
			"content-length": String(OVER_LIMIT_BYTES),
		});
		res.end(Buffer.alloc(OVER_LIMIT_BYTES, 0x61));
	});

	const port = await listen(server);
	try {
		const registry = createDefaultRegistry();
		const cmd = registry.get("openclaw.invoke");
		await assert.rejects(
			cmd.run({
				input: streamOf([]),
				args: {
					_: [],
					url: `http://127.0.0.1:${port}`,
					tool: "demo",
					action: "ping",
				},
				ctx: invokeCtx(registry),
			}),
			/HTTP response body exceeded 10485760 bytes/,
		);
	} finally {
		await closeServer(server);
	}
});

test("openclaw.invoke rejects a streaming body over 10 MiB", async () => {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.write(Buffer.alloc(OVER_LIMIT_BYTES, 0x61));
		res.end();
	});

	const port = await listen(server);
	try {
		const registry = createDefaultRegistry();
		const cmd = registry.get("openclaw.invoke");
		await assert.rejects(
			cmd.run({
				input: streamOf([]),
				args: {
					_: [],
					url: `http://127.0.0.1:${port}`,
					tool: "demo",
					action: "ping",
				},
				ctx: invokeCtx(registry),
			}),
			/HTTP response body exceeded 10485760 bytes/,
		);
	} finally {
		await closeServer(server);
	}
});
