import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { parsePipeline } from "../src/parser.js";
import { Lobster, exec } from "../src/sdk/index.js";

const runFile = promisify(execFile);
const argvScript = "console.log(JSON.stringify(process.argv.slice(1)))";
const argvCommand = `${JSON.stringify(process.execPath)} -e '${argvScript}' "" tail`;

test("pipeline parsing preserves empty positional arguments", () => {
	assert.deepEqual(parsePipeline(`exec node "" ' ' '' tail`)[0].args._, [
		"node",
		"",
		" ",
		"",
		"tail",
	]);
});

test("pipeline parsing preserves an empty quoted option value", () => {
	const args = parsePipeline(`custom --value "" tail`)[0].args;
	assert.equal(args["value"], "");
	assert.deepEqual(args._, ["tail"]);
});

test("built CLI passes explicit empty arguments to a child process", async () => {
	const { stdout } = await runFile(process.execPath, [
		"bin/lobster.js",
		"run",
		"--mode",
		"tool",
		`exec --json ${argvCommand}`,
	]);
	assert.deepEqual(JSON.parse(stdout).output, ["", "tail"]);
});

test("SDK exec passes explicit empty arguments to a child process", async () => {
	const result = await new Lobster().pipe(exec(argvCommand)).run();
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(result.output, ["", "tail"]);
});

for (const alias of ["openclaw.invoke", "clawd.invoke"]) {
	test(`${alias} shim preserves punctuation and literal pipeline characters`, async () => {
		const expected = {
			text: 'O\'Malley says "hello"\nnext line',
			path: "C:\\folder\\",
			literal: "$HOME `id` | head",
			empty: "",
		};
		const requests: unknown[] = [];
		const server = createServer(async (req, res) => {
			let body = "";
			for await (const chunk of req) body += chunk;
			const payload = JSON.parse(body);
			requests.push(payload.args);
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ok: true, result: [payload.args] }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			assert.ok(address && typeof address === "object");
			const { stdout } = await runFile(
				process.execPath,
				[
					`bin/${alias}.js`,
					"--url",
					`http://127.0.0.1:${address.port}`,
					"--tool",
					"proof",
					"--action",
					"read",
					"--args-json",
					JSON.stringify(expected),
				],
				{ env: { ...process.env, OPENCLAW_TOKEN: "", CLAWD_TOKEN: "" } },
			);
			assert.deepEqual(JSON.parse(stdout), [expected]);
			assert.deepEqual(requests, [expected]);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
}
