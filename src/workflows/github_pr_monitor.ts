import { diffAndStore } from "../state/store.js";
import { runGithubPr, parseGithubPr } from "../recipes/github/read_pr.js";
import { buildPrChangeSummary, formatPrChangeMessage } from "../recipes/github/snapshot.js";
export { buildPrChangeSummary } from "../recipes/github/snapshot.js";

export async function runGithubPrMonitorWorkflow({ args, ctx }) {
	ctx.signal?.throwIfAborted();
	const repo = args.repo;
	const pr = args.pr;
	if (!repo || !pr) throw new Error("github.pr.monitor requires args.repo and args.pr");

	const key = args.key ?? `github.pr:${repo}#${pr}`;
	const changesOnly = Boolean(args.changesOnly);
	const summaryOnly = Boolean(args.summaryOnly);

	const stdout = await runGithubPr({
		repo,
		pr,
		env: ctx.env,
		cwd: process.cwd(),
		signal: ctx.signal,
		forceTerminationSignal: ctx.forceTerminationSignal,
	});
	ctx.signal?.throwIfAborted();
	const current = parseGithubPr(stdout);

	const { changed, before } = await diffAndStore({
		env: ctx.env,
		key,
		value: current,
		signal: ctx.signal,
	});

	if (changesOnly && !changed) {
		return {
			kind: "github.pr.monitor",
			repo,
			prNumber: Number(pr),
			key,
			changed: false,
			suppressed: true,
		};
	}

	const summary = buildPrChangeSummary(before, current);

	if (summaryOnly) {
		return {
			kind: "github.pr.monitor",
			repo,
			prNumber: Number(pr),
			key,
			changed,
			summary,
			pr: {
				number: current.number,
				title: current.title,
				url: current.url,
				state: current.state,
				updatedAt: current.updatedAt,
			},
		};
	}

	return {
		kind: "github.pr.monitor",
		repo,
		prNumber: Number(pr),
		key,
		changed,
		summary,
		prSnapshot: current,
	};
}

export async function runGithubPrMonitorNotifyWorkflow({ args, ctx }) {
	const base = await runGithubPrMonitorWorkflow({
		args: {
			...args,
			changesOnly: true,
			summaryOnly: true,
		},
		ctx,
	});

	if (base.suppressed) {
		return { kind: "github.pr.monitor.notify", suppressed: true };
	}

	const changedFields = base.summary?.changedFields ?? [];
	const prInfo = base.pr ?? {};

	return {
		kind: "github.pr.monitor.notify",
		changed: Boolean(base.changed),
		repo: args.repo,
		prNumber: Number(args.pr),
		message: formatPrChangeMessage({
			repo: args.repo,
			pr: Number(args.pr),
			changedFields,
			prInfo,
		}),
		pr: prInfo,
		summary: base.summary,
	};
}
