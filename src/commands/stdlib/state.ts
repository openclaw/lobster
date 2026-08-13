import { promises as fsp } from "node:fs";

import { defaultStateDir, keyToPath, withFileLock, writeStateJson } from "../../state/store.js";
import { carryLlmProvenance } from "./llm_invoke.js";

// What this process last wrote to each state file. A value read straight back is the same value
// rebuilt from its own JSON, and the marks a command attached in-process are not in that JSON:
// without this, `llm.invoke | state.set k | state.get k` turns a replay that cost nothing into an
// item indistinguishable from one that was paid for. The remembered text has to match the file
// byte for byte, so nothing written by anything else can pick up marks it was never given.
const lastWritten = new Map<string, { text: string; value: unknown }>();
const MAX_REMEMBERED_WRITES = 64;

function rememberWrite(filePath: string, text: string, value: unknown) {
	lastWritten.set(filePath, { text, value });
	for (const oldest of lastWritten.keys()) {
		if (lastWritten.size <= MAX_REMEMBERED_WRITES) break;
		lastWritten.delete(oldest);
	}
}

async function readRememberedState({ env, key, signal }) {
	const filePath = keyToPath(defaultStateDir(env), key);
	const read = async () => {
		try {
			const text = await fsp.readFile(filePath, "utf8");
			const value = JSON.parse(text);
			const written = lastWritten.get(filePath);
			if (written?.text === text) carryLlmProvenance(written.value, value);
			return value;
		} catch (err: any) {
			if (err?.code === "ENOENT") return null;
			throw err;
		}
	};

	try {
		return await withFileLock({ filePath, signal, task: read });
	} catch (err: any) {
		if (["EACCES", "EPERM", "EROFS"].includes(err?.code)) return read();
		throw err;
	}
}

export const stateGetCommand = {
	name: "state.get",
	meta: {
		description: "Read a JSON value from Lobster state",
		argsSchema: {
			type: "object",
			properties: {
				_: { type: "array", items: { type: "string" }, description: "Key" },
			},
			required: ["_"],
		},
		sideEffects: ["reads_state"],
	},
	help() {
		return `state.get — read a JSON value from Lobster state\n\nUsage:\n  state.get <key>\n\nEnv:\n  LOBSTER_STATE_DIR overrides storage directory\n`;
	},
	async run({ args, ctx }) {
		const key = args._[0];
		if (!key) throw new Error("state.get requires a key");

		const value = await readRememberedState({ env: ctx.env, key, signal: ctx.signal });

		return { output: asStream([value]) };
	},
};

export const stateSetCommand = {
	name: "state.set",
	meta: {
		description: "Write a JSON value to Lobster state",
		argsSchema: {
			type: "object",
			properties: {
				_: { type: "array", items: { type: "string" }, description: "Key" },
			},
			required: ["_"],
		},
		sideEffects: ["writes_state"],
	},
	help() {
		return `state.set — write a JSON value to Lobster state\n\nUsage:\n  <value> | state.set <key>\n\nNotes:\n  - Consumes the entire input stream; stores a single JSON value.\n`;
	},
	async run({ input, args, ctx }) {
		const key = args._[0];
		if (!key) throw new Error("state.set requires a key");

		const items = [];
		for await (const item of input) items.push(item);

		const value = items.length === 1 ? items[0] : items;

		const text = JSON.stringify(value, null, 2) + "\n";
		await writeStateJson({ env: ctx.env, key, value, signal: ctx.signal });
		const filePath = keyToPath(defaultStateDir(ctx.env), key);
		rememberWrite(filePath, text, value);

		return { output: asStream([value]) };
	},
};

async function* asStream(items) {
	for (const item of items) yield item;
}
