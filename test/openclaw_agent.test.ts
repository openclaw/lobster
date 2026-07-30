import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createOpenClawAgentCommand,
	runOpenClawAgentCli,
} from "../src/commands/stdlib/openclaw_agent.js";

function streamOf(items: unknown[]) {
	return (async function* () {
		for (const item of items) yield item;
	})();
}

async function fileExists(filePath: string) {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function waitForFile(filePath: string, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await fileExists(filePath)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${filePath}`);
}

function processIsRunning(pid: number) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
		return state !== "Z";
	} catch {
		return false;
	}
}

test("openclaw.agent delegates agent, session, and model selection to OpenClaw", async () => {
	const calls: Array<Record<string, unknown>> = [];
	const cmd = createOpenClawAgentCommand(async (params) => {
		calls.push(params);
		return {
			runId: "run-1",
			status: "ok",
			result: { payloads: [{ text: "done" }] },
		};
	});

	const result = await cmd.run({
		input: streamOf([{ path: "src/index.ts" }, "plain text"]),
		args: {
			_: [],
			agent: "ops",
			prompt: "Review this",
			model: "openai/gpt-5.4",
			"session-key": "incident-42",
			thinking: "high",
			timeout: 45,
		},
		ctx: { env: {}, cwd: "/tmp" },
	});

	const items: unknown[] = [];
	for await (const item of result.output) items.push(item);
	assert.deepEqual(items, [
		{
			runId: "run-1",
			status: "ok",
			result: { payloads: [{ text: "done" }] },
		},
	]);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]?.argv, [
		"agent",
		"--json",
		"--message",
		'Review this\n\nPipeline input (JSONL):\n{"path":"src/index.ts"}\n"plain text"',
		"--agent",
		"ops",
		"--model",
		"openai/gpt-5.4",
		"--session-key",
		"incident-42",
		"--thinking",
		"high",
		"--timeout",
		"45",
	]);
});

test("openclaw.agent requires a message and agent or session target", async () => {
	const cmd = createOpenClawAgentCommand(async () => ({}));
	const ctx = { env: {}, cwd: "/tmp" };

	await assert.rejects(
		cmd.run({ input: streamOf([]), args: { _: [], agent: "main" }, ctx }),
		/requires --prompt/,
	);
	await assert.rejects(
		cmd.run({ input: streamOf([]), args: { _: [], prompt: "hello" }, ctx }),
		/requires --agent/,
	);
	await assert.rejects(
		cmd.run({
			input: streamOf([]),
			args: { _: [], agent: "main", prompt: "hello", timeout: 1.5 },
			ctx,
		}),
		/non-negative integer/,
	);
});

test("OpenClaw CLI runner parses structured JSON output", async () => {
	const fixturePath = path.join(process.cwd(), "test", "fixtures", "mock-openclaw-agent.mjs");
	const output = await runOpenClawAgentCli({
		executable: process.execPath,
		argv: [fixturePath, "agent", "--json", "--message", "hello"],
		cwd: process.cwd(),
		env: process.env,
	});

	assert.deepEqual(output, {
		runId: "fixture-run",
		status: "ok",
		result: { payloads: [{ text: "fixture reply" }] },
	});
});

test("OpenClaw CLI runner preserves workflow cancellation", async () => {
	const fixturePath = path.join(process.cwd(), "test", "fixtures", "mock-openclaw-agent.mjs");
	const controller = new AbortController();
	const pending = runOpenClawAgentCli({
		executable: process.execPath,
		argv: [fixturePath, "--sleep"],
		cwd: process.cwd(),
		env: process.env,
		signal: controller.signal,
	});
	controller.abort();

	await assert.rejects(pending, (error: Error) => error.name === "AbortError");
});

test(
	"OpenClaw CLI runner terminates descendant processes on cancellation",
	{ skip: process.platform === "win32" },
	async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "lobster-openclaw-agent-cancel-"));
		try {
			const fixturePath = path.join(process.cwd(), "test", "fixtures", "mock-openclaw-agent.mjs");
			const descendantStarted = path.join(dir, "descendant-started");
			const descendantCompleted = path.join(dir, "descendant-completed");
			const controller = new AbortController();
			const pending = runOpenClawAgentCli({
				executable: process.execPath,
				argv: [fixturePath, "--spawn-descendant", "--sleep"],
				cwd: process.cwd(),
				env: {
					...process.env,
					MOCK_OPENCLAW_AGENT_DESCENDANT_STARTED_FILE: descendantStarted,
					MOCK_OPENCLAW_AGENT_DESCENDANT_COMPLETED_FILE: descendantCompleted,
				},
				signal: controller.signal,
			});

			await waitForFile(descendantStarted);
			const descendantPid = Number(await readFile(descendantStarted, "utf8"));
			controller.abort();
			await assert.rejects(pending, (error: Error) => error.name === "AbortError");
			await new Promise((resolve) => setTimeout(resolve, 700));
			assert.equal(processIsRunning(descendantPid), false);
			assert.equal(
				await fileExists(descendantCompleted),
				false,
				"the OpenClaw child process must not outlive cancellation",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);
