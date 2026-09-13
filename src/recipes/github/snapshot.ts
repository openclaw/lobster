function pickSubset(snapshot: Record<string, unknown> | null) {
	if (!snapshot || typeof snapshot !== "object") return null;
	return {
		number: snapshot.number,
		title: snapshot.title,
		url: snapshot.url,
		state: snapshot.state,
		isDraft: snapshot.isDraft,
		mergeable: snapshot.mergeable,
		reviewDecision: snapshot.reviewDecision,
		updatedAt: snapshot.updatedAt,
		baseRefName: snapshot.baseRefName,
		headRefName: snapshot.headRefName,
	};
}

export function buildPrChangeSummary(
	before: Record<string, unknown> | null,
	after: Record<string, unknown> | null,
) {
	const a = pickSubset(after);
	const b = pickSubset(before);

	if (!a) return { changedFields: [], changes: {} };
	if (!b) {
		return {
			changedFields: Object.keys(a),
			changes: Object.fromEntries(Object.keys(a).map((k) => [k, { from: null, to: a[k] }])),
		};
	}

	const changes: Record<string, { from: unknown; to: unknown }> = {};
	for (const key of Object.keys(a)) {
		if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
			changes[key] = { from: b[key], to: a[key] };
		}
	}

	return {
		changedFields: Object.keys(changes),
		changes,
	};
}

export function formatPrChangeMessage({ repo, pr, changedFields, prInfo }) {
	const fields = changedFields.length ? ` (${changedFields.join(", ")})` : "";
	const title = prInfo?.title ? `: ${prInfo.title}` : "";
	const url = prInfo?.url ? ` ${prInfo.url}` : "";
	return `PR updated: ${repo}#${pr}${title}${fields}.${url}`.replace(/\s+/g, " ").trim();
}
