import test from "node:test";
import assert from "node:assert/strict";
import { parsePipeline } from "../src/parser.js";

test("parsePipeline splits stages and args", () => {
	const p = parsePipeline("exec echo hi | where a=1 | pick id,subject");
	assert.equal(p.length, 3);
	assert.equal(p[0].name, "exec");
	assert.deepEqual(p[0].args._, ["echo", "hi"]);
	assert.equal(p[1].name, "where");
	assert.equal(p[1].args._[0], "a=1");
	assert.equal(p[2].name, "pick");
	assert.equal(p[2].args._[0], "id,subject");
});

test("parsePipeline keeps quoted pipes", () => {
	const p = parsePipeline("exec echo 'a|b' | json");
	assert.equal(p.length, 2);
	assert.deepEqual(p[0].args._, ["echo", "a|b"]);
});

test("parsePipeline preserves JSON escapes in double-quoted args", () => {
	const p = parsePipeline(
		'openclaw.invoke --tool llm-task --action json --args-json "{\\"prompt\\":\\"line1\\\\nline2\\",\\"schema\\":{\\"type\\":\\"object\\"}}"',
	);
	assert.equal(p.length, 1);
	const raw = p[0].args["args-json"];
	const parsed = JSON.parse(raw);
	assert.equal(parsed.prompt, "line1\nline2");
	assert.equal(parsed.schema.type, "object");
});

test("parsePipeline keeps single-quoted args literal", () => {
	const p = parsePipeline('openclaw.invoke --args-json \'{"x":"a\\\\nb"}\'');
	assert.equal(p.length, 1);
	assert.equal(p[0].args["args-json"], '{"x":"a\\\\nb"}');
});

test("parsePipeline preserves escaped apostrophes in single-quoted args", () => {
	const p = parsePipeline('openclaw.invoke --args-json \'{"prompt":"don\\\'t"}\'');
	assert.equal(p.length, 1);
	const raw = p[0].args["args-json"];
	const parsed = JSON.parse(raw);
	assert.equal(parsed.prompt, "don't");
});

test("parsePipeline parses inline --key=value arguments", () => {
	const p = parsePipeline("where --field=name --limit=10");
	assert.equal(p.length, 1);
	assert.equal(p[0].args["field"], "name");
	assert.equal(p[0].args["limit"], "10");
});

test("parsePipeline keeps an empty inline --key= value as an empty string", () => {
	const p = parsePipeline("cmd --note=");
	assert.equal(p[0].args["note"], "");
});

test("parsePipeline treats a trailing --flag as a boolean true", () => {
	const p = parsePipeline("cmd --verbose");
	assert.equal(p[0].args["verbose"], true);
});

test("parsePipeline treats --flag followed by another --flag as boolean", () => {
	const p = parsePipeline("cmd --dry-run --out file");
	assert.equal(p[0].args["dry-run"], true);
	assert.equal(p[0].args["out"], "file");
});

test("parsePipeline unescapes \\$ and \\` inside double quotes", () => {
	const p = parsePipeline('echo "\\$HOME \\`id\\`"');
	assert.deepEqual(p[0].args._, ["$HOME `id`"]);
});

test("parsePipeline joins a backslash-newline line continuation in double quotes", () => {
	const p = parsePipeline('echo "line1\\\nline2"');
	assert.deepEqual(p[0].args._, ["line1line2"]);
});

test("parsePipeline tolerates a trailing pipe (no empty final stage)", () => {
	const p = parsePipeline("exec x |");
	assert.equal(p.length, 1);
	assert.equal(p[0].name, "exec");
});

test("parsePipeline throws on an empty or whitespace-only pipeline", () => {
	assert.throws(() => parsePipeline(""), /Empty pipeline/);
	assert.throws(() => parsePipeline("   "), /Empty pipeline/);
});

test("parsePipeline throws on an empty stage between pipes", () => {
	assert.throws(() => parsePipeline("exec x | | json"), /Empty command stage/);
});

test("parsePipeline throws on an unclosed single or double quote", () => {
	assert.throws(() => parsePipeline("exec 'unclosed"), /Unclosed quote/);
	assert.throws(() => parsePipeline('exec "unclosed'), /Unclosed quote/);
});
