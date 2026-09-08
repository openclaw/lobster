import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Lobster, exec } from "../src/sdk/index.js";
import { runAbortableProcess } from "../src/abortable_process.js";
import { waitForPid } from "./helpers/wait_for_pid.js";
import { nodeShellFixture } from "./helpers/node_shell_fixture.js";

const run = promisify(execFile);
const large = 10 * 1024 * 1024 + 1;
const cli = path.resolve("bin/lobster.js");
const quote = (s: string) => JSON.stringify(s);

for (const stream of ["stdout", "stderr"]) {
	test(`SDK ${stream} is unlimited by default and honors the opt-in byte limit`, async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "lobster-output-"));
		try {
			const file = path.join(dir, "emit.cjs");
			await writeFile(file, `process.${stream}.write('x'.repeat(${large}));`);
			for (const limit of ["", "1024"]) {
				const result = await new Lobster({
					env: { ...process.env, LOBSTER_MAX_OUTPUT_BYTES: limit },
				})
					.pipe(exec(`${quote(process.execPath)} ${quote(file)}`, { json: false }))
					.run();
				assert.equal(result.ok, limit === "");
				if (limit) assert.match(result.error.message, /Process output exceeded 1024 bytes/);
				else assert.equal(result.output[0].length, stream === "stdout" ? large : 0);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}

test("process caps count actual bytes and accept the exact boundary", async () => {
	for (const bytes of [Buffer.from("😀"), Buffer.from([0xff, 0xff, 0xff, 0xff])]) {
		const result = await runAbortableProcess({
			command: process.execPath,
			argv: ["-e", `process.stdout.write(Buffer.from('${bytes.toString("hex")}', 'hex'))`],
			env: { ...process.env, LOBSTER_MAX_OUTPUT_BYTES: "4" },
			notFoundMessage: "node missing",
		});
		assert.equal(result.stdout, bytes.toString("utf8"));
	}
});

test("invalid process limits fail before spawning", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "lobster-invalid-limit-"));
	try {
		const marker = path.join(dir, "started");
		for (const value of ["0", "-1", "1.5", "Infinity", "true", "9007199254740992"]) {
			await assert.rejects(
				runAbortableProcess({
					command: process.execPath,
					argv: ["-e", `require('node:fs').writeFileSync(${quote(marker)}, 'started')`],
					env: { ...process.env, LOBSTER_MAX_OUTPUT_BYTES: value },
					notFoundMessage: "node missing",
				}),
				/LOBSTER_MAX_OUTPUT_BYTES must be a positive safe integer/,
			);
		}
		await assert.rejects(readFile(marker), { code: "ENOENT" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("built CLI exec and workflow env preserve unlimited output and enable finite limits", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "lobster-cli-limit-"));
	try {
		const file = path.join(dir, "emit.cjs");
		await writeFile(file, `process.stdout.write('x'.repeat(${large}));`);
		const command = `${quote(process.execPath)} ${quote(file)}`;
		for (const workflow of [false, true]) {
			for (const limit of ["", "1024"]) {
				const filePath = path.join(dir, "workflow.json");
				await writeFile(
					filePath,
					JSON.stringify({
						steps: [{ id: "emit", run: command, env: { LOBSTER_MAX_OUTPUT_BYTES: limit } }],
					}),
				);
				const args = workflow ? ["--file", filePath] : [`exec ${command}`];
				const result = await run(process.execPath, [cli, "run", "--mode", "tool", ...args], {
					env: {
						...process.env,
						LOBSTER_MAX_OUTPUT_BYTES: workflow ? "" : limit,
						LOBSTER_STATE_DIR: path.join(dir, "state"),
					},
					maxBuffer: 20 * 1024 * 1024,
				}).then(
					(r) => ({ code: 0, stdout: r.stdout }),
					(e) => ({ code: e.code, stdout: e.stdout }),
				);
				const envelope = JSON.parse(result.stdout);
				assert.equal(envelope.ok, limit === "");
				if (limit) assert.match(envelope.error.message, /Process output exceeded 1024 bytes/);
				else assert.equal(envelope.output[0].length, large);
			}
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

function isAlive(pid: number) {
	const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
		encoding: "utf8",
	}).stdout.trim();
	return stat !== "" && !stat.startsWith("Z");
}

for (const mode of ["overflow", "interrupt", "host-handler", "once-handler", "host-exit"]) {
	test(
		`capped no-signal SDK shell cleans its background producer on ${mode}`,
		{ skip: process.platform === "win32", timeout: 15_000 },
		async () => {
			const dir = await mkdtemp(path.join(tmpdir(), "lobster-output-tree-"));
			let wrapper: ReturnType<typeof spawn> | undefined;
			let pid: number | undefined;
			try {
				const runner = path.join(dir, "runner.mjs");
				const marker = path.join(dir, "pid"),
					received = path.join(dir, "signal");
				const fixture = await nodeShellFixture(
					dir,
					`const fs=require('node:fs');
process.on('SIGTERM',()=>{});
process.on('SIGINT',()=>fs.writeFileSync(${quote(received)}, 'SIGINT'));
fs.writeFileSync(${quote(marker)},String(process.pid));
setInterval(()=>{${mode === "overflow" ? "process.stdout.write('x'.repeat(2048));" : ""}},30);`,
				);
				await writeFile(
					runner,
					`import {Lobster,exec} from ${quote(new URL("../src/sdk/index.js", import.meta.url).href)};
${mode === "host-handler" || mode === "once-handler" ? `process.${mode === "once-handler" ? "once" : "on"}('SIGINT',()=>console.log('host handled SIGINT'));` : ""}
${mode === "host-exit" ? "process.on('SIGUSR2',()=>process.exit(0));" : ""}
const result=await new Lobster({env:{...process.env,LOBSTER_MAX_OUTPUT_BYTES:'1024'}})
.pipe(exec(${quote(`${fixture.command} & wait`)},{shell:true,json:false})).run();
console.log(JSON.stringify(result));`,
				);
				wrapper = spawn(process.execPath, [runner], {
					env: { ...process.env, ...fixture.env },
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "",
					stderr = "";
				wrapper.stdout!.on("data", (x) => (stdout += x));
				wrapper.stderr!.on("data", (x) => (stderr += x));
				const closed = new Promise<number | null>((resolve) => wrapper!.once("close", resolve));
				pid = await waitForPid(marker);
				if (mode === "interrupt" || mode === "host-handler" || mode === "once-handler")
					wrapper.kill("SIGINT");
				if (mode === "host-exit") wrapper.kill("SIGUSR2");
				let timer: ReturnType<typeof setTimeout>;
				const code = await Promise.race([
					closed,
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error(`wrapper hung: ${stderr}`)), 5000);
					}),
				]).finally(() => clearTimeout(timer));
				assert.equal(code, mode === "interrupt" ? 130 : 0, stderr);
				assert.equal(isAlive(pid), false, "producer must not survive its owner");
				if (mode === "overflow") assert.match(stdout, /Process output exceeded 1024 bytes/);
				if (mode === "host-handler" || mode === "once-handler")
					assert.match(stdout, /host handled SIGINT/);
				if (mode === "interrupt" || mode === "host-handler" || mode === "once-handler")
					assert.equal(await readFile(received, "utf8"), "SIGINT");
			} finally {
				if (pid) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
				if (wrapper?.pid) {
					try {
						process.kill(-wrapper.pid, "SIGKILL");
					} catch {}
				}
				await rm(dir, { recursive: true, force: true });
			}
		},
	);
}
