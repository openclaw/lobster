// The pipeline parser turns a bare `--name` into `true`, and an unset workflow arg can leave
// `--name` bare or empty. A value option must then fail instead of quietly changing the result.
export function readOptionValue(args: Record<string, unknown>, command: string, name: string) {
	const value = args[name];
	if (value === true || (typeof value === "string" && value.trim() === "")) {
		throw new Error(`${command} --${name} requires a value`);
	}
	return value;
}
