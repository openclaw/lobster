import { createJsonRenderer } from "./renderers/json.js";
import {
	InputRequestSuspension,
	RequestInputResumeError,
	assertRequestInputResumeConsumed,
	createInputTracker,
	createStageRequestInput,
	type CommandInputResume,
} from "./input_request.js";

export async function runPipeline({
	pipeline,
	registry,
	stdin,
	stdout,
	stderr,
	env,
	mode = "human",
	input,
	cwd = undefined,
	llmAdapters = undefined,
	signal = undefined,
	haltAfterStageOnAbort = false,
	dryRun = false,
	requestInputResume = undefined,
	requestInputEnabled = true,
	onExecutionStart = undefined,
}: {
	pipeline: any[];
	registry: any;
	stdin: any;
	stdout: any;
	stderr: any;
	env: any;
	mode?: string;
	input?: any;
	cwd?: string | undefined;
	llmAdapters?: Record<string, any> | undefined;
	signal?: AbortSignal | undefined;
	haltAfterStageOnAbort?: boolean;
	dryRun?: boolean;
	requestInputResume?: CommandInputResume | undefined;
	requestInputEnabled?: boolean;
	onExecutionStart?: (() => void) | undefined;
}) {
	if (dryRun) {
		return dryRunPipeline({ pipeline, registry, stderr });
	}

	let stream = input ?? [];
	let rendered = false;
	let halted = false;
	let haltedAt = null;
	let pipelineOutputStarted = false;
	let executionStarted = false;
	const markExecutionStarted = () => {
		if (executionStarted) return;
		executionStarted = true;
		onExecutionStart?.();
	};

	const baseCtx = {
		stdin,
		stdout,
		stderr,
		env,
		registry,
		mode,
		cwd,
		llmAdapters,
		signal,
	};

	for (let idx = 0; idx < pipeline.length; idx++) {
		if (haltAfterStageOnAbort) signal?.throwIfAborted();
		const stage = pipeline[idx];
		const command = registry.get(stage.name);
		if (!command) {
			throw new Error(`Unknown command: ${stage.name}`);
		}
		if (command.meta?.resumeSafeBeforeInput !== true) {
			markExecutionStarted();
		}

		const inputTracker = createInputTracker(stream);
		const stageResume = idx === 0 ? requestInputResume : undefined;
		let commandActive = true;
		let inactiveReason: string | undefined;
		let commandOutputStarted = false;
		let stageFinished = false;
		async function finishStage({ assertResume = true, suppressCloseErrors = false } = {}) {
			if (stageFinished) return;
			stageFinished = true;
			commandActive = false;
			inputTracker.disableReplay();
			await inputTracker.close({ suppressErrors: suppressCloseErrors });
			if (assertResume) assertRequestInputResumeConsumed(stageResume);
		}
		const stageStdout = trackWritableOutput(stdout, () => {
			pipelineOutputStarted = true;
		});
		const ctx = {
			...baseCtx,
			stdout: stageStdout,
			render: createJsonRenderer(stageStdout),
		};
		const stageCtx = {
			...ctx,
			requestInput: requestInputEnabled
				? createStageRequestInput({
						ctx,
						stageIndex: idx,
						mode,
						inputTracker,
						isCommandActive: () => commandActive,
						getInactiveReason: () => inactiveReason,
						isOutputStarted: () => pipelineOutputStarted || commandOutputStarted,
						resume: stageResume,
						onResumedInput:
							command.meta?.resumeSafeAfterInput === true ? undefined : markExecutionStarted,
					})
				: createUnsupportedRequestInput(),
		};

		let result;
		try {
			result = await command.run({ input: inputTracker.iterable, args: stage.args, ctx: stageCtx });
		} catch (err) {
			await finishStage({ assertResume: false, suppressCloseErrors: true });
			if (haltForInputRequest(err)) break;
			assertNoUnconsumedResumeAfterError(stageResume, err);
			throw err;
		}

		if (result?.rendered) {
			rendered = true;
		}

		const terminalOutput = Boolean(result?.halt);
		let stageHalted = Boolean(terminalOutput || (haltAfterStageOnAbort && signal?.aborted));
		const output = result?.output;
		if (Array.isArray(output)) {
			stream = output;
			await finishStage();
		} else if (output && idx < pipeline.length - 1 && !terminalOutput) {
			commandActive = false;
			inactiveReason = "requestInput cannot suspend from lazy output before downstream stages";
			assertRequestInputResumeConsumed(stageResume);
			const trackedOutput = trackCommandOutput(
				output,
				() => {
					commandOutputStarted = true;
				},
				() => assertRequestInputResumeConsumed(stageResume),
				(err) => assertNoUnconsumedResumeAfterError(stageResume, err),
				finishStage,
			);
			stream = haltAfterStageOnAbort
				? throwIfAbortedAfterDrain(trackedOutput, signal)
				: trackedOutput;
		} else {
			stream = output
				? trackCommandOutput(
						output,
						() => {
							commandOutputStarted = true;
						},
						() => assertRequestInputResumeConsumed(stageResume),
						(err) => assertNoUnconsumedResumeAfterError(stageResume, err),
						finishStage,
					)
				: [];
			if (!output) await finishStage();
		}

		stageHalted ||= Boolean(haltAfterStageOnAbort && signal?.aborted);
		if (stageHalted) {
			halted = true;
			haltedAt = { index: idx, stage };
			break;
		}
	}

	const items = [];
	try {
		for await (const item of stream) items.push(item);
	} catch (err) {
		if (haltForInputRequest(err)) {
			items.length = 0;
			for await (const item of stream) items.push(item);
		} else {
			throw err;
		}
	}
	if (haltAfterStageOnAbort) signal?.throwIfAborted();
	assertRequestInputResumeConsumed(requestInputResume);

	return { items, rendered, halted, haltedAt, executionStarted };

	function haltForInputRequest(err: unknown) {
		if (!(err instanceof InputRequestSuspension)) return false;
		const stageIndex = err.stageIndex;
		halted = true;
		haltedAt = {
			index: stageIndex,
			stage: pipeline[stageIndex],
			inPlace: true,
		};
		stream = streamFromItems([err.request]);
		return true;
	}
}

