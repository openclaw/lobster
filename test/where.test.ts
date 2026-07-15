import test from "node:test";
import assert from "node:assert/strict";

import { runPipeline } from "../src/runtime.js";
import { createDefaultRegistry } from "../src/commands/registry.js";
import { parsePipeline } from "../src/parser.js";

async function run(pipelineText: string, input: any[]) {
	const pipeline = parsePipeline(pipelineText);
	const registry = createDefaultRegistry();
	const res = await runPipeline({
		pipeline,
		registry,
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		env: process.env,
		mode: "tool",
		input: (async function* () {
			for (const x of input) yield x;
		})(),
	});
	return res.items;
}

test("where coerces a numeric literal and filters with >=", async () => {
	const input = [{ n: 10 }, { n: 30 }, { n: 50 }];
	const out = await run("where n>=30", input);
	assert.deepEqual(out, [{ n: 30 }, { n: 50 }]);
});

test("where normalizes a single = to == and coerces true", async () => {
	const input = [
		{ unread: true, id: 1 },
		{ unread: false, id: 2 },
	];
	const out = await run("where unread=true", input);
	assert.deepEqual(out, [{ unread: true, id: 1 }]);
});

test("where coerces the false literal to a boolean", async () => {
	const input = [
		{ unread: true, id: 1 },
		{ unread: false, id: 2 },
	];
	const out = await run("where unread=false", input);
	assert.deepEqual(out, [{ unread: false, id: 2 }]);
});

test("where resolves a dotted path with ==", async () => {
	const input = [{ user: { id: "u1" } }, { user: { id: "u2" } }];
	const out = await run("where user.id==u1", input);
	assert.deepEqual(out, [{ user: { id: "u1" } }]);
});

test("where keeps a non-coercible right-hand side as a string", async () => {
	const input = [
		{ status: "active", id: 1 },
		{ status: "closed", id: 2 },
	];
	const out = await run("where status==active", input);
	assert.deepEqual(out, [{ status: "active", id: 1 }]);
});

test("where supports the != operator", async () => {
	const input = [
		{ kind: "spam", id: 1 },
		{ kind: "ham", id: 2 },
	];
	const out = await run("where kind!=spam", input);
	assert.deepEqual(out, [{ kind: "ham", id: 2 }]);
});

test("where supports the strict ordering operators < and >", async () => {
	const input = [{ n: 1 }, { n: 5 }, { n: 9 }];
	assert.deepEqual(await run("where n<5", input), [{ n: 1 }]);
	assert.deepEqual(await run("where n>5", input), [{ n: 9 }]);
});

test("where supports the inclusive ordering operator <=", async () => {
	const input = [{ n: 1 }, { n: 5 }, { n: 9 }];
	const out = await run("where n<=5", input);
	assert.deepEqual(out, [{ n: 1 }, { n: 5 }]);
});

test("where coerces the null literal and matches missing paths via loose equality", async () => {
	// getPath returns undefined for the missing key, and undefined == null is true,
	// so both the explicit-null and the missing-key rows pass; the numeric 0 does not.
	const input = [{ x: null, id: 1 }, { x: 0, id: 3 }, { id: 2 }];
	const out = await run("where x=null", input);
	assert.deepEqual(out, [{ x: null, id: 1 }, { id: 2 }]);
});

test("where returns undefined (excluding the row) when a dotted path hits a non-object", async () => {
	const input = [{ a: { b: 1 } }, { a: 5 }];
	const out = await run("where a.b==1", input);
	assert.deepEqual(out, [{ a: { b: 1 } }]);
});

test("where throws when the expression is missing", async () => {
	await assert.rejects(run("where", [{ n: 1 }]), /where requires an expression/);
});

test("where throws on an expression with no operator", async () => {
	await assert.rejects(run("where garbage", [{ n: 1 }]), /Invalid where expression/);
});
