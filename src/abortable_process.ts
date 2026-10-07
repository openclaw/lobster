import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { resolveInlineShellCommand } from "./shell.js";

const ABORT_FORCE_KILL_AFTER_MS = 250;
const forceTerminationCallbacks = new WeakMap<AbortSignal, Set<() => void>>();

// Capped direct SDK calls have no host AbortSignal, but their isolated children
// must still receive terminal interrupts and be killed if the host exits.
const interruptSignals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 } as const;
type InterruptSignal = keyof typeof interruptSignals;
type InterruptTarget = { stop: (signal: InterruptSignal) => Promise<void>; kill: () => void };
const interruptTargets = new Set<InterruptTarget>();
const interruptHandlers = new Map<InterruptSignal, () => void>();
const killOnExit = () => {
	for (const target of interruptTargets) target.kill();
};

function registerInterruptTarget(target: InterruptTarget): () => void {
	if (interruptTargets.size === 0) {
		process.on("exit", killOnExit);
		for (const signal of Object.keys(interruptSignals) as InterruptSignal[]) {
			const handler = () => {
				const defaultExit = process.listenerCount(signal) === 1;
				void Promise.allSettled([...interruptTargets].map((item) => item.stop(signal))).then(() => {
					if (defaultExit) process.exit(interruptSignals[signal]);
				});
			};
			interruptHandlers.set(signal, handler);
			// Observe existing once-handlers before EventEmitter removes them.
			process.prependListener(signal, handler);
		}
	}
	interruptTargets.add(target);
	return () => {
		interruptTargets.delete(target);
		if (interruptTargets.size === 0) {
			process.removeListener("exit", killOnExit);
			for (const [signal, handler] of interruptHandlers) process.removeListener(signal, handler);
			interruptHandlers.clear();
		}
	};
}

function outputLimitFromEnv(env: NodeJS.ProcessEnv): number | undefined {
	const raw = env.LOBSTER_MAX_OUTPUT_BYTES?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error("LOBSTER_MAX_OUTPUT_BYTES must be a positive safe integer (bytes)");
	}
	return value;
}

type ProcessResult = {
	stdout: string;
	stderr: string;
	code: number | null;
};

type RunAbortableOptions = {
	env: NodeJS.ProcessEnv;
	cwd?: string;
	stdin?: string | null;
	signal?: AbortSignal;
	assertInvocationCurrent?: () => void;
	onEffectDispatch?: () => void;
	forceTerminationSignal?: AbortSignal;
	killSignal?: NodeJS.Signals | (() => NodeJS.Signals | undefined);
	maxOutputBytes?: number;
	outputLimitMessage?: string;
	notFoundMessage: string;
};

type RunAbortableProcessOptions = RunAbortableOptions &
	(
		| { command: string; argv: string[]; shellCommand?: never }
		| { shellCommand: string; command?: never; argv?: never }
	);

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

export function runAbortableProcess(options: RunAbortableProcessOptions): Promise<ProcessResult> {
	const {
		env,
		cwd,
		stdin,
		signal,
		forceTerminationSignal,
		killSignal,
		maxOutputBytes: requestedMaxOutputBytes,
		outputLimitMessage,
		notFoundMessage,
	} = options;
	return new Promise((resolve, reject) => {
		if (
			requestedMaxOutputBytes !== undefined &&
			(!Number.isSafeInteger(requestedMaxOutputBytes) || requestedMaxOutputBytes < 0)
		) {
			reject(new Error("maxOutputBytes must be a non-negative safe integer"));
			return;
		}
		const envLimit = outputLimitFromEnv(env);
		const maxOutputBytes =
			envLimit === undefined
				? requestedMaxOutputBytes
				: requestedMaxOutputBytes === undefined
					? envLimit
					: Math.min(envLimit, requestedMaxOutputBytes);
		try {
			signal?.throwIfAborted();
		} catch (err) {
			reject(err);
			return;
		}
		const spawnOptions: SpawnOptionsWithoutStdio = {
			env,
			cwd,
			shell: false,
			stdio: "pipe",
			// A finite cap also owns termination, including background descendants.
			detached:
				process.platform !== "win32" && (signal !== undefined || maxOutputBytes !== undefined),
		};
		options.assertInvocationCurrent?.();
		// Keep direct argv and shell command dataflow at distinct spawn sites.
		// Merging them makes shell interpretation leak into direct executable callers.
		const child =
			"shellCommand" in options
				? (() => {
						const shell = resolveInlineShellCommand({ command: options.shellCommand, env });
						options.onEffectDispatch?.();
						return spawn(shell.command, shell.argv, spawnOptions);
					})()
				: (() => {
						options.onEffectDispatch?.();
						return spawn(options.command, options.argv, spawnOptions);
					})();

		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
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
		let unregisterInterruptTarget: (() => void) | undefined;
		let resolveStopped: () => void;
		const stopped = new Promise<void>((resolve) => {
			resolveStopped = resolve;
		});
		const cleanup = () => {
			unregisterInterruptTarget?.();
			resolveStopped();
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
		const startTermination = (error: Error, receivedSignal?: NodeJS.Signals) => {
			if (settled || terminationError) return;
			terminationError = error;
			const initialKillSignal =
				receivedSignal ??
				(typeof killSignal === "function" ? killSignal() : killSignal) ??
				"SIGTERM";
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
		const appendOutput = (stream: "stdout" | "stderr", data: Buffer) => {
			if (terminationError || settled) return;
			const bytes = data.byteLength;
			const total = stream === "stdout" ? stdoutBytes + bytes : stderrBytes + bytes;
			if (maxOutputBytes !== undefined && total > maxOutputBytes) {
				startTermination(
					new Error(
						(maxOutputBytes === requestedMaxOutputBytes ? outputLimitMessage : undefined) ??
							`Process output exceeded ${maxOutputBytes} bytes`,
					),
				);
				return;
			}
			if (stream === "stdout") {
				stdoutBytes = total;
				stdout += stdoutDecoder.write(data);
			} else {
				stderrBytes = total;
				stderr += stderrDecoder.write(data);
			}
		};

		child.stdout?.on("data", (data: Buffer) => appendOutput("stdout", data));
		child.stderr?.on("data", (data: Buffer) => appendOutput("stderr", data));
		child.stdin?.on("error", () => {});
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
			resolve({ stdout: stdout + stdoutDecoder.end(), stderr: stderr + stderrDecoder.end(), code });
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

		if (spawnOptions.detached && signal === undefined) {
			unregisterInterruptTarget = registerInterruptTarget({
				stop(receivedSignal) {
					if (terminationError) forceKill();
					else startTermination(new Error(`Received ${receivedSignal}`), receivedSignal);
					return stopped;
				},
				kill() {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							/* Already exited. */
						}
					}
				},
			});
		}

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		}
	});
}
