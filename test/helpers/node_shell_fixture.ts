import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function nodeShellFixture(dir: string, script: string) {
	const scriptPath = join(dir, "script.cjs");
	await writeFile(scriptPath, script);
	return {
		command:
			process.platform === "win32"
				? '"%LOBSTER_TEST_NODE%" "%LOBSTER_TEST_SCRIPT%"'
				: '"$LOBSTER_TEST_NODE" "$LOBSTER_TEST_SCRIPT"',
		env: {
			LOBSTER_SHELL: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
			LOBSTER_TEST_NODE: process.execPath,
			LOBSTER_TEST_SCRIPT: scriptPath,
		},
	};
}
