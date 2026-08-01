import { randomUUID } from "node:crypto";

import { encodeToken } from "./token.js";
import {
	cleanupApprovalIndexByStateKey,
	consumeResumeState,
	createApprovalIndex,
	deleteResumeStateWithRollback,
	deleteStateJson,
	isConsumedResumeState,
	readStateJsonWithLock,
	restoreConsumedResumeState,
	writeStateJson,
} from "./state/store.js";
import { compileCached } from "./validation.js";
import { validateCommandInputState, type CommandInputState } from "./input_request.js";

export type PipelineResumeState = {
	pipeline: Array<{ name: string; args: Record<string, unknown>; raw: string }>;
	resumeAtIndex: number;
	items: unknown[];
	haltType?: "approval_request" | "input_request";
	resumeMode?: "next_stage" | "same_stage";
	inputSchema?: unknown;
	prompt?: string;
	commandInput?: CommandInputState;
	supersededResumeStateKeys?: string[];
	createdAt: string;
};

export type PipelineApprovalRequest = {
	type: "approval_request";
	prompt: string;
	items: unknown[];
	preview?: string;
};

export type PipelineInputRequest = {
	type: "input_request";
	prompt: string;
	responseSchema: unknown;
	defaults?: unknown;
	subject?: unknown;
	items?: unknown[];
	commandInput?: CommandInputState;
};

export type PipelineRunOutput = {
	items: unknown[];
	halted?: boolean;
	haltedAt?: { index: number } | null;
	executionStarted?: boolean;
};

export type PipelineToolRunResolution =
	| {
			status: "needs_approval";
			output: [];
			requiresApproval: {
				type: "approval_request";
				prompt: string;
				items: unknown[];
				preview?: string;
				resumeToken: string;
				approvalId?: string;
			};
			requiresInput: null;
	  }
	| {
			status: "needs_input";
			output: [];
			requiresApproval: null;
			requiresInput: {
				type: "input_request";
				prompt: string;
				responseSchema: unknown;
				defaults?: unknown;
				subject?: unknown;
				resumeToken: string;
			};
	  }
	| {
			status: "ok";
			output: unknown[];
			requiresApproval: null;
			requiresInput: null;
	  };

export function extractPipelineHalt(output: { halted?: boolean; items: unknown[] }) {
	const halted =
		output.halted && output.items.length === 1
			? (output.items[0] as Record<string, unknown>)
			: null;
	const approval =
		halted?.type === "approval_request" ? (halted as unknown as PipelineApprovalRequest) : null;
	const inputRequest =
		halted?.type === "input_request" ? (halted as unknown as PipelineInputRequest) : null;
	return { approval, inputRequest };
}

