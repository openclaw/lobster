import path from "node:path";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { billableTokens } from "../../core/cost_tracker.js";
import type { ErrorObject } from "ajv";

import {
	diffAndStore,
	ensureDirectory,
	atomicWriteWasPublished,
	isJsonSyntaxError,
	readStateJsonWithLock,
	stableStringify,
	withFileLock,
	writeFileAtomic,
} from "../../state/store.js";
import { createCompileCached } from "../../validation.js";
import type { LobsterCommand } from "../types.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const compileCachedLocal = createCompileCached(ajv);

const artifactSchema = {
	type: "object",
	properties: {
		kind: { type: "string" },
		role: { type: "string" },
		name: { type: "string" },
		mimeType: { type: "string" },
		text: { type: "string" },
		data: {},
		uri: { type: "string" },
	},
	additionalProperties: true,
};

const payloadSchema = {
	type: "object",
	properties: {
		prompt: { type: "string", minLength: 1 },
		model: { type: "string", minLength: 1 },
		artifacts: { type: "array", items: artifactSchema },
		artifactHashes: { type: "array", items: { type: "string", minLength: 10 } },
		schemaVersion: { type: "string" },
		metadata: { type: "object", additionalProperties: true },
		outputSchema: { type: "object", additionalProperties: true },
		temperature: { type: "number" },
		maxOutputTokens: { type: "number" },
		retryContext: {
			type: "object",
			properties: {
				attempt: { type: "number" },
				validationErrors: { type: "array", items: { type: "string" } },
			},
			additionalProperties: false,
		},
	},
	required: ["prompt", "artifacts", "artifactHashes"],
	additionalProperties: false,
};

const responseSchema = {
	type: "object",
	properties: {
		ok: { type: "boolean" },
		result: {
			type: "object",
			properties: {
				runId: { type: "string" },
				model: { type: "string" },
				prompt: { type: "string" },
				status: { type: "string" },
				output: {
					type: "object",
					properties: {
						text: { type: "string" },
						data: {},
						format: { type: "string" },
					},
					required: [],
					additionalProperties: true,
				},
				usage: {
					type: "object",
					properties: {
						inputTokens: { type: "number" },
						outputTokens: { type: "number" },
						totalTokens: { type: "number" },
					},
					additionalProperties: true,
				},
				warnings: { type: "array", items: { type: "string" } },
				metadata: { type: "object", additionalProperties: true },
				diagnostics: { type: "object", additionalProperties: true },
			},
			required: ["output"],
			additionalProperties: true,
		},
		error: { type: "object", additionalProperties: true },
	},
	required: ["ok"],
	additionalProperties: true,
};

const validatePayload = ajv.compile(payloadSchema);
const validateResponseEnvelope = ajv.compile(responseSchema);

const DEFAULT_MAX_VALIDATION_RETRIES = 1;
const STATE_VERSION = 1;
// Identity version of the response cache key. See computeCacheKey.
const CACHE_KEY_VERSION = 2;

type BuiltInProvider = "openclaw" | "pi" | "http";
type SupportedProvider = BuiltInProvider | string;

type LlmResponseEnvelope = {
	ok: boolean;
	result?: LlmResponse | null;
	error?: { message?: string } | null;
};

type LlmResponse = {
	runId?: string | null;
	model?: string | null;
	prompt?: string | null;
	status?: string | null;
	output?: {
		text?: string | null;
		data?: any;
		format?: string | null;
	} | null;
	usage?: Record<string, unknown> | null;
	warnings?: string[] | null;
	metadata?: Record<string, unknown> | null;
	diagnostics?: Record<string, unknown> | null;
};

type NormalizedInvocationItem = {
	kind: string;
	runId: string | null;
	prompt: string | null;
	model: string | null;
	schemaVersion: string | null;
	status: string;
	cacheKey: string;
	artifactHashes: string[];
	output: { format: string | null; text: string | null; data: any };
	usage: Record<string, unknown> | null;
	metadata: Record<string, unknown> | null;
	warnings: string[] | null;
	diagnostics: Record<string, unknown> | null;
	createdAt: string;
	source: string;
	cached: boolean;
	// Set only when a stored item is re-emitted, so consumers can tell a replay from a live
	// call. `source` cannot carry that: a direct adapter's source is its provider name.
	replayed?: boolean;
	attemptCount: number;
};

// Provenance for an item this module emitted: which stored answer it belongs to, and whether
// it came from a provider call or from run state / the response cache.
// A symbol key cannot come out of `JSON.parse`, so the JSON a workflow step reads from a
// command's stdout can never carry it: only objects built here, in this process, take part in
// the replay exemption in workflow cost accounting.
const LLM_PROVENANCE = Symbol("lobster.llm.provenance");

export type LlmProvenance = { cacheKey: string; replayed: boolean };

/**
 * Stamps provenance on a value this module is emitting. The property is enumerable so a
 * downstream `{ ...value }` keeps it, and `JSON.stringify` ignores symbol keys, so serialized
 * output — including what is written to the cache — is unchanged.
 */
function markProvenance<T extends object>(value: T, provenance: LlmProvenance): T {
	return Object.defineProperty(value, LLM_PROVENANCE, {
		value: provenance,
		enumerable: true,
		configurable: true,
	});
}

/**
 * Marks an item this module is emitting, and its usage record with it. A projection such as
 * `pick model,usage` builds a new object out of named fields, so the item's own mark does not
 * reach the consumer — but the usage record crosses by reference, and the usage record is what
 * gets billed. Marking both means provenance survives an in-process projection without the
 * consumer having to recognize every command that can build one.
 */
function markLlmItem(
	item: NormalizedInvocationItem,
	provenance: LlmProvenance,
): NormalizedInvocationItem {
	if (item.usage && typeof item.usage === "object") {
		markProvenance(item.usage as object, provenance);
	}
	return markProvenance(item, provenance);
}

/**
 * The provenance of an item — or of a usage record — this module produced in the current
 * process, and null for anything else. The public `replayed` field is deliberately not
 * consulted: any command can print it beside a real `usage` object, and honoring that would
 * drop real spend from `_meta.cost` and `cost_limit`.
 */
export function llmProvenanceOf(value: unknown): LlmProvenance | null {
	if (!value || typeof value !== "object") return null;
	const provenance = (value as Record<symbol, unknown>)[LLM_PROVENANCE];
	if (!provenance || typeof provenance !== "object") return null;
	const { cacheKey, replayed } = provenance as LlmProvenance;
	if (typeof cacheKey !== "string" || typeof replayed !== "boolean") return null;
	return { cacheKey, replayed };
}

