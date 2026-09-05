import test from "node:test";
import { waitForPid } from "./helpers/wait_for_pid.js";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Lobster } from "../src/sdk/Lobster.js";
import { exec, shell } from "../src/sdk/primitives/exec.js";
import { approve, runPipeline } from "../src/sdk/index.js";

function emptyInput() {
	return (async function* () {})();
}

function quote(value: string) {
	return JSON.stringify(value);
}

function longChildCommand() {
	const script = [
		'require("node:fs").writeFileSync(process.env.LOBSTER_EXEC_PID_FILE, String(process.pid));',
		"setTimeout(() => {}, 30000);",
	].join("");
	return `${quote(process.execPath)} -e ${quote(script)}`;
}

function processIsRunning(pid: number) {
	assert.ok(Number.isSafeInteger(pid) && pid > 0, `Invalid child PID: ${pid}`);
	if (process.platform === "darwin") {
		const result = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
		if (result.stdout?.trim().startsWith("Z")) return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntilStopped(pid: number, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processIsRunning(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Child ${pid} was still running after abort`);
}

async function runAbortableStage(stage: ReturnType<typeof exec>, signal: AbortSignal, cwd: string) {
	return stage.run({
		input: emptyInput(),
		ctx: {
			env: { ...process.env, LOBSTER_EXEC_PID_FILE: join(cwd, "pid") },
			cwd,
			signal,
		},
	});
}

test("sdk exec abort signal kills a long-running child", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-sdk-exec-abort-"));
	try {
		const pidFile = join(dir, "pid");
		const controller = new AbortController();
		const pending = runAbortableStage(
			exec(longChildCommand(), { json: false }),
			controller.signal,
			dir,
		);
		const pid = await waitForPid(pidFile);
		assert.equal(processIsRunning(pid), true);
		controller.abort(new Error("abort long exec"));
		await assert.rejects(() => pending, /abort long exec/);
		await waitUntilStopped(pid);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("sdk shell abort signal kills a long-running child", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-sdk-shell-abort-"));
	try {
		const pidFile = join(dir, "pid");
		const controller = new AbortController();
		const pending = runAbortableStage(
			shell(longChildCommand(), { json: false }),
			controller.signal,
			dir,
		);
		const pid = await waitForPid(pidFile);
		assert.equal(processIsRunning(pid), true);
		controller.abort(new Error("abort long shell"));
		await assert.rejects(() => pending, /abort long shell/);
		await waitUntilStopped(pid);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("public Lobster pipe run forwards constructor abort signal", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-public-exec-abort-"));
	try {
		const pidFile = join(dir, "pid");
		const controller = new AbortController();
		const pending = new Lobster({
			env: { ...process.env, LOBSTER_EXEC_PID_FILE: pidFile },
			signal: controller.signal,
		})
			.pipe(exec(longChildCommand(), { json: false }))
			.run();
		const pid = await waitForPid(pidFile);
		assert.equal(processIsRunning(pid), true);
		controller.abort(new Error("abort public lobster"));
		const result = await pending;
		assert.equal(result.ok, false);
		assert.match(result.error?.message ?? "", /abort public lobster/);
		await waitUntilStopped(pid);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

for (const entry of ["clone", "resume"] as const) {
	test(`SDK ${entry} preserves the signal and waits for child cleanup`, async () => {
		const dir = await mkdtemp(join(tmpdir(), `lobster-sdk-${entry}-abort-`));
		const controller = new AbortController();
		let pending: Promise<any> | undefined;
		try {
			const pidFile = join(dir, "pid");
			const workflow = new Lobster({
				env: { ...process.env, LOBSTER_EXEC_PID_FILE: pidFile },
				signal: controller.signal,
			});
			if (entry === "resume") workflow.pipe(approve());
			workflow.pipe(exec(longChildCommand(), { shell: true, json: false }));
			if (entry === "resume") {
				const first = await workflow.run();
				assert.equal(first.status, "needs_approval");
				pending = workflow.resume(first.requiresApproval!.resumeToken, { approved: true });
			} else {
				pending = workflow.clone().run();
			}
			const pid = await waitForPid(pidFile);
			controller.abort(new Error(`cancel ${entry}`));
			const result = await pending;
			assert.equal(result.ok, false);
			assert.equal(result.error.message, `cancel ${entry}`);
			assert.equal(processIsRunning(pid), false, "result must wait for process exit");
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		} finally {
			controller.abort();
			await pending;
			await rm(dir, { recursive: true, force: true });
		}
	});
}

test("pre-aborted SDK exec never starts a child", async () => {
	const dir = await mkdtemp(join(tmpdir(), "lobster-sdk-preabort-"));
	try {
		const controller = new AbortController();
		controller.abort(new Error("already cancelled"));
		const result = await new Lobster({
			env: { ...process.env, LOBSTER_EXEC_PID_FILE: join(dir, "pid") },
			signal: controller.signal,
		})
			.pipe(exec(longChildCommand(), { json: false }))
			.run();
		assert.equal(result.ok, false);
		assert.equal(result.error.message, "already cancelled");
		await assert.rejects(access(join(dir, "pid")), { code: "ENOENT" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("SDK exec preserves output and failure handling and releases abort listeners", async () => {
	const controller = new AbortController();
	const run = (command: string) =>
		new Lobster({ signal: controller.signal }).pipe(exec(command)).run();
	const success = await run(`${quote(process.execPath)} -e ${quote('console.log("[1,2]")')}`);
	assert.deepEqual(success.output, [1, 2]);
	const failed = await run(
		`${quote(process.execPath)} -e ${quote('console.error("failed");process.exit(7)')}`,
	);
	assert.equal(failed.ok, false);
	assert.match(failed.error.message, /exited with code 7: failed/);
	const missing = await run("lobster-nonexistent-executable-for-test");
	assert.equal(missing.ok, false);
	assert.match(missing.error.message, /Failed to execute .* ENOENT/);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("exported SDK runPipeline keeps signal optional and forwards supplied signals", async () => {
	const controller = new AbortController();
	for (const options of [{}, { signal: controller.signal }]) {
		const result = await runPipeline({
			pipeline: [{ name: "signal", args: {} }],
			registry: {
				get: () => ({ run: ({ ctx }: any) => ({ output: [ctx.signal === options.signal] }) }),
			},
			stdin: { isTTY: false },
			stdout: { write() {} },
			stderr: { write() {} },
			env: process.env,
			input: [],
			...options,
		});
		assert.deepEqual(result.items, [true]);
	}
});
