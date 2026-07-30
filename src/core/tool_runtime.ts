import { Writable } from "node:stream";
import path from "node:path";

import { createDefaultRegistry } from "../commands/registry.js";
import { parsePipeline } from "../parser.js";
import { decodeResumeToken, kindFromStateKey } from "../resume.js";
import { runPipeline } from "../runtime.js";
import { encodeToken } from "../token.js";
import {
	deleteStateJson,
	deleteUnconsumedResumeState,
	deleteApprovalId,
	findStateKeyByApprovalId,
	cleanupApprovalIndexByStateKey,
	consumeResumeState,
	restoreConsumedResumeState,
	stateJsonExists,
} from "../state/store.js";
import {
	WorkflowResumeArgumentError,
	alternateWorkflowResumeStateKey,
	runWorkflowFile,
} from "../workflows/file.js";
import {
	finalizePipelineToolRun,
	loadPipelineResumeState,
	validatePipelineInputResponse,
} from "../pipeline_resume_state.js";

type ToolRunContext = {
	cwd?: string;
	env?: Record<string, string | undefined>;
	mode?: "tool" | "human" | "sdk";
	stdin?: NodeJS.ReadableStream;
	stdout?: NodeJS.WritableStream;
	stderr?: NodeJS.WritableStream;
	signal?: AbortSignal;
	registry?: any;
	llmAdapters?: Record<string, any>;
};

type ToolEnvelope = {
	protocolVersion: 1;
	ok: boolean;
	status?: "ok" | "needs_approval" | "needs_input" | "cancelled";
	output?: unknown[];
	requiresApproval?: {
		type?: "approval_request";
		prompt: string;
		items: unknown[];
		preview?: string;
		resumeToken?: string;
		approvalId?: string;
	} | null;
	requiresInput?: {
		type?: "input_request";
		prompt: string;
		responseSchema: unknown;
		defaults?: unknown;
		subject?: unknown;
		resumeToken?: string;
	} | null;
	error?: {
		type: string;
		message: string;
	};
};

export async function runToolRequest({
	pipeline,
	filePath,
	args,
	ctx = {},
}: {
	pipeline?: string;
	filePath?: string;
	args?: Record<string, unknown>;
	ctx?: ToolRunContext;
}): Promise<ToolEnvelope> {
	const runtime = createToolContext(ctx);
	const hasPipeline = typeof pipeline === "string" && pipeline.trim().length > 0;
	const hasFile = typeof filePath === "string" && filePath.trim().length > 0;

	if (!hasPipeline && !hasFile) {
		return errorEnvelope("parse_error", "run requires either pipeline or filePath");
	}
	if (hasPipeline && hasFile) {
		return errorEnvelope("parse_error", "run accepts either pipeline or filePath, not both");
	}

	if (hasFile) {
		let resolvedFilePath: string;
		try {
			resolvedFilePath = await resolveWorkflowFile(filePath!, runtime.cwd);
		} catch (err: any) {
			return errorEnvelope("parse_error", err?.message ?? String(err));
		}

		try {
			const output = await runWorkflowFile({
				filePath: resolvedFilePath,
				args,
				ctx: runtime,
			});

			if (output.status === "needs_approval") {
				return okEnvelope("needs_approval", [], output.requiresApproval ?? null, null);
			}
			if (output.status === "needs_input") {
				return okEnvelope("needs_input", [], null, output.requiresInput ?? null);
			}
			if (output.status === "cancelled") {
				return okEnvelope("cancelled", [], null, null);
			}
			return okEnvelope("ok", output.output, null, null);
		} catch (err: any) {
			return errorEnvelope("runtime_error", err?.message ?? String(err));
		}
	}

	let parsed;
	try {
		parsed = parsePipeline(String(pipeline));
	} catch (err: any) {
		return errorEnvelope("parse_error", err?.message ?? String(err));
	}

	try {
		const output = await runPipeline({
			pipeline: parsed,
			registry: runtime.registry,
			input: [],
			stdin: runtime.stdin,
			stdout: runtime.stdout,
			stderr: runtime.stderr,
			env: runtime.env,
			mode: "tool",
			cwd: runtime.cwd,
			llmAdapters: runtime.llmAdapters,
			signal: runtime.signal,
			haltAfterStageOnAbort: true,
		});

		const finalized = await finalizePipelineToolRun({
			env: runtime.env,
			pipeline: parsed,
			output,
			signal: runtime.signal,
		});
		return okEnvelope(
			finalized.status,
			finalized.output,
			finalized.requiresApproval,
			finalized.requiresInput,
		);
	} catch (err: any) {
		return errorEnvelope("runtime_error", err?.message ?? String(err));
	}
}