/**
 * Marks `target` — a structurally identical value rebuilt from `source`'s own JSON — as standing
 * in for whatever calls `source` was marked with.
 *
 * The marks are deliberately not in that JSON, and re-deriving them from it would mean trusting a
 * payload, which the accounting must never do. Carrying them is a different act: the caller holds
 * both values in this process and knows one was built from the other, which nothing on disk can
 * claim for itself.
 *
 * What is carried is always a replay, whatever the source was. A value read back out of storage
 * re-emits an answer that already exists; the call behind it was made once, and this is not that
 * call happening again.
 */
export function carryLlmProvenance(source: unknown, target: unknown) {
	if (!source || typeof source !== "object" || !target || typeof target !== "object") return;
	const provenance = llmProvenanceOf(source);
	if (provenance)
		markProvenance(target as object, { cacheKey: provenance.cacheKey, replayed: true });
	if (Array.isArray(source) || Array.isArray(target)) {
		if (!Array.isArray(source) || !Array.isArray(target)) return;
		for (let index = 0; index < Math.min(source.length, target.length); index++) {
			carryLlmProvenance(source[index], target[index]);
		}
		return;
	}
	for (const key of Object.keys(source)) {
		carryLlmProvenance(
			(source as Record<string, unknown>)[key],
			(target as Record<string, unknown>)[key],
		);
	}
}

/**
 * Restores private replay provenance on completed step results loaded from Lobster's own
 * workflow-resume state. Resume state is the narrow trusted boundary: ordinary command JSON
 * never reaches this helper, so copying a public cache key cannot suppress its usage record.
 */
export function restoreLlmProvenance(
	target: unknown,
	charges: readonly LlmOutstandingCharge[] | undefined,
) {
	if (!target || typeof target !== "object" || !Array.isArray(charges)) return;
	const settled = charges.filter(
		(charge) =>
			charge &&
			typeof charge === "object" &&
			typeof charge.cacheKey === "string" &&
			charge.cacheKey &&
			charge.usage &&
			typeof charge.usage === "object",
	);
	if (!settled.length) return;

	const visit = (value: unknown) => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}

		const record = value as Record<string, unknown>;
		const cacheKey = typeof record.cacheKey === "string" ? record.cacheKey : null;
		const model = typeof record.model === "string" ? record.model : null;
		const usage = record.usage;
		if (cacheKey && usage && typeof usage === "object") {
			const matches = settled.some(
				(charge) =>
					charge.cacheKey === cacheKey &&
					(charge.model ?? null) === model &&
					sameBillableUsage(charge.usage, usage),
			);
			if (matches) {
				const provenance = { cacheKey, replayed: true };
				markProvenance(usage as object, provenance);
				markProvenance(record, provenance);
			}
		}

		for (const child of Object.values(record)) visit(child);
	};
	visit(target);
}

// Live calls a run has paid for that nothing has billed yet. A workflow records a step's cost
// only once the step succeeds, so a step that fails *after* its LLM call — and is then retried
// — never bills the live item. The retry replays the stored answer, and that replay is the only
// carrier left for a charge that really happened, so it is billed there instead. Entries are
// keyed by cache key: that is what a live item and every replay of it share across the JSON
// round trip through run state and the response cache.
export type LlmSpendLedger = {
	record: (cacheKey: string, charge?: LlmChargeCost) => void;
	claim: (cacheKey: string, cost?: LlmChargeCost) => LlmChargeCost | null;
	billCopy: (
		cacheKey: string | null,
		model: string | null,
		usage: Record<string, unknown>,
	) => boolean;
	outstanding: () => LlmOutstandingCharge[];
	restore: (charges: readonly LlmOutstandingCharge[] | undefined) => void;
	settled: () => LlmOutstandingCharge[];
	restoreSettled: (charges: readonly LlmOutstandingCharge[] | undefined) => void;
};

// What a live call cost, carried with the charge itself. An item is the usual carrier, but it
// does not always survive to the accounting point: a renderer consumes the pipeline, an `ask`
// gate swallows the item, a composed run ends on a step of its own. The charge is then the only
// record left that the provider was really paid.
export type LlmChargeCost = {
	stepId?: string;
	model?: string | null;
	usage?: Record<string, unknown>;
};

// A charge a run has opened and not yet billed. Carried in the run's own resume state so a
// workflow that pauses mid-pipeline keeps it, and only that workflow can settle it.
export type LlmOutstandingCharge = { cacheKey: string; count: number } & LlmChargeCost;

// A call nothing ever bills — a step that failed outright — leaves its key behind, so the
// oldest are dropped to keep a long run's ledger bounded.
const MAX_UNBILLED_LIVE_INVOCATIONS = 256;

/**
 * Creates the ledger for a single run. The run that paid for a call is the only one that can
 * recover its charge, because no other run holds this ledger: a workflow reusing a cache entry
 * written by an earlier run, or by an SDK caller outside cost accounting, finds nothing to
 * claim and is billed nothing. A live call made without a ledger in `ctx` opens no charge.
 *
 * A run composed by another one — a `workflow:` step — passes the composing run's ledger as
 * `parent`. Both bill the same answer at their own boundary: the child bills its step, the
 * parent bills the output handed back to it. So a charge is opened in both and each settles
 * its own copy exactly once, while a replay neither of them paid for still claims nothing.
 */
