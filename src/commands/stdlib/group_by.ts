import { getByPath } from "../../core/value_path.js";

export const groupByCommand = {
	name: "groupBy",
	meta: {
		description: "Group items by a key (stable group order)",
		argsSchema: {
			type: "object",
			properties: {
				key: { type: "string", description: "Dot-path key to group by (required)" },
				_: { type: "array", items: { type: "string" } },
			},
			required: ["key"],
		},
		sideEffects: [],
	},
	help() {
		return (
			`groupBy — group items by a key\n\n` +
			`Usage:\n` +
			`  ... | groupBy --key from\n\n` +
			`Output:\n` +
			`  Stream of { key, items, count } objects\n\n` +
			`Notes:\n` +
			`  - Group order is stable (order of first appearance).\n`
		);
	},
	async run({ input, args }: any) {
		const keyPath = String(args.key ?? "").trim();
		if (!keyPath) throw new Error("groupBy requires --key");

		const groups = new Map<string, { key: unknown; items: unknown[] }>();

		for await (const item of input) {
			const keyVal = getByPath(item, keyPath);
			const k = JSON.stringify(keyVal);
			if (!groups.has(k)) {
				groups.set(k, { key: keyVal, items: [] });
			}
			groups.get(k)!.items.push(item);
		}

		return {
			output: (async function* () {
				for (const g of groups.values()) {
					yield { key: g.key, items: g.items, count: g.items.length };
				}
			})(),
		};
	},
};
