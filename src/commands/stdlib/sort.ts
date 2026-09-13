import { getByPath } from "../../core/value_path.js";

function defaultCompare(a: unknown, b: unknown): number {
	const aU = a === undefined || a === null;
	const bU = b === undefined || b === null;
	if (aU && bU) return 0;
	if (aU) return 1;
	if (bU) return -1;

	if (typeof a === "number" && typeof b === "number") return a - b;

	// Deterministic lexical compare independent of process locale.
	const aStr = String(a);
	const bStr = String(b);
	if (aStr < bStr) return -1;
	if (aStr > bStr) return 1;
	return 0;
}

export const sortCommand = {
	name: "sort",
	meta: {
		description: "Sort items (stable) by a key or by stringified value",
		argsSchema: {
			type: "object",
			properties: {
				key: { type: "string", description: "Dot-path key to sort by (e.g. updatedAt, pr.number)" },
				desc: { type: "boolean", description: "Sort descending" },
				_: { type: "array", items: { type: "string" } },
			},
			required: [],
		},
		sideEffects: [],
	},
	help() {
		return (
			`sort — sort items (stable) by a key\n\n` +
			`Usage:\n` +
			`  ... | sort\n` +
			`  ... | sort --key updatedAt\n` +
			`  ... | sort --key prNumber --desc\n\n` +
			`Notes:\n` +
			`  - Sorting is stable (preserves order for equal keys).\n` +
			`  - undefined/null keys sort last.\n`
		);
	},
	async run({ input, args }: any) {
		const key = typeof args.key === "string" ? args.key : undefined;
		const desc = Boolean(args.desc);

		// Decorate so undefined items still reach the comparator in descending order.
		const items: { item: unknown }[] = [];
		for await (const item of input) {
			items.push({ item });
		}

		items.sort((a, b) => {
			const av = key ? getByPath(a.item, key) : a.item;
			const bv = key ? getByPath(b.item, key) : b.item;
			const c = defaultCompare(av, bv);
			return desc ? -c : c;
		});

		return {
			output: (async function* () {
				for (const x of items) yield x.item;
			})(),
		};
	},
};