export function createLlmSpendLedger(parent?: LlmSpendLedger | null): LlmSpendLedger {
	// Outstanding charges per cache key, held one entry per call rather than as a count: two
	// identical calls that race on a cold cache are two provider charges under one key, the
	// replays that later stand in for them have to be able to settle both, and each carries the
	// cost of the call that opened it.
	const unbilled = new Map<string, LlmChargeCost[]>();
	// Charges this run has already accounted for. A copy of an item that lost its mark can turn
	// up in any later step, and the only way to tell it from a call nobody has billed yet is to
	// remember what has been billed. Bounded like the open charges, oldest key first.
	const billed = new Map<string, LlmChargeCost[]>();
	function settle(cacheKey: string, charge: LlmChargeCost | undefined) {
		const seen = billed.get(cacheKey) ?? [];
		seen.push(charge ?? {});
		billed.set(cacheKey, seen);
		for (const oldest of billed.keys()) {
			if (billed.size <= MAX_UNBILLED_LIVE_INVOCATIONS) break;
			billed.delete(oldest);
		}
	}
	return {
		record(cacheKey: string, charge?: LlmChargeCost) {
			if (!cacheKey) return;
			parent?.record(cacheKey, charge);
			const open = unbilled.get(cacheKey) ?? [];
			open.push({ ...charge });
			unbilled.set(cacheKey, open);
			for (const oldest of unbilled.keys()) {
				if (unbilled.size <= MAX_UNBILLED_LIVE_INVOCATIONS) break;
				unbilled.delete(oldest);
			}
		},
		/**
		 * Settles one outstanding charge and hands back what that call cost, or null for the
		 * caller that must not bill anything. A live item and every replay of it draw on the same
		 * charges, so a provider call is billed exactly once however many steps re-emit its
		 * answer — and N calls under one key can be billed N times, never fewer.
		 *
		 * The cost comes back because a replay is not a reliable witness of it: identical calls
		 * that raced on a cold cache each paid their own way, and every replay of them carries
		 * whichever single answer was stored.
		 */
		claim(cacheKey: string, cost?: LlmChargeCost) {
			const open = unbilled.get(cacheKey);
			if (!open?.length) return null;
			// A caller that knows what its own call cost settles that call's charge. A step
			// retried after an attempt that failed *after* paying has more than one charge under
			// the key, and they did not cost the same: settling the wrong one leaves the other to
			// be billed at this call's price instead of its own.
			const own = cost
				? open.findIndex(
						(charge) =>
							(charge.model ?? null) === (cost.model ?? null) &&
							sameBillableUsage(charge.usage, cost.usage),
					)
				: -1;
			// Otherwise: a charge that records no cost settles nothing anyone can bill, so it
			// must not be the one handed to a caller with a real call to account for. Charges
			// restored from resume state written before they carried a cost are the ones this
			// can be.
			const index =
				own >= 0
					? own
					: Math.max(
							open.findIndex((charge) => charge.usage !== undefined),
							0,
						);
			const [charge] = open.splice(index, 1);
			if (!open.length) unbilled.delete(cacheKey);
			settle(cacheKey, charge);
			return charge ?? {};
		},
		/**
		 * Whether an item carrying a call's numbers but not its in-process mark should be billed.
		 * A matching open charge is settled so the same provider call is not recorded again by
		 * end-of-step cleanup. Once no charge is open, however, public fields can never suppress
		 * usage: only the private provenance symbol can prove an item is a replay.
		 */
		billCopy(cacheKey: string | null, model: string | null, usage: Record<string, unknown>) {
			const isSameCall = (charge: LlmChargeCost) =>
				(charge.model ?? null) === model && sameBillableUsage(charge.usage, usage);
			// A copy that still names a cache key is read against that key alone: the key is
			// evidence of which call it came from, and honoring it keeps one call's copy from
			// settling another call's charge. A transform can emit `{ model, usage }` and drop
			// the key with the symbols, leaving the cost as the only evidence there is.
			for (const key of cacheKey === null ? [...unbilled.keys()] : [cacheKey]) {
				const open = unbilled.get(key);
				const index = open?.findIndex(isSameCall) ?? -1;
				if (!open || index < 0) continue;
				settle(key, open.splice(index, 1)[0]);
				if (!open.length) unbilled.delete(key);
				return true;
			}
			return true;
		},
		outstanding() {
			const charges: LlmOutstandingCharge[] = [];
			for (const [cacheKey, open] of unbilled) {
				for (const charge of open) charges.push({ cacheKey, count: 1, ...charge });
			}
			return charges;
		},
		/**
		 * Reopens charges a paused run had not billed. A pipeline can suspend mid-step — at an
		 * `ask` gate — after its LLM call has been paid for but before the step succeeded, so
		 * without this the charge would exist in no run: the paused one never billed it, and the
		 * resumed one would exempt the replay that stands in for it.
		 */
		restore(charges: readonly LlmOutstandingCharge[] | undefined) {
			if (!Array.isArray(charges)) return;
			for (const charge of charges) {
				if (!charge || typeof charge !== "object") continue;
				if (typeof charge.cacheKey !== "string" || !charge.cacheKey) continue;
				const count = Math.floor(Number(charge.count ?? 0));
				if (!Number.isFinite(count) || count < 1) continue;
				// State written before this field existed carries no cost, and a hand-edited file
				// should not be able to invent one: only a plain object of numbers is taken.
				const { cacheKey, count: _count, ...cost } = charge;
				const restored = sanitizeChargeCost(cost);
				for (let i = 0; i < count; i++) this.record(cacheKey, restored);
			}
		},
		/**
		 * The calls this run has already billed. A run that pauses carries this the way it carries
		 * what it spent: the total says how much, and this says which calls it was for.
		 */
		settled() {
			const charges: LlmOutstandingCharge[] = [];
			for (const [cacheKey, seen] of billed) {
				for (const charge of seen) charges.push({ cacheKey, count: 1, ...charge });
			}
			return charges;
		},
		/**
		 * Restores what a paused run had billed, so the two halves of its accounting agree after
		 * the pause. `cost` brings the money back; without this the run that resumes has no record
		 * of what the money was for, and a later step that re-emits a completed LLM output — `head`
		 * over `$live.json` — hands on a copy the fresh ledger has never heard of. It is billed on
		 * top of the restored total: one provider call, twice in `_meta.cost` and against
		 * `cost_limit`.
		 *
		 * A settled charge is only ever read against a cache key, so what this restores can excuse
		 * a copy of a named call and nothing else. It cannot touch a live call — those settle out
		 * of the open charges — and the spend it is reconstructing is already in the `cost` this
		 * same state carries.
		 */
		restoreSettled(charges: readonly LlmOutstandingCharge[] | undefined) {
			if (!Array.isArray(charges)) return;
			for (const charge of charges) {
				if (!charge || typeof charge !== "object") continue;
				if (typeof charge.cacheKey !== "string" || !charge.cacheKey) continue;
				const count = Math.floor(Number(charge.count ?? 0));
				if (!Number.isFinite(count) || count < 1) continue;
				const { cacheKey, count: _count, ...cost } = charge;
				const restored = sanitizeChargeCost(cost);
				for (let i = 0; i < count; i++) settle(cacheKey, restored);
			}
		},
	};
}

/**
 * Whether two usage records bill the same, asked of the accounting that bills them. Comparing
 * the records themselves would answer a different question twice over: a live item's usage
 * carries this module's provenance symbol, which a copy that went through JSON never can, and a
 * stage that rebuilds an item can drop or recompute a field nothing is charged for.
 */
function sameBillableUsage(left: unknown, right: unknown) {
	if (!left || typeof left !== "object" || !right || typeof right !== "object") return false;
	const billed = billableTokens(left as Record<string, unknown>);
	const other = billableTokens(right as Record<string, unknown>);
	return billed.inputTokens === other.inputTokens && billed.outputTokens === other.outputTokens;
}

/**
 * Opens a charge for a live call, and only for one that costs something. An answer that reports
 * no usage is billed nowhere however many times it is replayed, so a charge for it would sit in
 * the ledger with nothing to settle it -- and would be handed to the next caller with a real
 * call to account for, leaving that one's charge open to be billed a second time.
 */
