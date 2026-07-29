import { spawn, type ChildProcess } from "node:child_process";

const ABORT_FORCE_KILL_AFTER_MS = 250;

type ProcessResult = {
	stdout: string;
	stderr: string;
	code: number | null;
};

type RunAbortableProcessOptions = {
	command: string;
	argv: string[];
	env: NodeJS.ProcessEnv;
	cwd?: string;
	stdin?: string | null;
	signal?: AbortSignal;
	killSignal?: NodeJS.Signals;
	notFoundMessage: string;
};

function abortError(signal: AbortSignal) {
	if (signal.reason instanceof Error) return signal.reason;
	const error = new Error("This operation was aborted");
	error.name = "AbortError";
	return error;
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
	if (!child.pid) return Promise.resolve();

	if (process.platform === "win32") {
		return new Promise((resolve) => {
			const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			taskkill.once("error", () => {
				child.kill(signal);
				resolve();
			});
			taskkill.once("close", resolve);
		});
	}

	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
	return Promise.resolve();
}

export function runAbortableProcess({
	command,
	argv,
	env,
	cwd,
	stdin,
	signal,
	killSignal,
	notFoundMessage,
}: RunAbortableProcessOptions): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, argv, {
			env,
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			// A dedicated POSIX process group lets a cancellation reach helpers
			// that the CLI spawned and then detached from its own lifecycle.
			detached: process.platform !== "win32",
		});

		let stdout = "";
		let stderr = "";
		let cancellation: Error | undefined;
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		let processClosed = false;
		let forceKillIssued = false;
		let settled = false;
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (data) => (stdout += data));
		child.stderr?.on("data", (data) => (stderr += data));
		if (typeof stdin === "string") child.stdin?.write(stdin);
		child.stdin?.end();

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			if (forceKillTimer) clearTimeout(forceKillTimer);
		};
		const failCancellationWhenTreeIsStopped = () => {
			if (!cancellation || !processClosed || !forceKillIssued || settled) return;
			settled = true;
			cleanup();
			reject(cancellation);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = () => {
			if (settled || cancellation || !signal) return;
			cancellation = abortError(signal);
			const initialKillSignal = killSignal ?? "SIGTERM";
			if (initialKillSignal === "SIGKILL") {
				void terminateProcessTree(child, "SIGKILL").finally(() => {
					forceKillIssued = true;
					failCancellationWhenTreeIsStopped();
				});
				return;
			}
			void terminateProcessTree(child, initialKillSignal);
			forceKillTimer = setTimeout(() => {
				forceKillTimer = undefined;
				void terminateProcessTree(child, "SIGKILL").finally(() => {
					forceKillIssued = true;
					failCancellationWhenTreeIsStopped();
				});
			}, ABORT_FORCE_KILL_AFTER_MS);
		};

		child.on("error", (error: NodeJS.ErrnoException) => {
			if (cancellation) {
				processClosed = true;
				failCancellationWhenTreeIsStopped();
				return;
			}
			if (error.code === "ENOENT") {
				fail(new Error(notFoundMessage));
				return;
			}
			fail(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			processClosed = true;
			if (cancellation) {
				failCancellationWhenTreeIsStopped();
				return;
			}
			settled = true;
			cleanup();
			resolve({ stdout, stderr, code });
		});

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		}
	});
}
