import { billableTokens } from "./cost_tracker.js";

// Only in-process objects carry this symbol. JSON fields cannot grant a replay exemption.
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

/** Mark both the item and usage so projections such as `pick model,usage` preserve provenance. */
export function markLlmItem<T extends { usage?: Record<string, unknown> | null }>(
	item: T,
	provenance: LlmProvenance,
): T {
	if (item.usage && typeof item.usage === "object") {
		markProvenance(item.usage as object, provenance);
	}
	return markProvenance(item, provenance);
}

/** Public cache keys and `replayed` fields are not trusted as billing provenance. */
export function llmProvenanceOf(value: unknown): LlmProvenance | null {
	if (!value || typeof value !== "object") return null;
	const provenance = (value as Record<symbol, unknown>)[LLM_PROVENANCE];
	if (!provenance || typeof provenance !== "object") return null;
	const { cacheKey, replayed } = provenance as LlmProvenance;
	if (typeof cacheKey !== "string" || typeof replayed !== "boolean") return null;
	return { cacheKey, replayed };
}

/** Carry provenance only across a JSON round trip whose source is still held in-process. */
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

// Track provider charges separately from output: failed or suspended steps can lose their items.
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

// Retain cost even if a renderer, input gate, or composed workflow consumes the item.
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

/** Each run settles its own charges once; composed runs also record charges in their parent. */
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

/** Compare billable token counts, ignoring provenance and unbilled response metadata. */
function sameBillableUsage(left: unknown, right: unknown) {
	if (!left || typeof left !== "object" || !right || typeof right !== "object") return false;
	const billed = billableTokens(left as Record<string, unknown>);
	const other = billableTokens(right as Record<string, unknown>);
	return billed.inputTokens === other.inputTokens && billed.outputTokens === other.outputTokens;
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
