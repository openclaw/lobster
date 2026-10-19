import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

test("release dry runs validate the selected commit without publishable artifacts", () => {
	const workflow = parse(readFileSync(".github/workflows/lobster-npm-release.yml", "utf8"));
	const evaluate = (expression: string, inputs: Record<string, unknown>) =>
		runInNewContext(expression.slice(3, -2), {
			inputs,
			github: { sha: "selected-commit" },
			format: (pattern: string, value: string) => pattern.replace("{0}", value),
		});
	const preflight = workflow.jobs.preflight_lobster_npm;
	const checkout = preflight.steps.find((step) => step.name === "Checkout");
	const upload = preflight.steps.find((step) => step.name === "Upload prepared npm publish bundle");
	const publishedCheck = preflight.steps.find(
		(step) => step.name === "Ensure version is not already published",
	);
	const promotionGuard = preflight.steps.find(
		(step) => step.name === "Forbid preflight artifact promotion on validation-only runs",
	);
	for (const preflightOnly of [false, true]) {
		for (const promote of [false, true]) {
			const inputs = {
				dry_run: true,
				preflight_only: preflightOnly,
				promote_beta_to_latest: promote,
				preflight_run_id: "1234",
				tag: "v2026.9.16",
			};
			for (const job of [
				"validate_publish_request",
				"publish_lobster_npm",
				"promote_beta_to_latest",
			]) {
				assert.equal(evaluate(workflow.jobs[job].if, inputs), false, job);
			}
			assert.equal(evaluate(preflight.if, inputs), true);
			assert.equal(evaluate(checkout.with.ref, inputs), "selected-commit");
			assert.equal(evaluate(upload.if, inputs), false);
			assert.equal(evaluate(publishedCheck.env.PREFLIGHT_ONLY, inputs), true);
			assert.equal(evaluate(promotionGuard.if, inputs), false);
		}
	}
	const tagged = {
		dry_run: false,
		preflight_only: true,
		promote_beta_to_latest: false,
		tag: "v2026.9.16",
	};
	assert.equal(evaluate(checkout.with.ref, tagged), "refs/tags/v2026.9.16");
	assert.equal(evaluate(upload.if, tagged), true);
});

test("release workflow validates dated and undated changelog sections", () => {
	const workflow = parse(readFileSync(".github/workflows/lobster-npm-release.yml", "utf8"));
	const directory = mkdtempSync(path.join(tmpdir(), "lobster-release-changelog-"));
	try {
		for (const jobName of ["preflight_lobster_npm", "publish_lobster_npm"]) {
			const step = workflow.jobs[jobName].steps.find(
				(entry) => entry.name === "Validate changelog entry for release version",
			);
			assert.ok(step, jobName);
			const script = step.run.match(/node - <<'NODE'\n([\s\S]*?)\nNODE/);
			assert.ok(script, `${jobName} Node validator`);
			for (const [changelog, expected] of [
				["## 2026.9.7 - 2026-09-07\n\n- A fix.\n", 0],
				["## 2026.9.7\n\n- A fix.\n", 0],
				["## 2026.9.70 - 2026-09-07\n\n- Another version.\n", 1],
				["## 2026.9.7 - 2026-09-07\n\n## 2026.9.5\n\n- An older fix.\n", 1],
			] as const) {
				writeFileSync(path.join(directory, "CHANGELOG.md"), changelog);
				const result = spawnSync(process.execPath, ["-"], {
					input: script[1],
					cwd: directory,
					env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, RELEASE_TAG: "v2026.9.7" },
					encoding: "utf8",
					timeout: 10_000,
				});
				assert.equal(result.status, expected, `${jobName}: ${result.stderr}`);
			}
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
