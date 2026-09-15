import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { encodeToken } from "../src/token.js";

const exec = promisify(execFile);
const fixtures = path.join(process.cwd(), "test", "fixtures");
const stage = "openclaw.invoke --tool demo --action read";

async function fixture(t: TestContext, secure: boolean) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lobster-routing-transport-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const requests: { url: string | undefined; token: string | undefined }[] = [];
	let redirect: string | undefined;
	const handler: http.RequestListener = (req, res) => {
		requests.push({ url: req.url, token: req.headers.authorization });
		req.resume();
		if (redirect) {
			res.writeHead(307, { location: redirect });
			res.end();
		} else if (req.headers.authorization !== "Bearer synthetic-current") {
			res.writeHead(401);
			res.end();
		} else {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ok: true, result: [{ done: true }] }));
		}
	};
	const certPath = path.join(fixtures, "credential-routing-test-cert.pem");
	const server = secure
		? https.createServer(
				{
					key: await fs.readFile(path.join(fixtures, "credential-routing-test-key.pem")),
					cert: await fs.readFile(certPath),
				},
				handler,
			)
		: http.createServer(handler);
	server.listen(0);
	await once(server, "listening");
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	// A test-only DNS mapping resolves this name locally. Its origin is NOT in
	// Lobster's loopback allowlist, so the original implementation rejects it.
	const url = `${secure ? "https" : "http"}://gateway.test:${address.port}`;
	const env: NodeJS.ProcessEnv = {
		NODE_OPTIONS: `--import=${JSON.stringify(path.join(fixtures, "credential-routing-lookup.mjs"))}`,
		PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
		HOME: dir,
		LOBSTER_STATE_DIR: dir,
		OPENCLAW_URL: url,
		OPENCLAW_TOKEN: "synthetic-current",
		...(secure ? { NODE_EXTRA_CA_CERTS: certPath } : {}),
	};
	async function cli(args: string[], overrides: NodeJS.ProcessEnv = {}, bin = "lobster.js") {
		try {
			const result = await exec(process.execPath, [path.join(process.cwd(), "bin", bin), ...args], {
				env: { ...env, ...overrides },
				timeout: 10_000,
			});
			return { success: true, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			if (!(error instanceof Error) || !("stdout" in error) || !("stderr" in error)) throw error;
			return { success: false, stdout: String(error.stdout), stderr: String(error.stderr) };
		}
	}
	return {
		dir,
		url,
		requests,
		cli,
		setRedirect: (value: string) => {
			redirect = value;
		},
	};
}

for (const secure of [false, true]) {
	test(`configured remote-origin ${secure ? "TLS" : "HTTP"} authenticates through CLI and both shims`, async (t) => {
		const f = await fixture(t, secure);
		assert.equal((await f.cli(["run", "--mode", "tool", stage])).success, true);
		for (const bin of ["openclaw.invoke.js", "clawd.invoke.js"]) {
			assert.equal((await f.cli(["--tool", "demo", "--action", "read"], {}, bin)).success, true);
		}
		assert.equal(f.requests.length, 3);
		assert.ok(f.requests.every((req) => req.token === "Bearer synthetic-current"));
		assert.equal(
			(await f.cli(["run", "--mode", "tool", stage], { OPENCLAW_TOKEN: "synthetic-wrong" }))
				.success,
			false,
		);
		assert.equal(f.requests.length, 4);
		if (secure) {
			assert.equal(
				(await f.cli(["run", "--mode", "tool", stage], { NODE_EXTRA_CA_CERTS: undefined })).success,
				false,
			);
			assert.equal(f.requests.length, 4, "invalid certificate must fail before HTTP delivery");
		}
	});
}

test("inherited credentials reject same-origin and cross-origin TLS redirects", async (t) => {
	const source = await fixture(t, true);
	const target = await fixture(t, true);
	for (const location of [`${source.url}/other-path`, `${target.url}/tools/invoke`]) {
		source.setRedirect(location);
		assert.equal((await source.cli(["run", "--mode", "tool", stage])).success, false);
	}
	assert.equal(source.requests.length, 2);
	assert.equal(target.requests.length, 0);
});

test("old-release approval checkpoint resumes over TLS without storing current credentials", async (t) => {
	const f = await fixture(t, true);
	const stateKey = "pipeline_resume_credential_upgrade";
	const bytes = await fs.readFile(path.join(fixtures, "credential-routing-2026.6.11.json"));
	const statePath = path.join(f.dir, `${stateKey}.json`);
	await fs.writeFile(statePath, bytes);
	assert.deepEqual(await fs.readFile(statePath), bytes);
	const token = encodeToken({ protocolVersion: 1, v: 1, kind: "pipeline-resume", stateKey });
	const result = await f.cli(["resume", "--token", token, "--approve", "yes"]);
	assert.equal(result.success, true, result.stdout + result.stderr);
	assert.equal(f.requests.length, 1);
	assert.equal((await f.cli(["resume", "--token", token, "--approve", "yes"])).success, false);
	assert.equal(f.requests.length, 1);
	for (const entry of await fs.readdir(f.dir, { withFileTypes: true })) {
		if (entry.isFile())
			assert.equal(
				(await fs.readFile(path.join(f.dir, entry.name), "utf8")).includes("synthetic-current"),
				false,
			);
	}
});
