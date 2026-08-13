export type CommandMeta = {
	description?: string;
	argsSchema?: unknown;
	examples?: Array<{ args: Record<string, unknown>; description?: string }>;
	sideEffects?: string[];
	/**
	 * The command may create an input/approval gate before it begins execution.
	 * Commands that omit this are treated conservatively when a resumed pipeline
	 * is cancelled: its original capability cannot be replayed after dispatch.
	 */
	resumeSafeBeforeInput?: boolean;
	/**
	 * The command remains side-effect-free after returning a resumed input until
	 * the next pipeline stage dispatches. This is intentionally opt-in so a
	 * command that acts on a resumed response consumes its capability first.
	 */
	resumeSafeAfterInput?: boolean;
};

export type LobsterCommand = {
	name: string;
	help: () => string;
	run: (params: any) => Promise<any>;
	meta?: CommandMeta;
};