export async function finalizePipelineToolRun(params: {
	env: Record<string, string | undefined>;
	pipeline: PipelineResumeState["pipeline"];
	output: PipelineRunOutput;
	previousStateKey?: string;
	previousState?: PipelineResumeState;
	previousStateConsumed?: boolean;
	restorePreviousStateOnAbort?: boolean;
	onPreviousStateRestored?: () => void;
	signal?: AbortSignal;
}): Promise<PipelineToolRunResolution> {
	params.signal?.throwIfAborted();
	const { approval, inputRequest } = extractPipelineHalt(params.output);
	if (approval) {
		let nextStateKey: string | undefined;
		try {
			nextStateKey = await savePipelineResumeState(
				params.env,
				{
					pipeline: params.pipeline,
					resumeAtIndex: (params.output.haltedAt?.index ?? -1) + 1,
					items: approval.items,
					haltType: "approval_request",
					prompt: approval.prompt,
					supersededResumeStateKeys: collectSupersededPipelineResumeStateKeys(
						params.previousStateKey,
						params.previousState,
					),
					createdAt: new Date().toISOString(),
				},
				params.signal,
			);
			let approvalId: string | null;
			approvalId = await createApprovalIndex({ env: params.env, stateKey: nextStateKey });
			const replaced = await replacePipelineResumeState({
				env: params.env,
				previousStateKey: params.previousStateKey,
				expectedPreviousState: params.previousState,
				previousStateConsumed: params.previousStateConsumed,
				replacementStateKey: nextStateKey,
				signal: params.signal,
			});
			if (!replaced) throw new Error("Pipeline resume state not found");
			const resumeToken = encodeToken({
				protocolVersion: 1,
				v: 1,
				kind: "pipeline-resume",
				stateKey: nextStateKey,
			});
			await retirePreviousPipelineApprovalIndex(params.env, params.previousStateKey, nextStateKey);
			return {
				status: "needs_approval",
				output: [],
				requiresApproval: {
					...approval,
					resumeToken,
					...(approvalId ? { approvalId } : null),
				},
				requiresInput: null,
			};
		} catch (err) {
			if (!params.previousStateConsumed) await restorePreviousPipelineResumeState(params);
			if (nextStateKey) await discardPipelineResumeState(params.env, nextStateKey);
			throw err;
		}
	}

	if (inputRequest) {
		const resumeMode = inputRequest.commandInput ? "same_stage" : "next_stage";
		let nextStateKey: string | undefined;
		try {
			nextStateKey = await savePipelineResumeState(
				params.env,
				{
					pipeline: params.pipeline,
					resumeAtIndex:
						resumeMode === "same_stage"
							? (params.output.haltedAt?.index ?? -1)
							: (params.output.haltedAt?.index ?? -1) + 1,
					items: resumeMode === "same_stage" ? (inputRequest.items ?? []) : [],
					haltType: "input_request",
					resumeMode,
					inputSchema: inputRequest.responseSchema,
					prompt: inputRequest.prompt,
					...(inputRequest.commandInput ? { commandInput: inputRequest.commandInput } : null),
					supersededResumeStateKeys: collectSupersededPipelineResumeStateKeys(
						params.previousStateKey,
						params.previousState,
					),
					createdAt: new Date().toISOString(),
				},
				params.signal,
			);
			const replaced = await replacePipelineResumeState({
				env: params.env,
				previousStateKey: params.previousStateKey,
				expectedPreviousState: params.previousState,
				previousStateConsumed: params.previousStateConsumed,
				replacementStateKey: nextStateKey,
				signal: params.signal,
			});
			if (!replaced) throw new Error("Pipeline resume state not found");
			const resumeToken = encodeToken({
				protocolVersion: 1,
				v: 1,
				kind: "pipeline-resume",
				stateKey: nextStateKey,
			});
			await retirePreviousPipelineApprovalIndex(params.env, params.previousStateKey, nextStateKey);
			return {
				status: "needs_input",
				output: [],
				requiresApproval: null,
				requiresInput: {
					type: "input_request",
					prompt: inputRequest.prompt,
					responseSchema: inputRequest.responseSchema,
					...(inputRequest.defaults !== undefined ? { defaults: inputRequest.defaults } : null),
					...(inputRequest.subject !== undefined ? { subject: inputRequest.subject } : null),
					resumeToken,
				},
			};
		} catch (err) {
			if (!params.previousStateConsumed) await restorePreviousPipelineResumeState(params);
			if (nextStateKey) await discardPipelineResumeState(params.env, nextStateKey);
			throw err;
		}
	}

	params.signal?.throwIfAborted();
	if (params.previousStateKey) {
		try {
			if (params.previousStateConsumed) {
				await deleteStateJson({
					env: params.env,
					key: params.previousStateKey,
					signal: params.signal,
				});
				params.signal?.throwIfAborted();
			} else {
				const deleted = await deleteResumeStateWithRollback({
					env: params.env,
					key: params.previousStateKey,
					expectedState: params.previousState,
					signal: params.signal,
				});
				if (!deleted) throw new Error("Pipeline resume state not found");
			}
			await cleanupSupersededPipelineResumeStates(
				params.env,
				params.previousState?.supersededResumeStateKeys,
			);
		} catch (err) {
			if (!params.previousStateConsumed) await restorePreviousPipelineResumeState(params);
			throw err;
		}
	}
	return {
		status: "ok",
		output: params.output.items,
		requiresApproval: null,
		requiresInput: null,
	};
}

