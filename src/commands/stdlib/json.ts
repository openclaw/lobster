export const jsonCommand = {
	name: "json",
	meta: {
		description: "Render pipeline output as JSON",
		argsSchema: { type: "object", properties: {}, required: [] },
		sideEffects: [],
	},
	help() {
		return `json — render pipeline output as JSON\n\nUsage:\n  ... | json\n`;
	},
	async run({ input, ctx }) {
		if (ctx.renderOutput === false) return { output: input };
		const items = [];
		for await (const item of input) items.push(item);
		ctx.render.json(items);
		return { output: emptyStream(), rendered: true };
	},
};

async function* emptyStream() {}