function recordLiveCharge(ctx: any, cacheKey: string, item: NormalizedInvocationItem | undefined) {
	const cost = chargeCostOf(item);
	if (!cost) return;
	ledgerFrom(ctx)?.record(cacheKey, cost);
}

/** The cost of a live call, read from the item this module just built for it. */
function chargeCostOf(item: NormalizedInvocationItem | undefined): LlmChargeCost | undefined {
	const usage = item?.usage;
	if (!usage || typeof usage !== "object") return undefined;
	return { model: typeof item?.model === "string" ? item.model : null, usage };
}

function sanitizeChargeCost(cost: Record<string, unknown>): LlmChargeCost {
	const usage = cost.usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
	const numbers: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(usage)) {
		if (typeof value === "number" && Number.isFinite(value)) numbers[key] = value;
	}
	if (!Object.keys(numbers).length) return {};
	return {
		...(typeof cost.stepId === "string" ? { stepId: cost.stepId } : null),
		model: typeof cost.model === "string" ? cost.model : null,
		usage: numbers,
	};
}

function ledgerFrom(ctx: any): LlmSpendLedger | null {
	const ledger = ctx?.llmSpendLedger;
	if (!ledger || typeof ledger !== "object") return null;
	return typeof ledger.record === "function" && typeof ledger.claim === "function" ? ledger : null;
}

type CacheEntry = {
	items: NormalizedInvocationItem[];
	cacheKey: string;
	storedAt: string;
};

type CommandConfig = {
	name: string;
	itemKind: string;
	stateType: string;
	cacheNamespace: string;
	defaultProvider?: SupportedProvider | null;
	description: string;
	helpTitle: string;
	helpConfig: string[];
	helpExamples: string[];
	sourceForProvider?: (provider: SupportedProvider) => string;
	legacyEnvCompat?: boolean;
};

type Adapter = {
	provider: SupportedProvider;
	source: string;
	invoke: (params: {
		env: any;
		args: any;
		payload: Record<string, any>;
		signal?: AbortSignal;
	}) => Promise<LlmResponseEnvelope>;
};

type DirectAdapter =
	| ((params: {
			env: any;
			args: any;
			payload: Record<string, any>;
			ctx: any;
			signal?: AbortSignal;
	  }) => Promise<LlmResponseEnvelope>)
	| {
			source?: string;
			invoke: (params: {
				env: any;
				args: any;
				payload: Record<string, any>;
				ctx: any;
				signal?: AbortSignal;
			}) => Promise<LlmResponseEnvelope>;
	  };

export const llmInvokeCommand = createLlmInvokeCommand({
	name: "llm.invoke",
	itemKind: "llm.invoke",
	stateType: "llm.invoke",
	cacheNamespace: "llm.invoke",
	defaultProvider: null,
	description: "Call a configured LLM adapter with typed payloads and caching",
	helpTitle: "llm.invoke — call a configured LLM adapter with caching and schema validation",
	helpConfig: [
		"Provider resolution order: --provider, LOBSTER_LLM_PROVIDER, then environment auto-detect.",
		"Built-in providers: openclaw, pi, http.",
		"OpenClaw provider uses OPENCLAW_URL (CLAWD_URL also supported) and OPENCLAW_TOKEN.",
		"Pi provider uses LOBSTER_PI_LLM_ADAPTER_URL and is intended to be supplied by a Pi extension.",
		"Generic http provider uses LOBSTER_LLM_ADAPTER_URL and optional LOBSTER_LLM_ADAPTER_TOKEN.",
	],
	helpExamples: [
		"llm.invoke --prompt 'Write summary'",
		"llm.invoke --provider openclaw --model claude-3-sonnet --prompt 'Write summary'",
		"cat artifacts.json | llm.invoke --provider pi --prompt 'Score each item'",
		"... | llm.invoke --prompt 'Plan next steps' --output-schema '{\"type\":\"object\"}'",
	],
	sourceForProvider(provider) {
		return provider;
	},
	legacyEnvCompat: true,
});

export const llmTaskInvokeCommand = createLlmInvokeCommand({
	name: "llm_task.invoke",
	itemKind: "llm_task.invoke",
	stateType: "llm_task.invoke",
	cacheNamespace: "llm_task.invoke",
	defaultProvider: "openclaw",
	description: "Backward-compatible alias for llm.invoke using the OpenClaw adapter",
	helpTitle: "llm_task.invoke — backward-compatible alias for llm.invoke using OpenClaw",
	helpConfig: [
		"Requires OPENCLAW_URL (or CLAWD_URL) and optionally OPENCLAW_TOKEN.",
		"Use llm.invoke for new workflows and non-OpenClaw adapters.",
	],
	helpExamples: [
		"llm_task.invoke --prompt 'Write summary'",
		"llm_task.invoke --model claude-3-sonnet --prompt 'Write summary'",
		"cat artifacts.json | llm_task.invoke --prompt 'Score each item'",
	],
	sourceForProvider() {
		return "clawd";
	},
	legacyEnvCompat: true,
});

export function createLlmInvokeCommand(config: CommandConfig): LobsterCommand {
	return {
		name: config.name,
		meta: {
			description: config.description,
			argsSchema: {
				type: "object",
				properties: {
					provider: {
						type: "string",
						description: "LLM adapter provider (openclaw, pi, http). Optional if auto-detected.",
					},
					token: {
						type: "string",
						description: "Optional bearer token for providers that support it.",
					},
					prompt: { type: "string", description: "Primary prompt / instructions" },
					model: {
						type: "string",
						description: "Model identifier. Optional; adapter defaults may apply if omitted.",
					},
					"artifacts-json": { type: "string", description: "JSON array of artifacts to send" },
					"metadata-json": { type: "string", description: "JSON object of metadata to include" },
					"output-schema": { type: "string", description: "JSON schema LLM output must satisfy" },
					"schema-version": { type: "string", description: "Logical schema version for caching" },
					"max-validation-retries": {
						type: "number",
						description:
							"Extra model calls allowed after the first when schema validation fails (default 1)",
					},
					temperature: { type: "number", description: "Sampling temperature" },
					"max-output-tokens": { type: "number", description: "Max completion tokens" },
					"state-key": {
						type: "string",
						description: "Run-state key override (else LOBSTER_RUN_STATE_KEY)",
					},
					refresh: { type: "boolean", description: "Bypass run-state + cache" },
					"disable-cache": { type: "boolean", description: "Skip persistent cache" },
					_: { type: "array", items: { type: "string" } },
				},
				required: [],
			},
			sideEffects: ["calls_llm"],
		},
		help() {
			const lines = [
				config.helpTitle,
				"",
				"Usage:",
				...config.helpExamples.map((example) => `  ${example}`),
				"",
				"Features:",
				"  - Typed payload validation before invoking the adapter.",
				"  - Run-state + file cache so resumes do not re-call the LLM.",
				"  - Optional JSON-schema enforcement, retried at most --max-validation-retries times",
				"    after the first call.",
				"",
				"Config:",
				...config.helpConfig.map((line) => `  - ${line}`),
			];
			return `${lines.join("\n")}\n`;
		},
		async run({ input, args, ctx }) {
			return runLlmInvoke({ input, args, ctx, config });
		},
	} satisfies LobsterCommand;
}

