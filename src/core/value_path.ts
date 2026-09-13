/** Resolve command dot paths, ignoring empty segments and stopping at nullish values. */
export function getByPath(value: unknown, path: string): unknown {
	let current = value;
	for (const field of path.split(".").filter(Boolean)) {
		if (current == null) return undefined;
		current = (current as Record<string, unknown>)[field];
	}
	return current;
}