export async function savePipelineResumeState(
	env: Record<string, string | undefined>,
	state: PipelineResumeState,
	signal?: AbortSignal,
) {
	const stateKey = `pipeline_resume_${randomUUID()}`;
	try {
		signal?.throwIfAborted();
		await writeStateJson({ env, key: stateKey, value: state, signal });
		signal?.throwIfAborted();
		return stateKey;
	} catch (err) {
		if (signal?.aborted) await discardPipelineResumeState(env, stateKey);
		throw err;
	}
}

async function replacePipelineResumeState({
	env,
	previousStateKey,
	expectedPreviousState,
	previousStateConsumed,
	replacementStateKey,
	signal,
}: {
	env: Record<string, string | undefined>;
	previousStateKey?: string;
	expectedPreviousState?: PipelineResumeState;
	previousStateConsumed?: boolean;
	replacementStateKey: string;
	signal?: AbortSignal;
}) {
	if (!previousStateKey || previousStateKey === replacementStateKey) {
		signal?.throwIfAborted();
		return true;
	}
	// The current resume has already crossed an unsafe boundary and owns the
	// predecessor's consumed marker. It may safely publish the next gate, but
	// must retain that marker rather than attempting a stale snapshot CAS.
	if (previousStateConsumed) {
		signal?.throwIfAborted();
		return true;
	}
	if (!expectedPreviousState) return false;

	let claimId: string | undefined;
	try {
		const consumption = await consumeResumeState({
			env,
			key: previousStateKey,
			expectedState: expectedPreviousState,
			signal,
		});
		if (!consumption.consumed) return false;
		claimId = consumption.claimId;
		// The predecessor remains as a durable tombstone until terminal cleanup.
		// A concurrent caller can therefore never turn the same approval into a
		// second successor capability.
		signal?.throwIfAborted();
		return true;
	} catch (err) {
		// A cancellation after the atomic marker publication has not exposed the
		// successor token yet. Restore only the marker created by this caller so a
		// competing transition can never be overwritten.
		if (claimId && signal?.aborted) {
			await restoreConsumedResumeState({
				env,
				key: previousStateKey,
				expectedState: expectedPreviousState,
				claimId,
			}).catch(() => {});
		}
		throw err;
	}
}

async function restorePreviousPipelineResumeState({
	env,
	previousStateKey,
	previousState,
	restorePreviousStateOnAbort,
	onPreviousStateRestored,
	signal,
}: {
	env: Record<string, string | undefined>;
	previousStateKey?: string;
	previousState?: PipelineResumeState;
	restorePreviousStateOnAbort?: boolean;
	onPreviousStateRestored?: () => void;
	signal?: AbortSignal;
}) {
	if (!signal?.aborted || !restorePreviousStateOnAbort || !previousStateKey || !previousState) {
		return;
	}
	// Safe terminal cleanup restores its own claimed marker while still holding
	// the state lock. Never recreate a missing snapshot here: this caller may
	// have only observed it before another resume completed.
	if ((await readStateJsonWithLock({ env, key: previousStateKey, signal })) !== null) {
		onPreviousStateRestored?.();
	}
}

async function retirePreviousPipelineApprovalIndex(
	env: Record<string, string | undefined>,
	previousStateKey: string | undefined,
	replacementStateKey: string,
) {
	if (!previousStateKey || previousStateKey === replacementStateKey) return;
	// This runs only after replacement deletion has passed its cancellation
	// checkpoint. Do not add a later cancellation check: the transition is
	// committed once the old approval capability is retired.
	await cleanupApprovalIndexByStateKey({ env, stateKey: previousStateKey }).catch(() => {});
}

function collectSupersededPipelineResumeStateKeys(
	previousStateKey: string | undefined,
	previousState: PipelineResumeState | undefined,
) {
	return [
		...(previousState?.supersededResumeStateKeys ?? []),
		...(previousStateKey ? [previousStateKey] : []),
	].filter((stateKey, index, all) => stateKey && all.indexOf(stateKey) === index);
}