function dryRunPipeline({
	pipeline,
	registry,
	stderr,
}: {
	pipeline: any[];
	registry: any;
	stderr: any;
}) {
	const lines: string[] = [];
	lines.push(`[DRY RUN] Pipeline (${pipeline.length} stage${pipeline.length !== 1 ? "s" : ""}):`);

	for (let idx = 0; idx < pipeline.length; idx++) {
		const stage = pipeline[idx];
		const command = registry.get(stage.name);
		if (!command) {
			throw new Error(`Unknown command: ${stage.name}`);
		}
		const formattedArgs = stage.args ? formatStageArgs(stage.args) : "";
		const argsStr = formattedArgs ? `  args: ${formattedArgs}` : "";
		lines.push(`  ${idx + 1}. ${stage.name}${argsStr}`);
	}

	lines.push("");
	stderr.write(lines.join("\n"));
	// Return rendered:true so the CLI does not print an empty JSON array to stdout.
	return { items: [], rendered: true, halted: false, haltedAt: null, executionStarted: false };
}

function formatStageArgs(args: Record<string, unknown>) {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (key === "_") {
			const positional = Array.isArray(value) ? value : [value];
			for (const v of positional) {
				if (v !== undefined && v !== null) parts.push(String(v));
			}
		} else {
			parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
		}
	}
	return parts.join(", ");
}

function streamFromItems(items: unknown[]) {
	return (async function* () {
		for (const item of items) yield item;
	})();
}

function throwIfAbortedAfterDrain(input: AsyncIterable<unknown>, signal?: AbortSignal) {
	return (async function* () {
		const iterator = input[Symbol.asyncIterator]();
		let completed = false;
		try {
			while (true) {
				const next = await nextWithAbort(iterator, signal);
				if (next.done) {
					completed = true;
					break;
				}
				signal?.throwIfAborted();
				yield next.value;
			}
			signal?.throwIfAborted();
		} finally {
			if (!completed) await closeAfterAbortedRead(input, iterator, signal);
		}
	})();
}