async function runLlmInvoke({
	input,
	args,
	ctx,
	config,
}: {
	input: AsyncIterable<any>;
	args: any;
	ctx: any;
	config: CommandConfig;
}) {
	const env = ctx.env ?? process.env;
	const signal: AbortSignal | undefined = ctx?.signal;
	// Run-state and cache hits return before any adapter call, so a cancelled run
	// would otherwise still finish as a success.
	throwIfCancelled(signal);
	const provider = resolveProvider(args, env, config.defaultProvider, ctx);
	const adapter = resolveAdapter({ provider, env, args, config, ctx });
	const prompt = extractPrompt(args);
	if (!prompt) throw new Error(`${config.name} requires --prompt or positional text`);

	const model = resolveModel(args, env, config.legacyEnvCompat);
	const schemaVersion = resolveEnvString(
		args["schema-version"],
		["LOBSTER_LLM_SCHEMA_VERSION", ...(config.legacyEnvCompat ? ["LLM_TASK_SCHEMA_VERSION"] : [])],
		env,
		"v1",
	);
	const maxOutputTokens = parseOptionalNumber(args["max-output-tokens"]);
	const temperature = parseOptionalNumber(args.temperature);
	const providedArtifacts = parseJsonArray(
		args["artifacts-json"],
		`${config.name} --artifacts-json`,
	);
	const metadataObject = parseJsonObject(args["metadata-json"], `${config.name} --metadata-json`);
	const userOutputSchema = parseJsonObject(args["output-schema"], `${config.name} --output-schema`);
	const maxValidationRetriesRaw =
		args["max-validation-retries"] ??
		getFirstEnv(env, [
			"LOBSTER_LLM_VALIDATION_RETRIES",
			...(config.legacyEnvCompat ? ["LLM_TASK_VALIDATION_RETRIES"] : []),
		]);
	const maxValidationRetries = userOutputSchema
		? Math.max(
				0,
				Number.isFinite(Number(maxValidationRetriesRaw))
					? Number(maxValidationRetriesRaw)
					: DEFAULT_MAX_VALIDATION_RETRIES,
			)
		: 0;
	const disableCache = flag(args["disable-cache"]);
	const forceRefresh = flag(
		args.refresh ??
			getFirstEnv(env, [
				"LOBSTER_LLM_FORCE_REFRESH",
				...(config.legacyEnvCompat ? ["LLM_TASK_FORCE_REFRESH"] : []),
			]),
	);
	const stateKey = String(args["state-key"] ?? env.LOBSTER_RUN_STATE_KEY ?? "").trim() || null;

	const inputArtifacts: any[] = [];
	for await (const item of input) inputArtifacts.push(item);
	// Draining pipeline input waits on the upstream step, so a timeout can fire
	// here. Re-check before the reuse lookups below can answer with a success.
	throwIfCancelled(signal);

	const normalizedArtifacts = [...inputArtifacts, ...providedArtifacts].map(normalizeArtifact);
	const artifactHashes = normalizedArtifacts.map(hashArtifact);
	const cacheKey = computeCacheKey({
		provider,
		prompt,
		model,
		schemaVersion,
		artifactHashes,
		outputSchema: userOutputSchema,
		temperature,
		maxOutputTokens,
	});

	if (stateKey && !forceRefresh) {
		const stored = await readReusableLlmState(env, stateKey, ctx.signal);
		// Reading run state is I/O of unbounded duration; a signal that aborted
		// during it must not be overtaken by the replay below.
		throwIfCancelled(signal);
		const reused = pickReusableState(stored, cacheKey, config.stateType);
		if (reused) {
			const replay: LlmProvenance = { cacheKey, replayed: true };
			return {
				output: streamOf(
					reused.items.map((item) =>
						markLlmItem({ ...item, source: "run_state", cached: true, replayed: true }, replay),
					),
				),
			};
		}
	}

	if (!disableCache && !forceRefresh) {
		const cache = await readCacheEntry(env, cacheKey, config.cacheNamespace, ctx.signal);
		throwIfCancelled(signal);
		if (cache) {
			const replay: LlmProvenance = { cacheKey, replayed: true };
			return {
				output: streamOf(
					cache.items.map((item) =>
						markLlmItem({ ...item, source: "cache", cached: true, replayed: true }, replay),
					),
				),
			};
		}
	}

	const payload: Record<string, any> = {
		prompt,
		...(model ? { model } : null),
		artifacts: normalizedArtifacts,
		artifactHashes,
	};
	if (metadataObject) payload.metadata = metadataObject;
	if (userOutputSchema) payload.outputSchema = userOutputSchema;
	if (schemaVersion) payload.schemaVersion = schemaVersion;
	if (Number.isFinite(maxOutputTokens ?? NaN)) payload.maxOutputTokens = Number(maxOutputTokens);
	if (Number.isFinite(temperature ?? NaN)) payload.temperature = Number(temperature);

	if (!validatePayload(payload)) {
		throw new Error(`${config.name} payload invalid: ${ajv.errorsText(validatePayload.errors)}`);
	}

	const validator = userOutputSchema ? compileCachedLocal(userOutputSchema) : null;
	let attempt = 0;
	let lastValidationErrors: string[] = [];

	while (true) {
		throwIfCancelled(signal);
		attempt += 1;
		if (attempt > 1) {
			payload.retryContext = {
				attempt,
				...(lastValidationErrors.length ? { validationErrors: lastValidationErrors } : null),
			};
		} else {
			delete payload.retryContext;
		}

		let responseEnvelope: LlmResponseEnvelope;
		try {
			ctx.signal?.throwIfAborted();
			responseEnvelope = await abortable(
				adapter.invoke({ env, args, payload, signal: ctx.signal }),
				signal,
			);
			ctx.signal?.throwIfAborted();
		} catch (err: any) {
			// Cancellation is the caller's error, not an adapter failure: surface it
			// as an abort so workflow timeout and abort handling still recognizes it,
			// rather than wrapping it in a "request failed" adapter error.
			if (signal?.aborted) throw asCancellation(err, signal);
			throw new Error(`${config.name} request failed: ${err?.message ?? String(err)}`);
		}

		if (!validateResponseEnvelope(responseEnvelope)) {
			throw new Error(`${config.name} received invalid response envelope`);
		}

		if (responseEnvelope.ok !== true) {
			const message = responseEnvelope.error?.message ?? "llm adapter returned an error";
			throw new Error(`${config.name} remote error: ${message}`);
		}

		const normalized = normalizeResult({
			envelope: responseEnvelope,
			cacheKey,
			schemaVersion,
			artifactHashes,
			source: adapter.source,
			attempt,
			itemKind: config.itemKind,
		});
		const live: LlmProvenance = { cacheKey, replayed: false };
		for (const item of normalized) markLlmItem(item, live);
		// The provider has answered and been paid, so the charge is opened here rather than at
		// either of the returns below. An attempt the local validator rejects never reaches one
		// of them -- it goes round the loop and asks again -- and its call was as real as the one
		// that eventually satisfies the schema. Opening it here also puts it before the writes
		// that store the answer: either can fail once run state already holds a replayable copy,
		// and the retry that replays it must still find a charge to settle.
		recordLiveCharge(ctx, cacheKey, normalized[0]);

		if (!validator) {
			ctx.signal?.throwIfAborted();
			await persistOutputs({
				env,
				stateKey,
				cacheKey,
				items: normalized,
				stateType: config.stateType,
				signal: ctx.signal,
				afterStore: disableCache
					? undefined
					: () => writeCacheEntry(env, cacheKey, normalized, config.cacheNamespace, ctx.signal),
			});
			return { output: streamOf(normalized) };
		}

		const structured = normalized[0]?.output?.data ?? null;
		if (validator(structured)) {
			ctx.signal?.throwIfAborted();
			await persistOutputs({
				env,
				stateKey,
				cacheKey,
				items: normalized,
				stateType: config.stateType,
				signal: ctx.signal,
				afterStore: disableCache
					? undefined
					: () => writeCacheEntry(env, cacheKey, normalized, config.cacheNamespace, ctx.signal),
			});
			return { output: streamOf(normalized) };
		}

		lastValidationErrors = collectAjvErrors(validator.errors);
		if (attempt > maxValidationRetries) {
			throw new Error(
				`${config.name} output failed schema validation: ${lastValidationErrors.join("; ")}`,
			);
		}
	}
}