export async function resumeToolRequest({
	token,
	approvalId,
	approved,
	response,
	cancel,
	ctx = {},
}: {
	token?: string;
	approvalId?: string;
	approved?: boolean;
	response?: unknown;
	cancel?: boolean;
	ctx?: ToolRunContext;
}): Promise<ToolEnvelope> {
	const runtime = createToolContext(ctx);
	let payload: any;
	let resolvedApprovalId = approvalId ?? null;

	try {
		// Resolve short approval ID to token if provided
		let resolvedToken: string;
		if (approvalId) {
			const stateKey = await findStateKeyByApprovalId({ env: runtime.env, approvalId });
			if (!stateKey) {
				return errorEnvelope("parse_error", `Approval ID "${approvalId}" not found or expired`);
			}
			const kind = kindFromStateKey(stateKey);
			resolvedToken = encodeToken({
				protocolVersion: 1,
				v: 1,
				kind,
				stateKey,
			});
		} else if (token) {
			resolvedToken = token;
		} else {
			return errorEnvelope("parse_error", "resume requires token or approvalId");
		}
		payload = decodeResumeToken(resolvedToken);
	} catch (err: any) {
		return errorEnvelope("parse_error", err?.message ?? String(err));
	}

	// Helper: clean up approval ID index after successful use
	const cleanupIndex = async (stateKey = payload?.stateKey) => {
		if (resolvedApprovalId) {
			await deleteApprovalId({ env: runtime.env, approvalId: resolvedApprovalId });
		} else if (stateKey) {
			await cleanupApprovalIndexByStateKey({ env: runtime.env, stateKey });
		}
	};

	if (cancel === true) {
		let stateKeys = [payload.stateKey];
		if (payload.kind === "workflow-file") {
			const alternateStateKey = alternateWorkflowResumeStateKey(payload.stateKey);
			if (alternateStateKey) {
				// Delete a non-authoritative spelling first. If cancellation interrupts
				// its lock wait, the state that makes this capability resumable remains.
				const [primaryExists, alternateExists] = await Promise.all([
					stateJsonExists({ env: runtime.env, key: payload.stateKey }),
					stateJsonExists({ env: runtime.env, key: alternateStateKey }),
				]);
				if (primaryExists || !alternateExists) {
					stateKeys = [alternateStateKey, payload.stateKey];
				} else {
					stateKeys = [payload.stateKey, alternateStateKey];
				}
			}
		}
		// Keep the capability indexed until every state deletion succeeds. A
		// cancelled request must not orphan a resume state by dropping its
		// approval ID while waiting on another writer's state lock.
		const deletionResults = [];
		for (const stateKey of new Set(stateKeys)) {
			deletionResults.push(
				await deleteUnconsumedResumeState({
					env: runtime.env,
					key: stateKey,
					signal: runtime.signal,
				}),
			);
		}
		if (
			deletionResults.includes("claimed") ||
			deletionResults.every((result) => result === "missing")
		) {
			return errorEnvelope("runtime_error", "Resume state not found");
		}
		if (resolvedApprovalId) {
			await cleanupIndex();
		} else {
			for (const stateKey of stateKeys) await cleanupIndex(stateKey);
		}
		return okEnvelope("cancelled", [], null, null);
	}

	if (payload.kind === "workflow-file") {
		let workflowResumeStateKey = payload.stateKey;
		try {
			const output = await runWorkflowFile({
				filePath: payload.filePath,
				ctx: {
					...runtime,
					_onResumeStateResolved: (stateKey) => {
						workflowResumeStateKey = stateKey;
					},
				},
				resume: payload,
				approved,
				response,
				cancel,
			});

			if (output.status === "needs_approval") {
				return okEnvelope("needs_approval", [], output.requiresApproval ?? null, null);
			}
			if (output.status === "needs_input") {
				return okEnvelope("needs_input", [], null, output.requiresInput ?? null);
			}
			await cleanupIndex(workflowResumeStateKey);
			if (output.status === "cancelled") {
				return okEnvelope("cancelled", [], null, null);
			}
			return okEnvelope("ok", output.output, null, null);
		} catch (err: any) {
			if (err instanceof WorkflowResumeArgumentError) {
				return errorEnvelope("parse_error", err.message);
			}
			// Non-abort failures and cancellations before step execution remain retryable.
			return errorEnvelope("runtime_error", err?.message ?? String(err));
		}
	}

	let resumeState;
	try {
		resumeState = await loadPipelineResumeState(runtime.env, payload.stateKey);
	} catch (err: any) {
		return errorEnvelope("runtime_error", err?.message ?? String(err));
	}

	if (resumeState.haltType === "input_request") {
		if (approved !== undefined) {
			return errorEnvelope("parse_error", "pipeline input resumes require response");
		}
		if (response === undefined) {
			return errorEnvelope("parse_error", "pipeline input resumes require response");
		}
		try {
			validatePipelineInputResponse(resumeState.inputSchema, response);
		} catch (err: any) {
			return errorEnvelope("parse_error", err?.message ?? String(err));
		}
	} else {
		if (response !== undefined) {
			return errorEnvelope(
				"parse_error",
				"approval resumes require approved=true|false, not response",
			);
		}
		if (approved !== true) {
			// Keep the approval ID usable while this may still be waiting on a
			// concurrent state writer. Dropping the index first would orphan the
			// capability if cancellation interrupts the deletion.
			const deletion = await deleteUnconsumedResumeState({
				env: runtime.env,
				key: payload.stateKey,
				signal: runtime.signal,
			});
			if (deletion !== "deleted") {
				return errorEnvelope("runtime_error", "Pipeline resume state not found");
			}
			await cleanupIndex();
			return okEnvelope("cancelled", [], null, null);
		}
	}

	const isSameStageInput =
		resumeState.haltType === "input_request" && resumeState.resumeMode === "same_stage";
	const remaining = resumeState.pipeline.slice(resumeState.resumeAtIndex);
	const input = isSameStageInput
		? resumeState.items
		: resumeState.haltType === "input_request"
			? [response]
			: resumeState.items;
	const abortedBeforeResume = runtime.signal?.aborted === true;
	let pipelineResumeStateRestored = false;
	let pipelineExecutionStarted = false;
	let pipelineResumeStateClaimId: string | undefined;
	const requestInputResume = isSameStageInput
		? {
				state: resumeState.commandInput!,
				response,
			}
		: undefined;

	try {
		const output = await runPipeline({
			pipeline: remaining,
			registry: runtime.registry,
			stdin: runtime.stdin,
			stdout: runtime.stdout,
			stderr: runtime.stderr,
			env: runtime.env,
			mode: "tool",
			cwd: runtime.cwd,
			llmAdapters: runtime.llmAdapters,
			signal: runtime.signal,
			haltAfterStageOnAbort: true,
			input,
			requestInputResume,
			onExecutionStart: async () => {
				const consumption = await consumeResumeState({
					env: runtime.env,
					key: payload.stateKey,
					expectedState: resumeState,
					signal: runtime.signal,
				});
				if (!consumption.consumed) {
					throw new Error("Pipeline resume state not found");
				}
				pipelineResumeStateClaimId = consumption.claimId;
				if (consumption.signalAbortedAfterCommit) {
					const restored = await restoreConsumedResumeState({
						env: runtime.env,
						key: payload.stateKey,
						expectedState: resumeState,
						claimId: consumption.claimId,
					});
					if (restored) {
						pipelineResumeStateRestored = true;
						pipelineResumeStateClaimId = undefined;
					}
					runtime.signal?.throwIfAborted();
				}
				runtime.signal?.throwIfAborted();
				pipelineExecutionStarted = true;
			},
		});

		const finalized = await finalizePipelineToolRun({
			env: runtime.env,
			pipeline: remaining,
			output,
			previousStateKey: payload.stateKey,
			previousState: resumeState,
			previousStateConsumed: pipelineExecutionStarted,
			restorePreviousStateOnAbort: !pipelineExecutionStarted,
			onPreviousStateRestored: () => {
				pipelineResumeStateRestored = true;
			},
			signal: runtime.signal,
		});
		if (finalized.status === "ok" && pipelineExecutionStarted) await cleanupIndex();
		return okEnvelope(
			finalized.status,
			finalized.output,
			finalized.requiresApproval,
			finalized.requiresInput,
		);
	} catch (err: any) {
		const abortedResume = runtime.signal?.aborted === true;
		if (
			abortedResume &&
			!pipelineExecutionStarted &&
			!pipelineResumeStateRestored &&
			pipelineResumeStateClaimId
		) {
			pipelineResumeStateRestored = await restoreConsumedResumeState({
				env: runtime.env,
				key: payload.stateKey,
				expectedState: resumeState,
				claimId: pipelineResumeStateClaimId,
			}).catch(() => false);
		}
		if (pipelineExecutionStarted && !pipelineResumeStateRestored) {
			if (abortedResume && !abortedBeforeResume) {
				await deleteStateJson({ env: runtime.env, key: payload.stateKey }).catch(() => {});
			}
			// Keep the short approval ID through the pre-dispatch claim window. Once
			// the unsafe stage has actually been entered, the tombstone makes retry
			// unsafe and the old index may be retired just as it was before this fix.
			await cleanupIndex().catch(() => {});
		}
		// Non-abort failures and pre-aborted resumes remain retryable by token or approval ID.
		return errorEnvelope("runtime_error", err?.message ?? String(err));
	}
}

