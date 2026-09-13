import type { WorkflowFile, WorkflowStep, WorkflowStepResult } from "./types.js";
import {
	resolveArgsTemplate,
	resolveTemplate,
	parseStepRef,
	getStepRefValue,
} from "./expressions.js";

export function createRecord<T>(source?: Record<string, T>): Record<string, T> {
	const record = Object.create(null) as Record<string, T>;
	if (!source) return record;
	for (const [key, value] of Object.entries(source)) record[key] = value;
	return record;
}

export function mergeEnv(
	base: Record<string, string | undefined>,
	workflowEnv: WorkflowFile["env"],
	stepEnv: WorkflowStep["env"],
	args: Record<string, unknown>,
	results: Record<string, WorkflowStepResult>,
) {
	const env = createRecord(base);

	// Expose resolved args as env vars so shell commands can safely reference them
	// without embedding raw values into the command string.
	// Example: $LOBSTER_ARG_TEXT
	env.LOBSTER_ARGS_JSON = JSON.stringify(args ?? {});
	for (const [key, value] of Object.entries(args ?? {})) {
		const normalized = normalizeArgEnvKey(key);
		if (!normalized) continue;
		env[`LOBSTER_ARG_${normalized}`] = String(value);
	}

	const apply = (source?: Record<string, string>) => {
		if (!source) return;
		for (const [key, value] of Object.entries(source)) {
			if (typeof value === "string") {
				env[key] = resolveTemplate(value, args, results);
			}
		}
	};

	// Allow explicit env blocks to override injected defaults.
	apply(workflowEnv);
	apply(stepEnv);
	return env;
}

function normalizeArgEnvKey(key: string): string | null {
	const trimmed = String(key ?? "").trim();
	if (!trimmed) return null;
	// Keep it predictable for shells: uppercase and [A-Z0-9_]
	const up = trimmed.toUpperCase();
	let normalized = up.replace(/[^A-Z0-9]+/g, "_");
	let start = 0;
	while (normalized[start] === "_") start++;
	let end = normalized.length;
	while (end > start && normalized[end - 1] === "_") end--;
	normalized = normalized.slice(start, end);
	return normalized || null;
}

export function resolveCwd(cwd: string | undefined, args: Record<string, unknown>) {
	if (!cwd) return undefined;
	return resolveArgsTemplate(cwd, args);
}

export function resolveInputValue(
	stdin: unknown,
	args: Record<string, unknown>,
	results: Record<string, WorkflowStepResult>,
) {
	if (stdin === null || stdin === undefined) return null;
	if (typeof stdin === "string") {
		const ref = parseStepRef(stdin.trim());
		if (ref) return getStepRefValue(ref, results, true);
		return resolveTemplate(stdin, args, results);
	}
	return stdin;
}

export function resolveShellStdin(
	stdin: unknown,
	args: Record<string, unknown>,
	results: Record<string, WorkflowStepResult>,
) {
	const value = resolveInputValue(stdin, args, results);
	return encodeShellInput(value);
}

export function resolveWorkflowStepArgs(
	workflowArgs: Record<string, unknown> | undefined,
	parentArgs: Record<string, unknown>,
	results: Record<string, WorkflowStepResult>,
): Record<string, unknown> {
	if (!workflowArgs) return createRecord();
	const resolved = createRecord<unknown>();
	for (const [key, value] of Object.entries(workflowArgs)) {
		if (typeof value === "string") {
			resolved[key] = resolveTemplate(value, parentArgs, results);
		} else {
			resolved[key] = value;
		}
	}
	return resolved;
}

export function encodeShellInput(value: unknown) {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}