/**
 * Build the error a cancelled run rejects with.
 *
 * The workflow runner only treats an error named `AbortError` or coded
 * `ABORT_ERR` as cancellation; everything else follows the step's retry and
 * `on_error` policy. A host may abort with any reason it likes, so passing
 * `signal.reason` straight through means `controller.abort(new Error("stop"))`
 * leaves a cancelled step looking like an ordinary failure -- retried, or
 * swallowed by `on_error: continue` and reported as a successful run. Keep the
 * host's message and hang its reason off `cause`, but mark the rejection so the
 * runner recognizes it.
 */
function cancellationError(signal: AbortSignal): unknown {
	const reason: any = signal.reason;
	if (reason === undefined || reason === null) {
		return new DOMException("The operation was aborted.", "AbortError");
	}
	if (reason?.name === "AbortError" || reason?.code === "ABORT_ERR") return reason;
	const message =
		typeof reason?.message === "string" && reason.message ? reason.message : String(reason);
	const error: any = new Error(message, { cause: reason });
	error.name = "AbortError";
	error.code = "ABORT_ERR";
	return error;
}

/** Rethrow `err` when it already reads as cancellation, else the run's reason. */
function asCancellation(err: any, signal: AbortSignal): unknown {
	if (err?.name === "AbortError" || err?.code === "ABORT_ERR") return err;
	return cancellationError(signal);
}

function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw cancellationError(signal);
}

/**
 * Reject as soon as the run is cancelled instead of waiting for `promise`.
 * HTTP adapters are cancelled at the socket, but an injected `ctx.llmAdapters`
 * adapter may ignore `ctx.signal` entirely; without this, one of those keeps a
 * timed-out step waiting for as long as it likes.
 */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(cancellationError(signal));
		// Observe `promise` before anything can settle the wrapper, including the
		// already-aborted case below. An adapter can cancel the run from inside its own
		// `invoke` and reject afterwards; rejecting here without watching that promise
		// leaves the rejection unhandled, which ends the process under Node's default
		// handling -- long after this step was cancelled cleanly.
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function resolveProvider(
	args: any,
	env: any,
	defaultProvider?: SupportedProvider | null,
	ctx?: any,
): SupportedProvider {
	const explicit = String(args.provider ?? env.LOBSTER_LLM_PROVIDER ?? "")
		.trim()
		.toLowerCase();
	if (explicit) {
		if (explicit === "openclaw" || explicit === "pi" || explicit === "http") {
			return explicit;
		}
		if (getDirectAdapter(ctx, explicit)) {
			return explicit;
		}
		throw new Error(`Unsupported llm provider: ${explicit}`);
	}
	if (defaultProvider) return defaultProvider;
	const directAdapters =
		ctx?.llmAdapters && typeof ctx.llmAdapters === "object"
			? Object.keys(ctx.llmAdapters).filter((key) => getDirectAdapter(ctx, key))
			: [];
	if (directAdapters.length === 1) return directAdapters[0];
	if (String(env.LOBSTER_PI_LLM_ADAPTER_URL ?? "").trim()) return "pi";
	if (String(env.OPENCLAW_URL ?? env.CLAWD_URL ?? "").trim()) return "openclaw";
	if (String(env.LOBSTER_LLM_ADAPTER_URL ?? "").trim()) return "http";
	throw new Error(
		"llm.invoke could not resolve a provider. Set --provider or LOBSTER_LLM_PROVIDER",
	);
}

