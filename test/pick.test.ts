import test from "node:test";
import assert from "node:assert/strict";

import { pickCommand } from "../src/commands/stdlib/pick.js";

test("pick preserves special JSON field names without changing the output prototype", async () => {
	const item = JSON.parse('{"__proto__":{"injected":true},"constructor":"value","id":1}');
	const { output } = await pickCommand.run({
		input: [item],
		args: { _: ["__proto__,constructor,id"] },
	});
	const items = [];
	for await (const value of output) items.push(value);
	assert.deepEqual(items, [item]);
	assert.equal(JSON.stringify(items), JSON.stringify([item]));
	assert.equal(Object.getPrototypeOf(items[0]), Object.prototype);
	assert.equal(Object.hasOwn(items[0], "__proto__"), true);
	assert.equal(items[0].injected, undefined);
});
