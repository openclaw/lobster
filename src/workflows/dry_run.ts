import { parsePipeline } from "../parser.js";
import { resolveRetryConfig, type RetryConfig } from "../core/retry.js";
import { resolveArgsTemplate, evaluateCondition } from "./expressions.js";
import { createRecord, resolveInputValue } from "./values.js";
import { getStepExecution, isApprovalStep, isInputStep } from "./load.js";
import type { WorkflowStep, WorkflowStepResult, WorkflowRunResult } from "./types.js";

function dryRunStdinNote(stdin: unknown): string | null {
	if (stdin === null || stdin === undefined) return null;
	if (typeof stdin !== "string") return null;
	const trimmed = stdin.trim();
	// Strict step ref: '$step-id.stdout' or '$step-id.json'
	if (/^\$[A-Za-z0-9_-]+\.(stdout|json)$/.test(trimmed)) {
		return `${trimmed}  [output unknown at plan time]`;
	}
	// Inline template ref: contains '$stepid.stdout' or '$stepid.json'
	if (/\$[A-Za-z0-9_-]+\.(stdout|json)/.test(trimmed)) {
		return `${trimmed}  [contains step output refs — unknown at plan time]`;
	}
	return null;
}

function dryRunTemplateNote(input: string): string | null {
	if (/\$[A-Za-z0-9_-]+\.(stdout|json)/.test(input)) {
		return "[contains step output refs — unknown at plan time]";
	}
	return null;
}

function hasDeferredDryRunStageName(input: string) {
	return /\$[A-Za-z0-9_-]+\.(stdout|json)/.test(input);
}

function resolveDryRunTemplate(
	input: string,
	args: Record<string, unknown>,
	results: Record<string, WorkflowStepResult>,
) {
	const withArgs = resolveArgsTemplate(input, args);
	return withArgs.replace(/\$([A-Za-z0-9_-]+)\.(stdout|json|approved)/g, (match, id, field) => {
		if (field === "approved") {
			const step = results[id];
			if (!step) return match;
			return step.approved === true ? "true" : "false";
		}
		return match;
	});
}

