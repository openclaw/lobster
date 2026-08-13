import { spawn, type ChildProcess } from "node:child_process";

const ABORT_FORCE_KILL_AFTER_MS = 250;
const forceTerminationCallbacks = new WeakMap<AbortSignal, Set<() => void>>();

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
	forceTerminationSignal?: AbortSignal;
	killSignal?: NodeJS.Signals | (() => NodeJS.Signals | undefined);
	maxOutputBytes?: number;
	outputLimitMessage?: string;
	notFoundMessage: string;
};

export function forceTerminateAbortableProcesses(signal: AbortSignal) {
	for (const terminate of forceTerminationCallbacks.get(signal) ?? []) terminate();
}

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
	forceTerminationSignal,
	killSignal,
	maxOutputBytes,
	outputLimitMessage,
	notFoundMessage,
}: RunAbortableProcessOptions): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		if (
			maxOutputBytes !== undefined &&
			(!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0)
		) {
			reject(new Error("maxOutputBytes must be a non-negative safe integer"));
			return;
		}
		try {
			signal?.throwIfAborted();
		} catch (err) {
			reject(err);
			return;
		}
		const child = spawn(command, argv, {
			env,
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			// Create a dedicated POSIX process group only when this runner owns a
			// cancellation signal for it. Direct APIs without one must retain the
			// caller's terminal process group so Ctrl-C still reaches their child.
			detached: process.platform !== "win32" && signal !== undefined,
		});

		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let terminationError: Error | undefined;
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		let processClosed = false;
		let forceKillRequested = false;
		let forceKillIssued = false;
		let settled = false;
		const forceTerminationRegistrations: Set<() => void>[] = [];
		let forceTerminate: (() => void) | undefined;
		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			if (forceTerminate) {
				for (const listeners of forceTerminationRegistrations) listeners.delete(forceTerminate);
			}
		};
		const failTerminationWhenTreeIsStopped = () => {
			if (!terminationError || !processClosed || !forceKillIssued || settled) return;
			settled = true;
			cleanup();
			reject(terminationError);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const forceKill = () => {
			if (forceKillRequested) return;
			forceKillRequested = true;
			void terminateProcessTree(child, "SIGKILL").finally(() => {
				forceKillIssued = true;
				failTerminationWhenTreeIsStopped();
			});
		};
		const startTermination = (error: Error) => {
			if (settled || terminationError) return;
			terminationError = error;
			const initialKillSignal =
				(typeof killSignal === "function" ? killSignal() : killSignal) ?? "SIGTERM";
			if (initialKillSignal === "SIGKILL") {
				forceKill();
				return;
			}
			void terminateProcessTree(child, initialKillSignal);
			forceKillTimer = setTimeout(() => {
				forceKillTimer = undefined;
				forceKill();
			}, ABORT_FORCE_KILL_AFTER_MS);
		};
		forceTerminate = () => {
			if (settled) return;
			if (!terminationError) {
				terminationError = signal ? abortError(signal) : new Error("Process termination requested");
			}
			if (forceKillTimer) {
				clearTimeout(forceKillTimer);
				forceKillTimer = undefined;
			}
			forceKill();
		};
		const onAbort = () => {
			if (!signal) return;
			startTermination(abortError(signal));
		};
		const appendOutput = (stream: "stdout" | "stderr", data: string) => {
			const bytes = Buffer.byteLength(data);
			const total = stream === "stdout" ? stdoutBytes + bytes : stderrBytes + bytes;
			if (maxOutputBytes !== undefined && total > maxOutputBytes) {
				startTermination(
					new Error(outputLimitMessage ?? `Process output exceeded ${maxOutputBytes} bytes`),
				);
				return;
			}
			if (stream === "stdout") {
				stdoutBytes = total;
				stdout += data;
			} else {
				stderrBytes = total;
				stderr += data;
			}
		};

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (data: string) => appendOutput("stdout", data));
		child.stderr?.on("data", (data: string) => appendOutput("stderr", data));
		if (typeof stdin === "string") child.stdin?.write(stdin);
		child.stdin?.end();

		child.on("error", (error: NodeJS.ErrnoException) => {
			if (terminationError) {
				processClosed = true;
				failTerminationWhenTreeIsStopped();
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
			if (terminationError) {
				failTerminationWhenTreeIsStopped();
				return;
			}
			settled = true;
			cleanup();
			resolve({ stdout, stderr, code });
		});

		for (const registrationSignal of new Set(
			[signal, forceTerminationSignal].filter(
				(candidate): candidate is AbortSignal => candidate !== undefined,
			),
		)) {
			let listeners = forceTerminationCallbacks.get(registrationSignal);
			if (!listeners) {
				listeners = new Set();
				forceTerminationCallbacks.set(registrationSignal, listeners);
			}
			listeners.add(forceTerminate);
			forceTerminationRegistrations.push(listeners);
		}

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		}
	});
}
