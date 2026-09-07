import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

test("packaged lobster bin starts and prints help", () => {
	const bin = path.join(process.cwd(), "bin", "lobster.js");
	const res = spawnSync(process.execPath, [bin, "--help"], {
		encoding: "utf8",
	});

	assert.equal(res.status, 0, res.stderr);
	assert.match(res.stdout, /Usage:/);
});

test("packaged lobster exec --json preserves the child executable", () => {
	const bin = path.join(process.cwd(), "bin", "lobster.js");
	const pipeline = `exec --json "${process.execPath}" -p 'JSON.stringify([{n:1},{n:2}])' | where n>=2`;
	const res = spawnSync(process.execPath, [bin, "run", "--mode", "tool", pipeline], {
		encoding: "utf8",
		timeout: 10_000,
	});

	assert.equal(res.status, 0, res.stderr || res.stdout);
	const envelope = JSON.parse(res.stdout);
	assert.equal(envelope.ok, true);
	assert.deepEqual(envelope.output, [{ n: 2 }]);
});
