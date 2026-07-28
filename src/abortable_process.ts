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
	signal?: AbortSignal;
	notFoundMessage: string;
};

function abortError(signal: AbortSignal) {
	if (signal.reason instanceof Error) return signal.reason;
	const error = new Error("This operation was aborted");
	error.name = "AbortError";
	return error;
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
	if (!child.pid) return;

	if (process.platform === "win32") {
		const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		taskkill.once("error", () => child.kill(signal));
		taskkill.unref();
		return;
	}

	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

export function runAbortableProcess({
	command,
	argv,
	env,
	cwd,
	signal,
	notFoundMessage,
}: RunAbortableProcessOptions): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, argv, {
			env,
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			// A dedicated POSIX process group lets a cancellation reach helpers
			// that the CLI spawned and then detached from its own lifecycle.
			detached: process.platform !== "win32",
		});

		let stdout = "";
		let stderr = "";
		let cancellation: Error | undefined;
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		child.stdout?.on("data", (data) => (stdout += String(data)));
		child.stderr?.on("data", (data) => (stderr += String(data)));

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			// Keep the group-level SIGKILL timer after the direct child has exited:
			// a descendant may have ignored SIGTERM and still be running.
			if (!cancellation && forceKillTimer) clearTimeout(forceKillTimer);
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
			terminateProcessTree(child, "SIGTERM");
			forceKillTimer = setTimeout(
				() => terminateProcessTree(child, "SIGKILL"),
				ABORT_FORCE_KILL_AFTER_MS,
			);
			forceKillTimer.unref();
		};

		child.on("error", (error: NodeJS.ErrnoException) => {
			if (cancellation) return;
			if (error.code === "ENOENT") {
				fail(new Error(notFoundMessage));
				return;
			}
			fail(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (cancellation) {
				reject(cancellation);
				return;
			}
			resolve({ stdout, stderr, code });
		});

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		}
	});
}
