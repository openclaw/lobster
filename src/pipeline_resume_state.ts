import { randomUUID } from "node:crypto";

import { encodeToken } from "./token.js";
import {
	cleanupApprovalIndexByStateKey,
	createApprovalIndex,
	deleteStateJson,
	readStateJson,
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
					createdAt: new Date().toISOString(),
				},
				params.signal,
			);
			let approvalId: string | null;
			approvalId = await createApprovalIndex({ env: params.env, stateKey: nextStateKey });
			await replacePipelineResumeState({
				env: params.env,
				previousStateKey: params.previousStateKey,
				replacementStateKey: nextStateKey,
				signal: params.signal,
			});
			const resumeToken = encodeToken({
				protocolVersion: 1,
				v: 1,
				kind: "pipeline-resume",
				stateKey: nextStateKey,
			});
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
			await restorePreviousPipelineResumeState(params);
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
					createdAt: new Date().toISOString(),
				},
				params.signal,
			);
			await replacePipelineResumeState({
				env: params.env,
				previousStateKey: params.previousStateKey,
				replacementStateKey: nextStateKey,
				signal: params.signal,
			});
			const resumeToken = encodeToken({
				protocolVersion: 1,
				v: 1,
				kind: "pipeline-resume",
				stateKey: nextStateKey,
			});
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
			await restorePreviousPipelineResumeState(params);
			if (nextStateKey) await discardPipelineResumeState(params.env, nextStateKey);
			throw err;
		}
	}

	params.signal?.throwIfAborted();
	if (params.previousStateKey) {
		await cleanupApprovalIndexByStateKey({ env: params.env, stateKey: params.previousStateKey });
		await deleteStateJson({ env: params.env, key: params.previousStateKey });
	}
	params.signal?.throwIfAborted();
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
	replacementStateKey,
	signal,
}: {
	env: Record<string, string | undefined>;
	previousStateKey?: string;
	replacementStateKey: string;
	signal?: AbortSignal;
}) {
	if (previousStateKey && previousStateKey !== replacementStateKey) {
		await deleteStateJson({ env, key: previousStateKey });
	}
	signal?.throwIfAborted();
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
	await writeStateJson({ env, key: previousStateKey, value: previousState });
	onPreviousStateRestored?.();
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
) {
	const stored = await readStateJson({ env, key: stateKey });
	if (!stored || typeof stored !== "object") {
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
