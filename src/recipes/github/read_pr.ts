import { runAbortableProcess } from "../../abortable_process.js";

const DEFAULT_FIELDS = [
	"number",
	"title",
	"url",
	"state",
	"isDraft",
	"mergeable",
	"reviewDecision",
	"author",
	"baseRefName",
	"headRefName",
	"updatedAt",
];

export async function runGithubPr({
	repo,
	pr,
	fields,
	env,
	cwd,
	signal,
	forceTerminationSignal,
}: {
	repo: string;
	pr: string | number;
	fields?: string[] | null;
	env: NodeJS.ProcessEnv;
	cwd: string;
	signal?: AbortSignal;
	forceTerminationSignal?: AbortSignal;
}) {
	const { stdout, stderr, code } = await runAbortableProcess({
		command: "gh",
		argv: [
			"pr",
			"view",
			String(pr),
			"--repo",
			String(repo),
			"--json",
			(fields ?? DEFAULT_FIELDS).join(","),
		],
		env,
		cwd,
		signal,
		forceTerminationSignal,
		notFoundMessage: "gh not found on PATH (install GitHub CLI)",
	});
	if (code !== 0) throw new Error(`gh failed (${code}): ${stderr.trim() || stdout.trim()}`);
	return stdout;
}

export function parseGithubPr(stdout: string) {
	try {
		return JSON.parse(stdout.trim());
	} catch {
		throw new Error("gh returned non-JSON output");
	}
}
