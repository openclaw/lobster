import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { runToolRequest, resumeToolRequest } from "../src/core/index.js";

const origin = "https://gateway.example";
const stage = "openclaw.invoke --tool demo --action read";
const syntheticToken = "synthetic-migration-credential";

async function fixture(t: TestContext) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lobster-credential-migration-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return {
		dir,
		env: { LOBSTER_STATE_DIR: dir, OPENCLAW_URL: origin, OPENCLAW_TOKEN: syntheticToken },
	};
}

function transport(t: TestContext) {
	const calls: { url: string; token: string | null; redirect: string | undefined }[] = [];
	t.mock.method(globalThis, "fetch", async (url: URL | string, init: RequestInit) => {
		calls.push({
			url: String(url),
			token: new Headers(init.headers).get("authorization"),
			redirect: init.redirect,
		});
		return new Response(JSON.stringify({ ok: true, result: [{ done: true }] }));
	});
	return calls;
}

async function storedBytes(dir: string): Promise<string> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	return (
		await Promise.all(
			entries.map((entry) =>
				entry.isDirectory()
					? storedBytes(path.join(dir, entry.name))
					: fs.readFile(path.join(dir, entry.name), "utf8"),
			),
		)
	).join("\n");
}

test("configured remote origin preserves environment auth and normalizes default port", async (t) => {
	const calls = transport(t);
	const { env } = await fixture(t);
	for (const pipeline of [stage, `${stage} --url https://GATEWAY.example:443/another-path`]) {
		assert.equal((await runToolRequest({ pipeline, ctx: { env } })).status, "ok");
	}
	assert.equal(calls.length, 2);
	assert.ok(
		calls.every((call) => call.token === `Bearer ${syntheticToken}` && call.redirect === "error"),
	);
});

test("legacy environment names work without adding a token to pipeline text", async (t) => {
	const calls = transport(t);
	const { dir } = await fixture(t);
	const result = await runToolRequest({
		pipeline: stage.replace("openclaw.invoke", "clawd.invoke"),
		ctx: {
			env: {
				LOBSTER_STATE_DIR: dir,
				OPENCLAW_URL: undefined,
				OPENCLAW_TOKEN: undefined,
				CLAWD_URL: origin,
				CLAWD_TOKEN: syntheticToken,
			},
		},
	});
	assert.equal(result.status, "ok");
	assert.equal(calls[0]?.token, `Bearer ${syntheticToken}`);
});

test("different origin, port, scheme, lookalike and missing configured URL fail before dispatch", async (t) => {
	const calls = transport(t);
	const { env } = await fixture(t);
	for (const url of [
		"https://other.example",
		"http://gateway.example",
		"https://gateway.example:444",
		"https://gateway.example.evil.example",
		"https://gateway.example@other.example",
	]) {
		assert.equal(
			(await runToolRequest({ pipeline: `${stage} --url ${url}`, ctx: { env } })).ok,
			false,
		);
	}
	assert.equal(
		(
			await runToolRequest({
				pipeline: `${stage} --url ${origin}`,
				ctx: { env: { ...env, OPENCLAW_URL: undefined } },
			})
		).ok,
		false,
	);
	assert.equal(calls.length, 0);
});

test("workflow and step env cannot redefine the trusted origin", async (t) => {
	const calls = transport(t);
	const { dir, env } = await fixture(t);
	for (const level of ["workflow", "step"]) {
		const filePath = path.join(dir, `${level}.json`);
		await fs.writeFile(
			filePath,
			JSON.stringify({
				name: level,
				...(level === "workflow" ? { env: { OPENCLAW_URL: "https://other.example" } } : {}),
				steps: [
					{
						id: "invoke",
						pipeline: stage,
						...(level === "step" ? { env: { OPENCLAW_URL: "https://other.example" } } : {}),
					},
				],
			}),
		);
		assert.equal((await runToolRequest({ filePath, ctx: { env } })).ok, false);
	}
	assert.equal(calls.length, 0);
});

test("nested workflows preserve the original origin and a missing origin stays untrusted", async (t) => {
	const calls = transport(t);
	const { dir, env } = await fixture(t);
	const child = path.join(dir, "child.json");
	const parent = path.join(dir, "parent.json");
	await fs.writeFile(child, JSON.stringify({ steps: [{ id: "invoke", pipeline: stage }] }));
	await fs.writeFile(
		parent,
		JSON.stringify({
			steps: [
				{ id: "child", workflow: "child.json", env: { OPENCLAW_URL: "https://other.example" } },
			],
		}),
	);
	assert.equal((await runToolRequest({ filePath: parent, ctx: { env } })).ok, false);
	await fs.writeFile(
		parent,
		JSON.stringify({
			env: { OPENCLAW_URL: origin },
			steps: [{ id: "child", workflow: "child.json" }],
		}),
	);
	assert.equal(
		(await runToolRequest({ filePath: parent, ctx: { env: { ...env, OPENCLAW_URL: undefined } } }))
			.ok,
		false,
	);
	assert.equal(calls.length, 0);
	assert.equal((await runToolRequest({ filePath: parent, ctx: { env } })).status, "ok");
	assert.equal(calls.length, 1);
});

