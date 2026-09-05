import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { createDefaultRegistry } from "../src/commands/registry.js";
import { createOpenClawAgentCommand } from "../src/commands/stdlib/openclaw_agent.js";
import { runWorkflowFile } from "../src/workflows/file.js";

type Registry = ReturnType<typeof createDefaultRegistry>;

function withCommands(defaultRegistry: Registry, ...commands: Array<{ name: string }>) {
	return {
		get(name: string) {
			return commands.find((command) => command.name === name) ?? defaultRegistry.get(name);
		},
	};
}

async function hangUntilAbort(signal?: AbortSignal): Promise<never> {
	await new Promise<never>((_resolve, reject) => {
		const fail = () => {
			reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
		};
		if (signal?.aborted) {
			fail();
			return;
		}
		signal?.addEventListener("abort", fail, { once: true });
	});
	throw new Error("unreachable");
}

async function listen(server: http.Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Missing server address");
	}
	return address.port;
}

function hangingInvokeServer() {
	let hits = 0;
	const server = http.createServer((_req, _res) => {
		hits += 1;
	});
	return {
		server,
		get hits() {
			return hits;
		},
	};
}

async function runWorkflow(
	workflow: unknown,
	opts?: { registry?: { get: (name: string) => unknown }; env?: NodeJS.ProcessEnv },
) {
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lobster-dispatch-retry-"));
	const stateDir = path.join(tmpDir, "state");
	const filePath = path.join(tmpDir, "workflow.lobster");
	await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");

	const stderr = new PassThrough();
	const chunks: string[] = [];
	stderr.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));

	try {
		const result = await runWorkflowFile({
			filePath,
			ctx: {
				stdin: process.stdin,
				stdout: process.stdout,
				stderr,
				env: { ...process.env, LOBSTER_STATE_DIR: stateDir, ...opts?.env },
				mode: "tool",
				registry: opts?.registry ?? createDefaultRegistry(),
			},
		});
		return { result, stderrOutput: chunks.join("") };
	} finally {
		await fsp.rm(tmpDir, { recursive: true, force: true });
	}
}

function invokePipeline(commandName: string, port: number) {
	return `${commandName} --url http://127.0.0.1:${port} --tool message --action send --args-json '{"to":"x","message":"hi"}'`;
}

function createLegacyInvokeCommand(name: string) {
	return {
		name,
		help() {
			return "";
		},
		async run({ input, args, ctx }: { input: AsyncIterable<unknown>; args: any; ctx: any }) {
			for await (const _item of input) {
			}
			const url = String(args.url ?? "");
			const endpoint = new URL("/tools/invoke", url);
			await fetch(endpoint, {
				method: "POST",
				signal: ctx.signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					tool: String(args.tool),
					action: String(args.action),
					args: {},
				}),
			});
			return {
				output: (async function* () {})(),
			};
		},
	};
}

function createLegacyAgentCommand(runCli: (params: { signal?: AbortSignal }) => Promise<unknown>) {
	return {
		name: "openclaw.agent",
		help() {
			return "";
		},
		async run({ input, ctx }: { input: AsyncIterable<unknown>; args: any; ctx: any }) {
			for await (const _item of input) {
			}
			await runCli({ signal: ctx?.signal });
			return {
				output: (async function* () {
					yield { ok: true };
				})(),
			};
		},
	};
}

test("without the side-effect hook, a timed-out openclaw.invoke fetch is retried", async () => {
	const hanging = hangingInvokeServer();
	const port = await listen(hanging.server);
	try {
		await assert.rejects(
			() =>
				runWorkflow(
					{
						name: "legacy-invoke-retries",
						steps: [
							{
								id: "send",
								pipeline: invokePipeline("openclaw.invoke", port),
								timeout_ms: 250,
								retry: { max: 2, delay_ms: 20 },
							},
						],
					},
					{
						registry: withCommands(
							createDefaultRegistry(),
							createLegacyInvokeCommand("openclaw.invoke"),
						),
					},
				).then((r) => r.result),
			/timed out|abort/i,
		);
		assert.equal(
			hanging.hits,
			2,
			"old invoke (no hook) must dispatch a second fetch after timeout",
		);
	} finally {
		await new Promise<void>((resolve, reject) => {
			hanging.server.close((err) => (err ? reject(err) : resolve()));
		});
	}
});

test("openclaw.invoke timeout + retry.max>1 does not dispatch a second fetch", async () => {
	const hanging = hangingInvokeServer();
	const port = await listen(hanging.server);
	try {
		await assert.rejects(
			() =>
				runWorkflow({
					name: "invoke-no-retry-after-dispatch",
					steps: [
						{
							id: "send",
							pipeline: invokePipeline("openclaw.invoke", port),
							timeout_ms: 250,
							retry: { max: 2, delay_ms: 20 },
						},
					],
				}).then((r) => r.result),
			/timed out|abort/i,
		);
		assert.equal(hanging.hits, 1, "timed-out invoke must not POST a second time");
	} finally {
		await new Promise<void>((resolve, reject) => {
			hanging.server.close((err) => (err ? reject(err) : resolve()));
		});
	}
});

test("clawd.invoke timeout + retry.max>1 does not dispatch a second fetch", async () => {
	const hanging = hangingInvokeServer();
	const port = await listen(hanging.server);
	try {
		await assert.rejects(
			() =>
				runWorkflow({
					name: "clawd-invoke-no-retry-after-dispatch",
					steps: [
						{
							id: "send",
							pipeline: invokePipeline("clawd.invoke", port),
							timeout_ms: 250,
							retry: { max: 2, delay_ms: 20 },
						},
					],
				}).then((r) => r.result),
			/timed out|abort/i,
		);
		assert.equal(hanging.hits, 1, "timed-out clawd.invoke must not POST a second time");
	} finally {
		await new Promise<void>((resolve, reject) => {
			hanging.server.close((err) => (err ? reject(err) : resolve()));
		});
	}
});

test("without the side-effect hook, a timed-out openclaw.agent CLI run is retried", async () => {
	let calls = 0;
	const runCli = async ({ signal }: { signal?: AbortSignal }) => {
		calls += 1;
		await hangUntilAbort(signal);
	};
	await assert.rejects(
		() =>
			runWorkflow(
				{
					name: "legacy-agent-retries",
					steps: [
						{
							id: "agent",
							pipeline: 'openclaw.agent --agent ops --prompt "Send the update"',
							timeout_ms: 250,
							retry: { max: 2, delay_ms: 20 },
						},
					],
				},
				{ registry: withCommands(createDefaultRegistry(), createLegacyAgentCommand(runCli)) },
			).then((r) => r.result),
		/timed out|abort/i,
	);
	assert.equal(calls, 2, "old agent (no hook) must dispatch a second CLI run after timeout");
});

test("openclaw.agent timeout + retry.max>1 does not dispatch a second CLI run", async () => {
	let calls = 0;
	const cmd = createOpenClawAgentCommand(async ({ signal }) => {
		calls += 1;
		await hangUntilAbort(signal);
	});
	await assert.rejects(
		() =>
			runWorkflow(
				{
					name: "agent-no-retry-after-dispatch",
					steps: [
						{
							id: "agent",
							pipeline: 'openclaw.agent --agent ops --prompt "Send the update"',
							timeout_ms: 250,
							retry: { max: 2, delay_ms: 20 },
						},
					],
				},
				{ registry: withCommands(createDefaultRegistry(), cmd) },
			).then((r) => r.result),
		/timed out|abort/i,
	);
	assert.equal(calls, 1, "timed-out agent must not start a second CLI run");
});