export function dryRunWorkflow({
	steps,
	resolvedArgs,
	results,
	startIndex,
	ctx,
}: {
	steps: WorkflowStep[];
	resolvedArgs: Record<string, unknown>;
	results: Record<string, WorkflowStepResult>;
	startIndex: number;
	ctx: { stderr: NodeJS.WritableStream; registry?: { get: (name: string) => unknown } };
}): WorkflowRunResult {
	const lines: string[] = [];
	const totalSteps = steps.length - startIndex;
	lines.push(`[DRY RUN] Would execute ${totalSteps} step${totalSteps !== 1 ? "s" : ""}:\n`);

	for (let idx = startIndex; idx < steps.length; idx++) {
		const step = steps[idx];
		const num = idx - startIndex + 1;

		if (!evaluateCondition(step.when ?? step.condition, results)) {
			results[step.id] = { id: step.id, skipped: true };
			lines.push(`  ${num}. ${step.id}  [skipped — condition: false]`);
			continue;
		}

		if (isInputStep(step.input)) {
			lines.push(`  ${num}. ${step.id}  [input]`);
			lines.push(`     prompt: ${step.input.prompt}`);
			lines.push(`     [input required]`);
			results[step.id] = { id: step.id, response: { pending: true } };
			continue;
		}

		if (typeof step.for_each === "string" && Array.isArray(step.steps)) {
			lines.push(`  ${num}. ${step.id}  [for_each]`);
			const forEachRef = step.for_each;
			const forEachNote = dryRunTemplateNote(forEachRef);
			lines.push(`     for_each: ${forEachRef}${forEachNote ? `  ${forEachNote}` : ""}`);
			if (forEachRef.trim().startsWith("$")) {
				try {
					resolveInputValue(forEachRef, resolvedArgs, results);
				} catch (err: any) {
					throw new Error(`Workflow step ${step.id} for_each: ${err?.message ?? String(err)}`);
				}
			}
			const dryItemVar = step.item_var ?? "item";
			const dryIndexVar = step.index_var ?? "index";
			lines.push(`     item_var: ${dryItemVar}, index_var: ${dryIndexVar}`);
			if (step.batch_size) lines.push(`     batch_size: ${step.batch_size}`);
			if (step.pause_ms) lines.push(`     pause_ms: ${step.pause_ms}`);
			lines.push(`     sub-steps: ${step.steps.length}`);

			const loopScopedResults = createRecord(results);
			loopScopedResults[dryItemVar] = { id: dryItemVar, json: { _placeholder: true } };
			loopScopedResults[dryIndexVar] = { id: dryIndexVar, json: 0 };
			for (let subIdx = 0; subIdx < step.steps.length; subIdx++) {
				const sub = step.steps[subIdx];
				if (!evaluateCondition(sub.when ?? sub.condition, loopScopedResults)) {
					lines.push(`       ${subIdx + 1}. ${sub.id}  [skipped — condition: false]`);
					loopScopedResults[sub.id] = { id: sub.id, skipped: true };
					continue;
				}
				if (sub.stdin !== undefined && sub.stdin !== null) {
					try {
						resolveInputValue(sub.stdin, resolvedArgs, loopScopedResults);
					} catch (err: any) {
						throw new Error(
							`Workflow step ${step.id} for_each sub-step ${sub.id} stdin: ${err?.message ?? String(err)}`,
						);
					}
				}
				const subExec = getStepExecution(sub);
				if (subExec.kind === "shell") {
					const command = resolveDryRunTemplate(subExec.value, resolvedArgs, loopScopedResults);
					lines.push(`       ${subIdx + 1}. ${sub.id}  [shell] run: ${command}`);
				} else if (subExec.kind === "pipeline") {
					if (!ctx.registry) {
						throw new Error(
							`Workflow step ${step.id} for_each sub-step ${sub.id} requires a command registry for pipeline execution`,
						);
					}
					const pipelineText = resolveDryRunTemplate(
						subExec.value,
						resolvedArgs,
						loopScopedResults,
					);
					const stages = parsePipeline(pipelineText);
					for (const stage of stages) {
						if (hasDeferredDryRunStageName(stage.name)) continue;
						if (!ctx.registry.get(stage.name)) {
							throw new Error(
								`Workflow step ${step.id} for_each sub-step ${sub.id} pipeline: unknown command: ${stage.name}`,
							);
						}
					}
					lines.push(`       ${subIdx + 1}. ${sub.id}  [pipeline] pipeline: ${pipelineText}`);
				} else {
					lines.push(`       ${subIdx + 1}. ${sub.id}  [no-op]`);
				}
				loopScopedResults[sub.id] = { id: sub.id };
			}
			if (step.timeout_ms) lines.push(`     timeout: ${step.timeout_ms}ms`);
			if (step.on_error && step.on_error !== "stop") lines.push(`     on_error: ${step.on_error}`);
			if (step.retry && typeof step.retry === "object") {
				const rc = resolveRetryConfig(step.retry as RetryConfig);
				if (rc.max > 1) {
					lines.push(
						`     retry: up to ${rc.max} attempts, ${rc.backoff} backoff (base: ${rc.delay_ms}ms${rc.jitter ? ", jitter" : ""})`,
					);
				}
			}
			results[step.id] = { id: step.id };
			continue;
		}

		// Validate stdin refs early — throws if a strict ref like '$missing.stdout'
		// points to a step that doesn't exist at all (real execution would also fail).
		// We call resolveInputValue with the current results so refs to steps we've
		// already visited (placeholders) are accepted without throwing.
		if (step.stdin !== undefined && step.stdin !== null) {
			try {
				resolveInputValue(step.stdin, resolvedArgs, results);
			} catch (err: any) {
				throw new Error(`Workflow step ${step.id} stdin: ${err?.message ?? String(err)}`);
			}
		}

		const execution = getStepExecution(step);

		// Annotate when the resolved command/pipeline references a prior step's output.
		// Since dry-run placeholders have no actual stdout/json, note it explicitly
		// rather than silently collapsing the reference to an empty string.
		const stdinNote = dryRunStdinNote(step.stdin);

		if (execution.kind === "parallel") {
			lines.push(`  ${num}. ${step.id}  [parallel]`);
			lines.push(`     wait: ${step.parallel?.wait ?? "all"}`);
			if (step.parallel?.timeout_ms) {
				lines.push(`     timeout: ${step.parallel.timeout_ms}ms`);
			}
			for (const branch of step.parallel?.branches ?? []) {
				const branchShell = typeof branch.run === "string" ? branch.run : branch.command;
				if (typeof branch.pipeline === "string" && branch.pipeline.trim()) {
					const pipelineText = resolveDryRunTemplate(branch.pipeline, resolvedArgs, results);
					const pipelineNote = dryRunTemplateNote(pipelineText);
					if (!ctx.registry) {
						throw new Error(
							`Parallel branch ${branch.id} requires a command registry for pipeline execution`,
						);
					}
					const stages = parsePipeline(pipelineText);
					for (const stage of stages) {
						if (hasDeferredDryRunStageName(stage.name)) continue;
						if (!ctx.registry.get(stage.name)) {
							throw new Error(
								`Parallel branch ${branch.id} pipeline references unknown command: ${stage.name}`,
							);
						}
					}
					lines.push(
						`     branch ${branch.id}: [pipeline] ${pipelineText}${pipelineNote ? `  ${pipelineNote}` : ""}`,
					);
				} else if (typeof branchShell === "string" && branchShell.trim()) {
					const command = resolveDryRunTemplate(branchShell, resolvedArgs, results);
					const commandNote = dryRunTemplateNote(command);
					lines.push(
						`     branch ${branch.id}: [shell] ${command}${commandNote ? `  ${commandNote}` : ""}`,
					);
				} else {
					lines.push(`     branch ${branch.id}: [no-op]`);
				}
				results[branch.id] = { id: branch.id };
			}
		} else if (execution.kind === "workflow") {
			const workflowPath = resolveDryRunTemplate(execution.value, resolvedArgs, results);
			const pathNote = dryRunTemplateNote(workflowPath);
			lines.push(`  ${num}. ${step.id}  [workflow]`);
			lines.push(`     workflow: ${workflowPath}${pathNote ? `  ${pathNote}` : ""}`);
			if (step.workflow_args && typeof step.workflow_args === "object") {
				const argKeys = Object.keys(step.workflow_args);
				if (argKeys.length) {
					lines.push(`     args: ${argKeys.join(", ")}`);
				}
			}
		} else if (execution.kind === "shell") {
			const command = resolveDryRunTemplate(execution.value, resolvedArgs, results);
			const commandNote = dryRunTemplateNote(command);
			lines.push(`  ${num}. ${step.id}  [shell]`);
			lines.push(`     run: ${command}${commandNote ? `  ${commandNote}` : ""}`);
		} else if (execution.kind === "pipeline") {
			const pipelineText = resolveDryRunTemplate(execution.value, resolvedArgs, results);
			const pipelineNote = dryRunTemplateNote(pipelineText);
			// Validate pipeline syntax and registry even in dry-run so errors surface early.
			if (!ctx.registry) {
				throw new Error(
					`Workflow step ${step.id} requires a command registry for pipeline execution`,
				);
			}
			// Validate that every stage name is a known command.
			const stages = parsePipeline(pipelineText);
			for (const stage of stages) {
				if (hasDeferredDryRunStageName(stage.name)) {
					continue;
				}
				if (!ctx.registry.get(stage.name)) {
					throw new Error(
						`Workflow step ${step.id} pipeline references unknown command: ${stage.name}`,
					);
				}
			}
			lines.push(`  ${num}. ${step.id}  [pipeline]`);
			lines.push(`     pipeline: ${pipelineText}${pipelineNote ? `  ${pipelineNote}` : ""}`);
			if (stages.some((stage) => hasDeferredDryRunStageName(stage.name))) {
				lines.push("     [command validation deferred — stage name depends on step output]");
			}
		} else {
			lines.push(`  ${num}. ${step.id}  [no-op]`);
		}

		if (stdinNote) lines.push(`     stdin: ${stdinNote}`);
		if (step.timeout_ms) lines.push(`     timeout: ${step.timeout_ms}ms`);
		if (step.on_error && step.on_error !== "stop") lines.push(`     on_error: ${step.on_error}`);
		if (step.retry && typeof step.retry === "object") {
			const rc = resolveRetryConfig(step.retry as RetryConfig);
			if (rc.max > 1) {
				lines.push(
					`     retry: up to ${rc.max} attempts, ${rc.backoff} backoff (base: ${rc.delay_ms}ms${rc.jitter ? ", jitter" : ""})`,
				);
			}
		}
		if (isApprovalStep(step.approval)) {
			lines.push(`     [approval required]`);
		}

		// Record a placeholder result so later steps can reference this step in conditions.
		// For approval steps, model approval as granted so downstream conditions like
		// $step.approved evaluate correctly in the plan (rather than always being false).
		// We intentionally omit stdout/json — dryRunStdinNote() surfaces that gap.
		results[step.id] = isApprovalStep(step.approval)
			? { id: step.id, approved: true }
			: { id: step.id };
	}

	lines.push("");
	ctx.stderr.write(lines.join("\n"));
	return { status: "ok", output: [] };
}
