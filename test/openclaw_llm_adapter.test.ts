import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDefaultRegistry } from "../src/commands/registry.js";

async function gateway(t, respond) {
	const requests = [];
	const cacheDir = await mkdtemp(path.join(tmpdir(), "lobster-gateway-"));
	t.after(() => rm(cacheDir, { recursive: true, force: true }));
	const server = http.createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		requests.push(JSON.parse(body));
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(respond(requests.length)));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const registry = createDefaultRegistry();
	return {
		requests,
		async run(name = "llm.invoke", args = {}) {
			const command = registry.get(name)!;
			const result = await command.run({
				input: [{ kind: "text", text: "evidence" }],
				args: { _: [], prompt: "Summarize", ...args },
				ctx: {
					env: { OPENCLAW_URL: `http://127.0.0.1:${address.port}`, LOBSTER_CACHE_DIR: cacheDir },
					registry,
				},
			} as any);
			const items = [];
			for await (const item of result.output!) items.push(item);
			return items;
		},
	};
}

function toolResult(json: unknown) {
	return {
		ok: true,
		result: {
			content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
			details: { json, provider: "test-provider", model: "test-model" },
		},
	};
}

for (const command of ["llm.invoke", "llm_task.invoke"]) {
	test(`${command} translates the OpenClaw llm-task protocol`, async (t) => {
		const { requests, run } = await gateway(t, () => toolResult({ summary: "hello" }));
		const args = { model: "test-model", temperature: 0, "max-output-tokens": 32 };
		const [item] = await run(command, args);
		assert.deepEqual(item.output.data, { summary: "hello" });
		assert.equal(item.output.format, "json");
		assert.equal(item.model, "test-model");
		assert.deepEqual(requests[0], {
			tool: "llm-task",
			action: "invoke",
			args: {
				prompt: "Summarize",
				input: [{ kind: "text", text: "evidence" }],
				model: "test-model",
				temperature: 0,
				maxTokens: 32,
			},
		});
		const [cached] = await run(command, args);
		assert.equal(cached.cached, true);
		assert.equal(requests.length, 1);
	});
}

test("OpenClaw schema validation retries remain local and feed errors back to the model", async (t) => {
	const { requests, run } = await gateway(t, (attempt) =>
		toolResult(attempt === 1 ? {} : { summary: "fixed" }),
	);
	const schema = { type: "object", required: ["summary"] };
	const [item] = await run("llm.invoke", { "output-schema": JSON.stringify(schema) });
	assert.equal(item.output.data.summary, "fixed");
	assert.equal(item.attemptCount, 2);
	assert.equal(requests.length, 2);
	assert.equal(requests[0].args.schema, undefined);
	assert.match(requests[0].args.prompt, /JSON Schema/);
	assert.ok(requests[0].args.prompt.includes(JSON.stringify(schema)));
	assert.match(requests[1].args.prompt, /summary/);
	assert.match(requests[1].args.prompt, /validationErrors/);
});

test("OpenClaw validation respects zero retry allowance", async (t) => {
	const { requests, run } = await gateway(t, () => toolResult({}));
	await assert.rejects(
		run("llm.invoke", { "output-schema": '{"required":["summary"]}', "max-validation-retries": 0 }),
		/output failed schema validation/,
	);
	assert.equal(requests.length, 1);
});

for (const json of [null, false, 0, "", [1, 2]]) {
	test(`OpenClaw preserves JSON value ${JSON.stringify(json)}`, async (t) => {
		const { run } = await gateway(t, () => toolResult(json));
		const [item] = await run();
		assert.deepEqual(item.output.data, json);
		assert.equal(item.output.format, "json");
	});
}

for (const response of [
	{ ok: true, result: { details: {} } },
	{ ok: true, result: { isError: true, details: { json: {} } } },
]) {
	test("OpenClaw rejects malformed or failed tool results", async (t) => {
		const { run } = await gateway(t, () => response);
		await assert.rejects(run(), /invalid llm-task result/);
	});
}