function resolveAdapter({
	provider,
	env,
	args,
	config,
	ctx,
}: {
	provider: SupportedProvider;
	env: any;
	args: any;
	config: CommandConfig;
	ctx: any;
}): Adapter {
	const direct = getDirectAdapter(ctx, provider);
	if (direct) {
		const invoke = typeof direct === "function" ? direct : direct.invoke;
		return {
			provider,
			source: typeof direct === "function" ? provider : (direct.source ?? provider),
			async invoke({ payload, signal }) {
				return invoke({ env, args, payload, ctx, signal });
			},
		};
	}

	if (provider === "openclaw") {
		const openclawUrl = String(env.OPENCLAW_URL ?? env.CLAWD_URL ?? "").trim();
		if (!openclawUrl) {
			throw new Error(`${config.name} requires OPENCLAW_URL (or CLAWD_URL) for provider=openclaw`);
		}
		const endpoint = new URL("/tools/invoke", openclawUrl);
		const token = String(args.token ?? env.OPENCLAW_TOKEN ?? env.CLAWD_TOKEN ?? "").trim();
		return {
			provider,
			source: config.sourceForProvider?.(provider) ?? "openclaw",
			async invoke({ payload, signal }) {
				return invokeOpenClawAdapter({ endpoint, token, payload, signal });
			},
		};
	}

	if (provider === "pi") {
		const adapterUrl = String(env.LOBSTER_PI_LLM_ADAPTER_URL ?? "").trim();
		if (!adapterUrl) {
			throw new Error(`${config.name} requires LOBSTER_PI_LLM_ADAPTER_URL for provider=pi`);
		}
		const token = String(args.token ?? env.LOBSTER_PI_LLM_ADAPTER_TOKEN ?? "").trim();
		return {
			provider,
			source: config.sourceForProvider?.(provider) ?? "pi",
			async invoke({ payload, signal }) {
				return invokeHttpAdapter({
					endpoint: buildAdapterEndpoint(adapterUrl),
					token,
					payload,
					signal,
				});
			},
		};
	}

	const adapterUrl = String(env.LOBSTER_LLM_ADAPTER_URL ?? "").trim();
	if (!adapterUrl) {
		throw new Error(`${config.name} requires LOBSTER_LLM_ADAPTER_URL for provider=http`);
	}
	const token = String(args.token ?? env.LOBSTER_LLM_ADAPTER_TOKEN ?? "").trim();
	return {
		provider,
		source: config.sourceForProvider?.(provider) ?? "http",
		async invoke({ payload, signal }) {
			return invokeHttpAdapter({
				endpoint: buildAdapterEndpoint(adapterUrl),
				token,
				payload,
				signal,
			});
		},
	};
}

function getDirectAdapter(ctx: any, provider: string): DirectAdapter | null {
	const adapters = ctx?.llmAdapters;
	if (!adapters || typeof adapters !== "object") return null;
	const adapter = adapters[provider];
	if (typeof adapter === "function") return adapter as DirectAdapter;
	if (adapter && typeof adapter === "object" && typeof adapter.invoke === "function") {
		return adapter as DirectAdapter;
	}
	return null;
}

function buildAdapterEndpoint(rawUrl: string) {
	const endpoint = new URL(rawUrl);
	if (endpoint.pathname === "/" || endpoint.pathname === "") {
		endpoint.pathname = "/invoke";
	}
	return endpoint;
}

async function invokeOpenClawAdapter({
	endpoint,
	token,
	payload,
	signal,
}: {
	endpoint: URL;
	token: string;
	payload: any;
	signal?: AbortSignal;
}) {
	const res = await fetch(endpoint, {
		method: "POST",
		signal,
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : null),
		},
		body: JSON.stringify({
			tool: "llm-task",
			action: "invoke",
			args: payload,
		}),
	});

	const text = await res.text();
	if (!res.ok) {
		throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
	}

	let parsed: any;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		throw new Error("Response was not JSON");
	}

	if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "ok" in parsed) {
		if (parsed.ok !== true) {
			const msg = parsed?.error?.message ?? "Unknown error";
			throw new Error(`openclaw adapter error: ${msg}`);
		}
		const inner = parsed.result;
		if (inner && typeof inner === "object" && !Array.isArray(inner) && "ok" in inner) {
			return inner as LlmResponseEnvelope;
		}
		return { ok: true, result: inner } as LlmResponseEnvelope;
	}

	return { ok: true, result: parsed } as LlmResponseEnvelope;
}

async function invokeHttpAdapter({
	endpoint,
	token,
	payload,
	signal,
}: {
	endpoint: URL;
	token: string;
	payload: any;
	signal?: AbortSignal;
}) {
	const res = await fetch(endpoint, {
		method: "POST",
		signal,
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : null),
		},
		body: JSON.stringify(payload),
	});

	const text = await res.text();
	if (!res.ok) {
		throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
	}

	let parsed: any;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		throw new Error("Response was not JSON");
	}

	if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "ok" in parsed) {
		return parsed as LlmResponseEnvelope;
	}
	return { ok: true, result: parsed } as LlmResponseEnvelope;
}

function resolveModel(args: any, env: any, legacyEnvCompat: boolean | undefined) {
	return resolveEnvString(
		args.model,
		["LOBSTER_LLM_MODEL", ...(legacyEnvCompat ? ["LLM_TASK_MODEL"] : [])],
		env,
		"",
	);
}

function resolveEnvString(raw: any, envKeys: string[], env: any, fallback: string) {
	if (raw !== undefined && raw !== null && String(raw).trim()) return String(raw).trim();
	const fromEnv = getFirstEnv(env, envKeys);
	if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
	return fallback;
}

function getFirstEnv(env: any, keys: string[]) {
	for (const key of keys) {
		if (env?.[key] !== undefined && env?.[key] !== null && String(env[key]).trim()) {
			return env[key];
		}
	}
	return undefined;
}

function extractPrompt(args: any) {
	if (args.prompt) return String(args.prompt);
	if (Array.isArray(args._) && args._.length) {
		return args._.join(" ");
	}
	return "";
}

function parseJsonArray(raw: any, label: string) {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(String(raw));
		if (!Array.isArray(parsed)) throw new Error("must be array");
		return parsed;
	} catch {
		throw new Error(`${label} must be a JSON array`);
	}
}

function parseJsonObject(raw: any, label: string) {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(String(raw));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("must be an object");
		}
		return parsed;
	} catch {
		throw new Error(`${label} must be a JSON object`);
	}
}

function parseOptionalNumber(value: any) {
	if (value === undefined || value === null) return null;
	const num = Number(value);
	return Number.isFinite(num) ? num : null;
}

function flag(value: any) {
	if (value === undefined || value === null) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["false", "0", "no"].includes(normalized)) return false;
		if (["true", "1", "yes"].includes(normalized)) return true;
	}
	return Boolean(value);
}

function normalizeArtifact(raw: any) {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return raw;
	}
	if (typeof raw === "string") {
		return { kind: "text", text: raw };
	}
	if (typeof raw === "number" || typeof raw === "boolean") {
		return { kind: "text", text: String(raw) };
	}
	return { kind: "json", data: raw };
}

function hashArtifact(artifact: any) {
	const stable = stableStringify(artifact);
	return createHash("sha256").update(stable).digest("hex");
}

