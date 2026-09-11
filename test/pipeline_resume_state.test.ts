import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { writeStateJson } from "../src/state/store.js";
import { loadPipelineResumeState, type PipelineResumeState } from "../src/pipeline_resume_state.js";

function validApprovalState(): PipelineResumeState {
	return {
		pipeline: [{ name: "map", args: {}, raw: "map" }],
		resumeAtIndex: 1,
		items: [{ n: 1 }],
		haltType: "approval_request",
		prompt: "approve?",
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

async function loadStored(value: unknown) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "lobster-pipeline-resume-"));
	const env = { LOBSTER_STATE_DIR: dir };
	try {
		await writeStateJson({ env, key: "resume", value });
		return await loadPipelineResumeState(env, "resume");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("loadPipelineResumeState rejects a pipeline stage without a name", async () => {
	await assert.rejects(
		() => loadStored({ ...validApprovalState(), pipeline: [{ args: {}, raw: "map" }] }),
		/Invalid pipeline resume state/,
	);
});

test("loadPipelineResumeState rejects a pipeline stage whose args is an array", async () => {
	await assert.rejects(
		() =>
			loadStored({ ...validApprovalState(), pipeline: [{ name: "map", args: [], raw: "map" }] }),
		/Invalid pipeline resume state/,
	);
});

test("loadPipelineResumeState rejects a resume index past the pipeline length", async () => {
	await assert.rejects(
		() => loadStored({ ...validApprovalState(), resumeAtIndex: 2 }),
		/Invalid pipeline resume state/,
	);
});

test("loadPipelineResumeState rejects a negative resume index", async () => {
	await assert.rejects(
		() => loadStored({ ...validApprovalState(), resumeAtIndex: -1 }),
		/Invalid pipeline resume state/,
	);
});

test("loadPipelineResumeState rejects non-array items", async () => {
	await assert.rejects(
		() => loadStored({ ...validApprovalState(), items: "nope" }),
		/Invalid pipeline resume state/,
	);
});

test("loadPipelineResumeState rejects superseded keys that are not strings", async () => {
	await assert.rejects(
		() => loadStored({ ...validApprovalState(), supersededResumeStateKeys: [1] }),
		/Invalid pipeline resume state/,
	);
});

test("loadPipelineResumeState rejects an unrecognized halt type", async () => {
	await assert.rejects(
		() => loadStored({ ...validApprovalState(), haltType: "other" }),
		/Invalid pipeline resume state/,
	);
});

test("loadPipelineResumeState rejects an unrecognized resume mode", async () => {
	await assert.rejects(
		() => loadStored({ ...validApprovalState(), resumeMode: "sideways" }),
		/Invalid pipeline resume state/,
	);
});

test("loadPipelineResumeState rejects an input request without a schema", async () => {
	await assert.rejects(
		() =>
			loadStored({
				...validApprovalState(),
				items: [],
				haltType: "input_request",
				resumeMode: "next_stage",
				prompt: "enter",
			}),
		/Invalid pipeline resume state/,
	);
});

test("loadPipelineResumeState rejects command input outside a same-stage input resume", async () => {
	await assert.rejects(
		() => loadStored({ ...validApprovalState(), commandInput: { history: [] } }),
		/Invalid pipeline resume state/,
	);
});
