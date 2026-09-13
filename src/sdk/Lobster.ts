import { stateEnv } from "./state_env.js";
import { randomUUID } from "node:crypto";
import { runPipelineInternal } from "./runtime.js";
import { encodeToken, decodeToken } from "../token.js";
import { compileCached } from "../validation.js";
import { validateCommandInputState, type CommandInputState } from "../input_request.js";
import { deleteStateJson, readStateJsonWithLock, writeStateJson } from "../state/store.js";

type SdkResumePayload = {
	protocolVersion: 1;
	v: 1;
	stageIndex?: number;
	resumeAtIndex: number;
	items?: unknown[];
	prompt?: string;
	inputSchema?: unknown;
	inputSubject?: unknown;
	resumeMode?: "next_stage" | "same_stage";
	stateKey?: string;
};

type SdkCommandInputResumeState = {
	resumeAtIndex: number;
	items: unknown[];
	inputSchema: unknown;
	inputSubject?: unknown;
	commandInput: CommandInputState;
};

export type LobsterOptions = {
	env?: NodeJS.ProcessEnv;
	stateDir?: string;
	signal?: AbortSignal;
};

export class Lobster {
	#stages = [];
	#options: LobsterOptions;
	#meta = null;

	constructor(options: LobsterOptions = {}) {
		this.#options = {
			env: options.env ?? process.env,
			stateDir: options.stateDir,
			signal: options.signal,
		};
	}

	pipe(stage) {
		if (typeof stage !== "function" && typeof stage?.run !== "function") {
			throw new Error("Stage must be a function or have a run() method");
		}
		this.#stages.push(stage);
		return this;
	}

	meta(meta) {
		this.#meta = meta;
		return this;
	}

	getMeta() {
		return this.#meta;
	}

	async run(initialInput = []) {
		return this.#runStages(this.#stages, initialInput);
	}

	async #runStages(
		stages,
		initialInput,
		requestInputResume = undefined,
		stageOffset = 0,
		fallbackIndex = -1,
	) {
		const ctx = {
			env: this.#options.env,
			stateDir: this.#options.stateDir,
			mode: "sdk",
			signal: this.#options.signal,
		};

		try {
			const result = await runPipelineInternal({
				stages,
				ctx,
				input: initialInput,
				requestInputResume,
			});

			if (
				result.halted &&
				result.items.length === 1 &&
				result.items[0]?.type === "approval_request"
			) {
				const approval = result.items[0];
				const resumeToken = encodeToken({
					protocolVersion: 1,
					v: 1,
					stageIndex: stageOffset + (result.haltedAt?.index ?? fallbackIndex),
					resumeAtIndex: stageOffset + (result.haltedAt?.index ?? fallbackIndex) + 1,
					items: approval.items,
					prompt: approval.prompt,
				});

				return {
					ok: true,
					status: "needs_approval",
					output: [],
					requiresApproval: {
						prompt: approval.prompt,
						items: approval.items,
						resumeToken,
					},
					requiresInput: null,
				};
			}

			if (result.halted && result.items.length === 1 && result.items[0]?.type === "input_request") {
				const input = result.items[0];
				const resumeMode = input.commandInput ? "same_stage" : "next_stage";
				const resumeAtIndex =
					resumeMode === "same_stage"
						? stageOffset + (result.haltedAt?.index ?? fallbackIndex)
						: stageOffset + (result.haltedAt?.index ?? fallbackIndex) + 1;
				const stateKey =
					resumeMode === "same_stage"
						? await saveSdkCommandInputResumeState(this.#options, {
								resumeAtIndex,
								items: input.items ?? [],
								inputSchema: input.responseSchema,
								...(input.subject !== undefined ? { inputSubject: input.subject } : null),
								commandInput: input.commandInput,
							})
						: undefined;
				const resumeToken = encodeToken({
					protocolVersion: 1,
					v: 1,
					stageIndex: stageOffset + (result.haltedAt?.index ?? fallbackIndex),
					resumeAtIndex,
					resumeMode,
					...(resumeMode === "same_stage"
						? { stateKey }
						: { items: [], inputSchema: input.responseSchema }),
					inputSubject: input.subject,
				});

				return {
					ok: true,
					status: "needs_input",
					output: [],
					requiresApproval: null,
					requiresInput: {
						prompt: input.prompt,
						responseSchema: input.responseSchema,
						defaults: input.defaults,
						subject: input.subject,
						resumeToken,
					},
				};
			}

			return {
				ok: true,
				status: "ok",
				output: result.items,
				requiresApproval: null,
				requiresInput: null,
			};
		} catch (err) {
			return {
				ok: false,
				status: "error",
				output: [],
				requiresApproval: null,
				requiresInput: null,
				error: {
					type: "runtime_error",
					message: err?.message ?? String(err),
				},
			};
		}
	}

	async resume(
		token: string,
		options: { approved?: boolean; response?: unknown; cancel?: boolean } = {},
	) {
		const { approved, response, cancel } = options;
		const intentCount =
			Number(typeof approved === "boolean") +
			Number(response !== undefined) +
			Number(cancel === true);
		if (intentCount > 1) {
			throw new Error("resume accepts only one of approved, response, or cancel");
		}
		if (intentCount === 0) {
			throw new Error("resume requires approved, response, or cancel");
		}

		const payload = decodeSdkResumePayload(token);

		let sdkCommandInputState: SdkCommandInputResumeState | undefined;
		if (payload.resumeMode === "same_stage") {
			sdkCommandInputState = await loadSdkCommandInputResumeState(this.#options, payload.stateKey!);
		}

		if (cancel === true) {
			if (payload.resumeMode === "same_stage") {
				await deleteStateJson({ env: stateEnv(this.#options), key: payload.stateKey! });
			}
			return {
				ok: true,
				status: "cancelled",
				output: [],
				requiresApproval: null,
				requiresInput: null,
			};
		}

		const expectsInput = payload.inputSchema !== undefined || payload.resumeMode === "same_stage";
		if (expectsInput) {
			if (approved !== undefined) {
				throw new Error("resume token expects an input response, not approved");
			}
			if (response === undefined) {
				throw new Error("resume token expects response");
			}
		} else {
			if (response !== undefined) {
				throw new Error("resume token expects approved=true|false, not response");
			}
			if (typeof approved !== "boolean") {
				throw new Error("resume token expects approved=true|false");
			}
			if (approved === false) {
				return {
					ok: true,
					status: "cancelled",
					output: [],
					requiresApproval: null,
					requiresInput: null,
				};
			}
		}

		const resumeIndex = sdkCommandInputState?.resumeAtIndex ?? payload.resumeAtIndex ?? 0;
		let resumeItems = sdkCommandInputState?.items ?? payload.items ?? [];
		let requestInputResume;
		if (response !== undefined) {
			const schema = sdkCommandInputState?.inputSchema ?? payload.inputSchema;
			if (schema === undefined) {
				throw new Error("resume token does not support input responses");
			}
			let validator;
			try {
				validator = compileCached(schema as any);
			} catch {
				throw new Error("resume token input schema is invalid");
			}
			const ok = validator(response);
			if (!ok) {
				const first = validator.errors?.[0];
				throw new Error(
					`response does not match schema at ${first?.instancePath || "/"}: ${first?.message || "invalid"}`,
				);
			}
			if (payload.resumeMode === "same_stage") {
				resumeItems = sdkCommandInputState!.items;
				requestInputResume = {
					state: sdkCommandInputState!.commandInput,
					response,
					onConsumed: async () => {
						await deleteStateJson({ env: stateEnv(this.#options), key: payload.stateKey! });
					},
				};
			} else {
				resumeItems = [response];
			}
		}

		const remainingStages = this.#stages.slice(resumeIndex);
		return this.#runStages(remainingStages, resumeItems, requestInputResume, resumeIndex, 0);
	}

	clone() {
		const cloned = new Lobster(this.#options);
		cloned.#stages = [...this.#stages];
		cloned.#meta = this.#meta ? { ...this.#meta } : null;
		return cloned;
	}
}

function decodeSdkResumePayload(token: string): SdkResumePayload {
	const payload = decodeToken(token);
	if (!payload || typeof payload !== "object") {
		throw new Error("Invalid token");
	}
	const data = payload as Record<string, unknown>;
	if (data.protocolVersion !== 1 || data.v !== 1) {
		throw new Error("Invalid token");
	}
	if (
		typeof data.resumeAtIndex !== "number" ||
		!Number.isInteger(data.resumeAtIndex) ||
		data.resumeAtIndex < 0
	) {
		throw new Error("Invalid token");
	}
	if (data.items !== undefined && !Array.isArray(data.items)) {
		throw new Error("Invalid token");
	}
	if (
		data.resumeMode !== undefined &&
		(typeof data.resumeMode !== "string" || !["next_stage", "same_stage"].includes(data.resumeMode))
	) {
		throw new Error("Invalid token");
	}
	if (data.resumeMode === "same_stage") {
		if (typeof data.stateKey !== "string" || data.stateKey.length === 0) {
			throw new Error("Invalid token");
		}
	} else if (data.stateKey !== undefined) {
		throw new Error("Invalid token");
	}
	if (data.commandInput !== undefined) throw new Error("Invalid token");
	return data as unknown as SdkResumePayload;
}

async function saveSdkCommandInputResumeState(
	options: LobsterOptions,
	state: SdkCommandInputResumeState,
) {
	const stateKey = `sdk_resume_${randomUUID()}`;
	await writeStateJson({ env: stateEnv(options), key: stateKey, value: state });
	return stateKey;
}

async function loadSdkCommandInputResumeState(
	options: LobsterOptions,
	stateKey: string,
): Promise<SdkCommandInputResumeState> {
	const stored = await readStateJsonWithLock({
		env: stateEnv(options),
		key: stateKey,
		signal: options?.signal,
	});
	if (!stored || typeof stored !== "object") throw new Error("SDK resume state not found");
	const data = stored as Partial<SdkCommandInputResumeState>;
	if (
		typeof data.resumeAtIndex !== "number" ||
		!Number.isInteger(data.resumeAtIndex) ||
		data.resumeAtIndex < 0
	) {
		throw new Error("Invalid SDK resume state");
	}
	if (!Array.isArray(data.items)) throw new Error("Invalid SDK resume state");
	if (data.inputSchema === undefined) throw new Error("Invalid SDK resume state");
	data.commandInput = validateCommandInputState(data.commandInput);
	return data as SdkCommandInputResumeState;
}
