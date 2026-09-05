import { readFile } from "node:fs/promises";

export async function waitForPid(path: string, timeoutMs = 5000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			// File creation becomes visible before the fixture writes its PID.
			const pid = Number((await readFile(path, "utf8")).trim());
			if (Number.isSafeInteger(pid) && pid > 0) return pid;
		} catch (error: any) {
			if (error.code !== "ENOENT") throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for PID in ${path}`);
}
