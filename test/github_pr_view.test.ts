import test from "node:test";
import { waitForPid } from "./helpers/wait_for_pid.js";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { spawnSync } from "node:child_process";
import { access, chmod, copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Lobster } from "../src/sdk/Lobster.js";
import { ghPrView, prMonitor, prMonitorNotify } from "../src/recipes/github/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function emptyInput() {
	return (async function* () {})();
}

async function fileExists(path: string) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
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

test(
	"ghPrView abort signal kills a stuck gh child",
	{ skip: process.platform === "win32" },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "lobster-gh-pr-view-abort-"));
		try {
			const repoRoot = join(__dirname, "..", "..");
			const mockGh = join(repoRoot, "test", "fixtures", "mock-gh-cancellation.mjs");
			const ghBin = join(dir, "gh");
			const started = join(dir, "gh-started");
			const terminated = join(dir, "gh-terminated");
			const completed = join(dir, "gh-completed");
			await copyFile(mockGh, ghBin);
			await chmod(ghBin, 0o755);

			const controller = new AbortController();
			const pending = ghPrView({ repo: "openclaw/lobster", pr: 1 }).run({
				input: emptyInput(),
				ctx: {
					env: {
						...process.env,
						PATH: `${dir}:${process.env.PATH ?? ""}`,
						MOCK_GH_STARTED_FILE: started,
						MOCK_GH_TERMINATED_FILE: terminated,
						MOCK_GH_COMPLETED_FILE: completed,
						MOCK_GH_TERMINATION_DELAY_MS: "50",
						MOCK_GH_COMPLETION_DELAY_MS: "5000",
					},
					signal: controller.signal,
				},
			});

			const pid = await waitForPid(started);
			assert.equal(processIsRunning(pid), true);
			controller.abort(new Error("abort stuck gh pr view"));
			await assert.rejects(() => pending, /abort stuck gh pr view/);
			await waitUntilStopped(pid);
			assert.equal(await fileExists(completed), false, "cancelled gh must not finish");
			assert.equal(await fileExists(terminated), true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"public Lobster pipe run forwards constructor abort signal to ghPrView",
	{ skip: process.platform === "win32" },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "lobster-public-gh-pr-view-abort-"));
		try {
			const repoRoot = join(__dirname, "..", "..");
			const mockGh = join(repoRoot, "test", "fixtures", "mock-gh-cancellation.mjs");
			const ghBin = join(dir, "gh");
			const started = join(dir, "gh-started");
			const terminated = join(dir, "gh-terminated");
			const completed = join(dir, "gh-completed");
			await copyFile(mockGh, ghBin);
			await chmod(ghBin, 0o755);

			const controller = new AbortController();
			const pending = new Lobster({
				env: {
					...process.env,
					PATH: `${dir}:${process.env.PATH ?? ""}`,
					MOCK_GH_STARTED_FILE: started,
					MOCK_GH_TERMINATED_FILE: terminated,
					MOCK_GH_COMPLETED_FILE: completed,
					MOCK_GH_TERMINATION_DELAY_MS: "50",
					MOCK_GH_COMPLETION_DELAY_MS: "5000",
				},
				signal: controller.signal,
			})
				.pipe(ghPrView({ repo: "openclaw/lobster", pr: 1 }))
				.run();

			const pid = await waitForPid(started);
			assert.equal(processIsRunning(pid), true);
			controller.abort(new Error("abort public lobster gh pr view"));
			const result = await pending;
			assert.equal(result.ok, false);
			assert.match(result.error?.message ?? "", /abort public lobster gh pr view/);
			await waitUntilStopped(pid);
			assert.equal(await fileExists(completed), false, "cancelled gh must not finish");
			assert.equal(await fileExists(terminated), true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

for (const recipe of [prMonitor, prMonitorNotify]) {
	test(
		`${recipe.name} cancels its child without saving a snapshot`,
		{ skip: process.platform === "win32" },
		async () => {
			const dir = await mkdtemp(join(tmpdir(), `lobster-${recipe.name}-abort-`));
			const controller = new AbortController();
			const envBefore = { ...process.env };
			let pending: Promise<any> | undefined;
			try {
				const ghBin = join(dir, "gh");
				await copyFile(
					join(__dirname, "..", "..", "test", "fixtures", "mock-gh-cancellation.mjs"),
					ghBin,
				);
				await chmod(ghBin, 0o755);
				const started = join(dir, "started");
				const terminated = join(dir, "terminated");
				const completed = join(dir, "completed");
				Object.assign(process.env, {
					PATH: `${dir}:${process.env.PATH ?? ""}`,
					LOBSTER_STATE_DIR: join(dir, "state"),
					MOCK_GH_STARTED_FILE: started,
					MOCK_GH_TERMINATED_FILE: terminated,
					MOCK_GH_COMPLETED_FILE: completed,
					MOCK_GH_TERMINATION_DELAY_MS: "50",
					MOCK_GH_COMPLETION_DELAY_MS: "5000",
				});
				pending = recipe({ repo: "example/repo", pr: 1, signal: controller.signal }).run();
				const pid = await waitForPid(started);
				controller.abort(new Error(`cancel ${recipe.name}`));
				const result = await pending;
				assert.equal(result.ok, false);
				assert.equal(result.error.message, `cancel ${recipe.name}`);
				assert.deepEqual(result.output, []);
				assert.equal(processIsRunning(pid), false, "result must wait for child exit");
				assert.equal(await fileExists(terminated), true);
				assert.equal(await fileExists(completed), false);
				assert.deepEqual(await readdir(join(dir, "state")).catch(() => []), []);
				assert.equal(getEventListeners(controller.signal, "abort").length, 0);
			} finally {
				controller.abort();
				await pending;
				for (const key of Object.keys(process.env)) {
					if (!(key in envBefore)) delete process.env[key];
				}
				Object.assign(process.env, envBefore);
				await rm(dir, { recursive: true, force: true });
			}
		},
	);
}