export function createToolContext(ctx: ToolRunContext = {}) {
	return {
		cwd: ctx.cwd ?? process.cwd(),
		env: { ...process.env, ...ctx.env },
		mode: "tool" as const,
		stdin: ctx.stdin ?? process.stdin,
		stdout: ctx.stdout ?? createCaptureStream(),
		stderr: ctx.stderr ?? createCaptureStream(),
		signal: ctx.signal,
		registry: ctx.registry ?? createDefaultRegistry(),
		llmAdapters: ctx.llmAdapters,
	};
}

export function createCaptureStream() {
	return new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
}

function okEnvelope(
	status: "ok" | "needs_approval" | "needs_input" | "cancelled",
	output: unknown[],
	requiresApproval: ToolEnvelope["requiresApproval"],
	requiresInput: ToolEnvelope["requiresInput"],
) {
	return {
		protocolVersion: 1 as const,
		ok: true,
		status,
		output,
		requiresApproval,
		requiresInput,
	};
}

function errorEnvelope(type: string, message: string): ToolEnvelope {
	return {
		protocolVersion: 1,
		ok: false,
		error: { type, message },
	};
}

async function resolveWorkflowFile(candidate: string, cwd: string) {
	const { stat } = await import("node:fs/promises");
	const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
	const fileStat = await stat(resolved);
	if (!fileStat.isFile()) throw new Error("Workflow path is not a file");
	const ext = path.extname(resolved).toLowerCase();
	if (![".lobster", ".yaml", ".yml", ".json"].includes(ext)) {
		throw new Error("Workflow file must end in .lobster, .yaml, .yml, or .json");
	}
	return resolved;
}