type CancellableLazyOutput = {
	abort?: (reason?: unknown) => void | Promise<void>;
	awaitReturnOnAbort?: boolean;
};

async function closeAfterAbortedRead(
	input: AsyncIterable<unknown>,
	iterator: AsyncIterator<unknown>,
	signal?: AbortSignal,
) {
	const cancellable = iterator as AsyncIterator<unknown> & CancellableLazyOutput;
	const inputCancellable = input as AsyncIterable<unknown> & CancellableLazyOutput;
	const abort = cancellable.abort ?? inputCancellable.abort;
	const awaitReturnOnAbort =
		cancellable.awaitReturnOnAbort === true || inputCancellable.awaitReturnOnAbort === true;
	try {
		// A source that owns a pending timer, socket, or process can expose this
		// small cancellation hook. It must release the pending next() operation.
		if (signal?.aborted && abort) await abort(signal.reason);
		if (typeof iterator.return !== "function") return;
		const close = iterator.return();
		if (signal?.aborted && !abort && !awaitReturnOnAbort) {
			// Legacy iterators cannot interrupt an in-flight next(). Keep the
			// existing prompt cancellation behavior, while resource-owning sources
			// opt into the abort hook above so their cleanup is awaited.
			void Promise.resolve(close).catch(() => {});
			return;
		}
		await close;
	} catch (err) {
		if (!signal?.aborted) throw err;
	}
}

async function nextWithAbort(iterator: AsyncIterator<unknown>, signal?: AbortSignal) {
	if (!signal) return iterator.next();
	signal.throwIfAborted();

	let onAbort!: () => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => {
			try {
				signal.throwIfAborted();
			} catch (err) {
				reject(err);
			}
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
	if (signal.aborted) onAbort();

	try {
		return await Promise.race([iterator.next(), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function trackCommandOutput(
	output: AsyncIterable<unknown> | Iterable<unknown>,
	markOutput: () => void,
	assertResumeConsumed: () => void,
	assertNoUnconsumedResumeAfterError: (err: unknown) => void,
	finishStage: (options?: {
		assertResume?: boolean;
		suppressCloseErrors?: boolean;
	}) => Promise<void>,
) {
	const tracked = (async function* () {
		let completed = false;
		try {
			for await (const item of output) {
				assertResumeConsumed();
				markOutput();
				yield item;
			}
			completed = true;
		} catch (err) {
			await finishStage({ assertResume: false, suppressCloseErrors: true });
			assertNoUnconsumedResumeAfterError(err);
			throw err;
		} finally {
			await finishStage({ assertResume: completed });
		}
	})();
	const source = output as AsyncIterable<unknown> & CancellableLazyOutput & AsyncIterator<unknown>;
	const cancellation = {
		...(source.abort ? { abort: (reason?: unknown) => source.abort?.call(output, reason) } : null),
		...(typeof source.return === "function" ? { awaitReturnOnAbort: true } : null),
	};
	if (Object.keys(cancellation).length > 0) {
		Object.assign(tracked, cancellation);
	}
	return tracked;
}

function assertNoUnconsumedResumeAfterError(resume: CommandInputResume | undefined, err: unknown) {
	if (err instanceof RequestInputResumeError) return;
	assertRequestInputResumeConsumed(resume);
}

function trackWritableOutput(stdout: any, markOutput: () => void) {
	return new Proxy(stdout, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (prop === "write" || prop === "end") {
				return (...args: unknown[]) => {
					markOutput();
					return value.apply(target, args);
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function createUnsupportedRequestInput() {
	const requestInput = async function requestInput() {
		throw new Error("requestInput is not supported in this pipeline context");
	};
	requestInput.getSuspendedState = function getSuspendedState() {
		return undefined;
	};
	return requestInput;
}
