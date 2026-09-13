export function stateEnv(ctx: { stateDir?: string; env?: NodeJS.ProcessEnv } | undefined) {
	return ctx?.stateDir
		? { ...(ctx?.env ?? process.env), LOBSTER_STATE_DIR: ctx.stateDir }
		: (ctx?.env ?? process.env);
}