test("malformed and userinfo-bearing configured origins do not establish trust", async (t) => {
	const calls = transport(t);
	const { env } = await fixture(t);
	for (const configured of [
		"not a URL",
		"file:///tmp/gateway",
		"https://user:password@gateway.example",
	]) {
		assert.equal(
			(
				await runToolRequest({
					pipeline: `${stage} --url ${origin}`,
					ctx: { env: { ...env, OPENCLAW_URL: configured } },
				})
			).ok,
			false,
		);
	}
	assert.equal(calls.length, 0);
});

test("parallel and loop steps cannot replace the captured credential origin", async (t) => {
	const calls = transport(t);
	const { dir, env } = await fixture(t);
	const badStep = { id: "call", pipeline: stage, env: { OPENCLAW_URL: "https://other.example" } };
	for (const steps of [
		[{ id: "group", parallel: { branches: [badStep] } }],
		[
			{ id: "items", command: "echo '[1]'" },
			{ id: "loop", for_each: "$items.json", steps: [badStep] },
		],
	]) {
		const filePath = path.join(dir, "branches.json");
		await fs.writeFile(filePath, JSON.stringify({ steps }));
		const result = await runToolRequest({ filePath, ctx: { env } });
		assert.equal(result.ok, false);
		assert.match(result.error?.message ?? "", /refuses to send/);
	}
	assert.equal(calls.length, 0);
});

test("resume revalidates the operator origin instead of authorizing the old explicit destination", async (t) => {
	const calls = transport(t);
	const { env } = await fixture(t);
	const first = await runToolRequest({
		pipeline: `approve --prompt Review | ${stage} --url ${origin}`,
		ctx: { env },
	});
	assert.equal(first.status, "needs_approval");
	const token = first.requiresApproval?.resumeToken;
	assert.ok(token);
	const result = await resumeToolRequest({
		token,
		approved: true,
		ctx: { env: { ...env, OPENCLAW_URL: "https://replacement.example" } },
	});
	assert.equal(result.ok, false);
	assert.match(result.error?.message ?? "", /refuses to send/);
	assert.equal(calls.length, 0);
});

for (const workflow of [false, true]) {
	test(`${workflow ? "workflow" : "pipeline"} approval resumes with rotated credential and no checkpoint secret`, async (t) => {
		const calls = transport(t);
		const { dir, env } = await fixture(t);
		const filePath = path.join(dir, "review.json");
		await fs.writeFile(
			filePath,
			JSON.stringify({
				name: "review",
				steps: [
					{ id: "review", command: "echo ready", approval: "required" },
					{ id: "invoke", pipeline: stage },
				],
			}),
		);
		const initial = await runToolRequest({
			...(workflow ? { filePath } : { pipeline: `approve --prompt Review | ${stage}` }),
			ctx: { env },
		});
		assert.equal(initial.status, "needs_approval");
		assert.equal((await storedBytes(dir)).includes(syntheticToken), false);
		assert.equal(calls.length, 0);
		const token = initial.requiresApproval?.resumeToken;
		assert.ok(token);
		const resumed = await resumeToolRequest({
			token,
			approved: true,
			ctx: { env: { ...env, OPENCLAW_TOKEN: "synthetic-rotated" } },
		});
		assert.equal(resumed.status, "ok");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.token, "Bearer synthetic-rotated");
		assert.equal((await storedBytes(dir)).includes("synthetic-rotated"), false);
	});
}

test("inherited credentials reject redirects while explicit-token behavior is unchanged", async (t) => {
	const seen: string[] = [];
	const server = http.createServer((req, res) => {
		seen.push(`${req.url}:${req.headers.authorization}`);
		if (req.url === "/tools/invoke") {
			res.writeHead(307, { location: "/redirected" });
			res.end();
		} else {
			res.end(JSON.stringify({ ok: true, result: [] }));
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}`;
	const { env } = await fixture(t);
	assert.equal(
		(await runToolRequest({ pipeline: stage, ctx: { env: { ...env, OPENCLAW_URL: url } } })).ok,
		false,
	);
	assert.equal(seen.length, 1);
	assert.equal(
		(
			await runToolRequest({
				pipeline: `${stage} --url ${url} --token synthetic-explicit`,
				ctx: { env },
			})
		).status,
		"ok",
	);
	assert.equal(seen.length, 3);
	assert.equal(seen[2], "/redirected:Bearer synthetic-explicit");
});