async function cleanupSupersededPipelineResumeStates(
	env: Record<string, string | undefined>,
	stateKeys: string[] | undefined,
) {
	for (const stateKey of stateKeys ?? []) {
		try {
			// Retire only a non-executable marker after the successor itself has
			// committed. A restored state must remain available for retry.
			if (isConsumedResumeState(await readStateJsonWithLock({ env, key: stateKey }))) {
				await deleteStateJson({ env, key: stateKey });
			}
		} catch {
			// Leaving a tombstone is safe if best-effort cleanup cannot complete.
		}
	}
}

async function discardPipelineResumeState(
	env: Record<string, string | undefined>,
	stateKey: string,
) {
	await cleanupApprovalIndexByStateKey({ env, stateKey }).catch(() => {});
	await deleteStateJson({ env, key: stateKey }).catch(() => {});
}

export async function loadPipelineResumeState(
	env: Record<string, string | undefined>,
	stateKey: string,
	signal?: AbortSignal,
) {
	const stored = await readStateJsonWithLock({ env, key: stateKey, signal });
	if (!stored || typeof stored !== "object" || isConsumedResumeState(stored)) {
		throw new Error("Pipeline resume state not found");
	}
	const data = stored as Partial<PipelineResumeState>;
	if (!Array.isArray(data.pipeline)) throw new Error("Invalid pipeline resume state");
	validatePipelineShape(data.pipeline);
	if (
		typeof data.resumeAtIndex !== "number" ||
		!Number.isInteger(data.resumeAtIndex) ||
		data.resumeAtIndex < 0 ||
		data.resumeAtIndex > data.pipeline.length
	) {
		throw new Error("Invalid pipeline resume state");
	}
	if (!Array.isArray(data.items)) throw new Error("Invalid pipeline resume state");
	if (
		data.supersededResumeStateKeys !== undefined &&
		(!Array.isArray(data.supersededResumeStateKeys) ||
			data.supersededResumeStateKeys.some((stateKey) => typeof stateKey !== "string"))
	) {
		throw new Error("Invalid pipeline resume state");
	}
	if (
		data.haltType !== undefined &&
		!["approval_request", "input_request"].includes(data.haltType)
	) {
		throw new Error("Invalid pipeline resume state");
	}
	if (data.resumeMode !== undefined && !["next_stage", "same_stage"].includes(data.resumeMode)) {
		throw new Error("Invalid pipeline resume state");
	}
	if (data.haltType === "input_request") {
		if (data.inputSchema === undefined || typeof data.prompt !== "string") {
			throw new Error("Invalid pipeline resume state");
		}
		if (data.resumeMode === "same_stage") {
			if (data.resumeAtIndex >= data.pipeline.length) {
				throw new Error("Invalid pipeline resume state");
			}
			data.commandInput = validateCommandInputState(data.commandInput);
		} else if (data.commandInput !== undefined) {
			throw new Error("Invalid pipeline resume state");
		}
	} else if (data.resumeMode === "same_stage" || data.commandInput !== undefined) {
		throw new Error("Invalid pipeline resume state");
	}
	return data as PipelineResumeState;
}

export function validatePipelineInputResponse(schema: unknown, response: unknown) {
	if (schema === undefined) {
		throw new Error("pipeline input response schema is missing");
	}
	let validator;
	try {
		validator = compileCached(schema as any);
	} catch {
		throw new Error("pipeline input response schema is invalid");
	}
	const ok = validator(response);
	if (ok) return;
	const first = validator.errors?.[0];
	const pathValue = first?.instancePath || "/";
	const reason = first?.message ? ` ${first.message}` : "";
	throw new Error(`pipeline input response failed schema validation at ${pathValue}:${reason}`);
}

function validatePipelineShape(pipeline: unknown[]) {
	for (const stage of pipeline) {
		if (!stage || typeof stage !== "object") throw new Error("Invalid pipeline resume state");
		const data = stage as Record<string, unknown>;
		if (typeof data.name !== "string" || data.name.length === 0) {
			throw new Error("Invalid pipeline resume state");
		}
		if (!data.args || typeof data.args !== "object" || Array.isArray(data.args)) {
			throw new Error("Invalid pipeline resume state");
		}
		if (typeof data.raw !== "string") throw new Error("Invalid pipeline resume state");
	}
}