function computeCacheKey({
	provider,
	prompt,
	model,
	schemaVersion,
	artifactHashes,
	outputSchema,
	temperature,
	maxOutputTokens,
}: {
	provider: SupportedProvider;
	prompt: string;
	model: string;
	schemaVersion: string;
	artifactHashes: string[];
	outputSchema: any;
	temperature: number | null;
	maxOutputTokens: number | null;
}) {
	// `null` is the identity of an omitted parameter, distinct from any value a caller can
	// pass, so an omitted request can never resolve to an entry written with an explicit one.
	// The version separates this identity from the keys earlier releases wrote, where the two
	// parameters were absent from the payload and a sampled answer therefore shared a key with
	// an unsampled request. Bump it whenever the fields below change: entries under older
	// versions become unreachable, which costs one re-invocation and never a wrong replay.
	const payload = {
		cacheKeyVersion: CACHE_KEY_VERSION,
		provider,
		prompt,
		model: model || `${provider}-default`,
		schemaVersion,
		artifactHashes,
		outputSchema: outputSchema ?? null,
		// The same predicate that decides whether each parameter is sent to the adapter.
		temperature: Number.isFinite(temperature ?? NaN) ? Number(temperature) : null,
		maxOutputTokens: Number.isFinite(maxOutputTokens ?? NaN) ? Number(maxOutputTokens) : null,
	};
	return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function normalizeResult({
	envelope,
	cacheKey,
	schemaVersion,
	artifactHashes,
	source,
	attempt,
	itemKind,
}: {
	envelope: LlmResponseEnvelope;
	cacheKey: string;
	schemaVersion: string;
	artifactHashes: string[];
	source: string;
	attempt: number;
	itemKind: string;
}): NormalizedInvocationItem[] {
	const result = envelope.result ?? {};
	const output = result.output ?? {};
	const item: NormalizedInvocationItem = {
		kind: itemKind,
		runId: (result.runId ?? null) as any,
		prompt: (result.prompt ?? null) as any,
		model: (result.model ?? null) as any,
		schemaVersion,
		status: String(result.status ?? "completed"),
		cacheKey,
		artifactHashes,
		output: {
			format: (output.format ?? (output.data ? "json" : "text")) as any,
			text: (output.text ?? null) as any,
			data: (output.data ?? null) as any,
		},
		usage: (result.usage ?? null) as any,
		metadata: (result.metadata ?? null) as any,
		warnings: (result.warnings ?? null) as any,
		diagnostics: (result.diagnostics ?? null) as any,
		createdAt: new Date().toISOString(),
		source,
		cached:
			source !== "remote" &&
			source !== "openclaw" &&
			source !== "clawd" &&
			source !== "pi" &&
			source !== "http",
		attemptCount: attempt,
	};
	return [item];
}

async function persistOutputs({
	env,
	stateKey,
	cacheKey,
	items,
	stateType,
	signal,
	afterStore,
}: {
	env: any;
	stateKey: string | null;
	cacheKey: string;
	items: NormalizedInvocationItem[];
	stateType: string;
	signal?: AbortSignal;
	afterStore?: () => Promise<void>;
}) {
	if (!stateKey) {
		await afterStore?.();
		return;
	}
	const record = {
		type: stateType,
		version: STATE_VERSION,
		cacheKey,
		items,
		storedAt: new Date().toISOString(),
	};
	await diffAndStore({
		env,
		key: stateKey,
		value: record,
		signal,
		afterStore: afterStore ? () => afterStore() : undefined,
	});
}

async function readReusableLlmState(env: any, stateKey: string, signal?: AbortSignal) {
	try {
		return await readStateJsonWithLock({ env, key: stateKey, signal });
	} catch (err: any) {
		if (isJsonSyntaxError(err)) return null;
		throw err;
	}
}

function pickReusableState(stored: any, cacheKey: string, stateType: string) {
	if (!stored || typeof stored !== "object") return null;
	if (stored.type !== stateType) return null;
	if (stored.cacheKey !== cacheKey) return null;
	if (!Array.isArray(stored.items)) return null;
	return { items: stored.items as NormalizedInvocationItem[] };
}

function collectAjvErrors(errors: ErrorObject[] | null | undefined) {
	if (!errors?.length) return [];
	return errors.map((err) => `${err.instancePath || "/"} ${err.message ?? ""}`.trim());
}

async function readCacheEntry(
	env: any,
	key: string,
	cacheNamespace: string,
	signal?: AbortSignal,
): Promise<CacheEntry | null> {
	const filePath = path.join(getCacheDir(env), cacheNamespace, `${key}.json`);
	const read = async () => {
		try {
			const text = await fsp.readFile(filePath, "utf8");
			const parsed = JSON.parse(text) as Partial<CacheEntry>;
			if (parsed?.cacheKey !== key || !Array.isArray(parsed.items)) return null;
			return parsed as CacheEntry;
		} catch (err: any) {
			if (err?.code === "ENOENT") return null;
			if (isJsonSyntaxError(err)) return null;
			throw err;
		}
	};
	try {
		return await withFileLock({ filePath, signal, task: read });
	} catch (err: any) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
		// A cache mounted read-only cannot have an active local writer because a
		// writer first creates the same coordination lock. Preserve its reusable
		// entries instead of requiring a lock-directory write for a read.
		if (["EACCES", "EPERM", "EROFS"].includes(err?.code)) return read();
		throw err;
	}
}

async function writeCacheEntry(
	env: any,
	key: string,
	items: NormalizedInvocationItem[],
	cacheNamespace: string,
	signal?: AbortSignal,
) {
	const dir = path.join(getCacheDir(env), cacheNamespace);
	signal?.throwIfAborted();
	await ensureDirectory(dir);
	const filePath = path.join(dir, `${key}.json`);
	const content =
		JSON.stringify({ items, cacheKey: key, storedAt: new Date().toISOString() }, null, 2) + "\n";
	await withFileLock({
		filePath,
		signal,
		task: async () => {
			let previousContent: Buffer | null = null;
			try {
				previousContent = await fsp.readFile(filePath);
			} catch (err: any) {
				if (err?.code !== "ENOENT") throw err;
			}
			const restorePreviousContent = async () => {
				// No cache reader or competing cache writer can observe this entry
				// until this lock is released. Restore an entry replaced by a refresh;
				// only remove the just-published file when none existed beforehand.
				if (previousContent === null) await fsp.rm(filePath, { force: true });
				else await writeFileAtomic(filePath, previousContent);
			};
			let cacheWasPublished = false;
			try {
				signal?.throwIfAborted();
				const result = await writeFileAtomic(filePath, content, { signal });
				cacheWasPublished = true;
				if (result?.signalAbortedAfterCommit || signal?.aborted) {
					await restorePreviousContent();
					cacheWasPublished = false;
					signal?.throwIfAborted();
					throw new Error("LLM cache publication cancelled");
				}
			} catch (err) {
				if (cacheWasPublished || atomicWriteWasPublished(err)) {
					await restorePreviousContent();
				}
				throw err;
			}
		},
	});
}

function getCacheDir(env: any) {
	if (env?.LOBSTER_CACHE_DIR) return String(env.LOBSTER_CACHE_DIR);
	return path.join(process.cwd(), ".lobster-cache");
}

async function* streamOf(items: any[]) {
	for (const item of items) yield item;
}
