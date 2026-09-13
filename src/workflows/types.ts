import type { CostLimit, CostSummary } from "../core/cost_tracker.js";

export type WorkflowFile = {
	name?: string;
	description?: string;
	args?: Record<string, { default?: unknown; description?: string }>;
	env?: Record<string, string>;
	cwd?: string;
	steps: WorkflowStep[];
	cost_limit?: CostLimit;
};

export type ParallelBranch = {
	id: string;
	run?: string;
	command?: string;
	pipeline?: string;
	env?: Record<string, string>;
	cwd?: string;
	stdin?: unknown;
};

export type ParallelConfig = {
	wait?: "all" | "any";
	timeout_ms?: number;
	branches: ParallelBranch[];
};

export type WorkflowStep = {
	id: string;
	command?: string;
	run?: string;
	pipeline?: string;
	workflow?: string;
	workflow_args?: Record<string, unknown>;
	env?: Record<string, string>;
	cwd?: string;
	stdin?: unknown;
	approval?: WorkflowApproval;
	input?: WorkflowInputRequest;
	condition?: unknown;
	when?: unknown;
	parallel?: ParallelConfig;
	for_each?: string;
	item_var?: string;
	index_var?: string;
	batch_size?: number;
	pause_ms?: number;
	steps?: WorkflowStep[];
	timeout_ms?: number;
	on_error?: "stop" | "continue" | "skip_rest";
	retry?: {
		max?: number;
		backoff?: "fixed" | "exponential";
		delay_ms?: number;
		max_delay_ms?: number;
		jitter?: boolean;
	};
};

export type WorkflowApproval =
	| boolean
	| "required"
	| string
	| {
			prompt?: string;
			items?: unknown[];
			preview?: string;
			initiated_by?: string;
			initiatedBy?: string;
			required_approver?: string;
			requiredApprover?: string;
			require_different_approver?: boolean;
			requireDifferentApprover?: boolean;
	  };

export type WorkflowApprovalIdentity = {
	initiatedBy?: string;
	requiredApprover?: string;
	requireDifferentApprover?: boolean;
};

export type WorkflowInputRequest = {
	prompt: string;
	responseSchema: unknown;
	defaults?: unknown;
};

export type WorkflowStepResult = {
	id: string;
	stdout?: string;
	json?: unknown;
	approved?: boolean;
	initiatedBy?: string;
	approvedBy?: string;
	subject?: unknown;
	response?: unknown;
	skipped?: boolean;
	error?: boolean;
	errorMessage?: string;
};

export type WorkflowRunResult = {
	status: "ok" | "needs_approval" | "needs_input" | "cancelled";
	output: unknown[];
	requiresApproval?: {
		type: "approval_request";
		prompt: string;
		items: unknown[];
		preview?: string;
		initiatedBy?: string;
		requiredApprover?: string;
		requireDifferentApprover?: boolean;
		resumeToken?: string;
		approvalId?: string;
	};
	requiresInput?: {
		type: "input_request";
		prompt: string;
		responseSchema: unknown;
		defaults?: unknown;
		subject?: unknown;
		resumeToken?: string;
	};
	_meta?: {
		cost?: CostSummary;
	};
};
