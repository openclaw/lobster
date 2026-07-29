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
};

export type LobsterCommand = {
	name: string;
	help: () => string;
	run: (params: any) => Promise<any>;
	meta?: CommandMeta;
};
