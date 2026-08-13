#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { access } from "node:fs/promises";

const [runnerPath, mockGog] = process.argv.slice(2);
const { runAbortableProcess } = await import(pathToFileURL(runnerPath).href);

async function waitFor(path) {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		try {
			await access(path);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

const controller = new AbortController();
const run = runAbortableProcess({
	command: process.execPath,
	argv: [mockGog, "gmail", "search"],
	env: process.env,
	signal: controller.signal,
	notFoundMessage: "mock gog not found",
});

await waitFor(process.env.MOCK_GOG_SEARCH_STARTED_FILE);
await waitFor(process.env.MOCK_GOG_DESCENDANT_STARTED_FILE);
controller.abort(new Error("cancelled by short-lived caller"));
await run.catch(() => undefined);
