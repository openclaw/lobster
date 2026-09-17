import test from "node:test";
import assert from "node:assert/strict";

import { tableCommand } from "../src/commands/stdlib/table.js";

async function render(input) {
	const chunks = [];
	const ctx = { stdout: { write: (chunk) => chunks.push(chunk) } };
	const result = await tableCommand.run({ input, ctx });
	return { out: chunks.join(""), result };
}

test("table renders (no results) for empty input", async () => {
	const { out, result } = await render([]);
	assert.equal(out, "(no results)\n");
	assert.equal(result.rendered, true);
});

test("table renders object rows as a padded union-column table", async () => {
	const { out } = await render([
		{ id: 1, name: "alpha" },
		{ id: 2, city: "sofia\nvillage" },
	]);
	assert.equal(
		out,
		"id   name   city         \n" +
			"---  -----  -------------\n" +
			"1    alpha               \n" +
			"2           sofia village\n",
	);
});

test("table falls back to one stringified item per line for non-object input", async () => {
	const { out } = await render([1, "two", { a: 1 }, [3, 4], null]);
	assert.equal(out, '1\ntwo\n{"a":1}\n[3,4]\n\n');
});
