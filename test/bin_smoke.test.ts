import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

test("prepared npm package excludes compiled tests and keeps runtime entrypoints", () => {
	// Release preflight packs after tests with lifecycle scripts disabled, so the
	// manifest must exclude test output without relying on prepack to clean it.
	assert.ok(existsSync("dist/test/bin_smoke.test.js"));
	const res = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
		encoding: "utf8",
		shell: process.platform === "win32",
	});
	assert.equal(res.status, 0, res.stderr);
	const [pack] = JSON.parse(res.stdout);
	const files = new Set(pack.files.map((file) => file.path));
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));

	assert.equal(
		pack.files.some((file) => file.path.startsWith("dist/test/")),
		false,
	);
	for (const entry of [...Object.values(pkg.bin), ...Object.values(pkg.exports)]) {
		assert.ok(files.has(String(entry).replace(/^\.\//, "")), `Missing entrypoint: ${entry}`);
	}
	assert.ok(files.has("bin/invoke.js"));
	assert.ok(files.has("dist/src/cli.js"));
	assert.ok(files.has("dist/src/cli.js.map"));
});

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
