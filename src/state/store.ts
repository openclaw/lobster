import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { randomBytes } from "node:crypto";

const CONSUMED_RESUME_STATE_TYPE = "lobster.consumed-resume-state.v1";

export type ConsumedResumeState = {
	type: typeof CONSUMED_RESUME_STATE_TYPE;
	consumedAt: string;
};

export function isConsumedResumeState(value: unknown): value is ConsumedResumeState {
	return (
		value !== null &&
		typeof value === "object" &&
		(value as { type?: unknown }).type === CONSUMED_RESUME_STATE_TYPE
	);
}

export function defaultStateDir(env) {
	return (
		(env?.LOBSTER_STATE_DIR && String(env.LOBSTER_STATE_DIR).trim()) ||
		path.join(os.homedir(), ".lobster", "state")
	);
}

export function keyToPath(stateDir, key) {
	const safe = String(key)
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!safe) throw new Error("state key is empty/invalid");
	return path.join(stateDir, `${safe}.json`);
}

export function stableStringify(value) {
	return JSON.stringify(value, (_k, v) => {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			return Object.fromEntries(
				Object.keys(v)
					.sort()
					.map((k) => [k, v[k]]),
			);
		}
		return v;
	});
}

type AtomicWriteOptions = {
	renameFile?: typeof fsp.rename;
	syncParentDir?: (filePath: string) => Promise<void>;
	signal?: AbortSignal;
};

type AtomicExclusiveWriteOptions = {
	linkFile?: typeof fsp.link;
	syncParentDir?: (filePath: string) => Promise<void>;
};

const STATE_LOCK_RETRY_MS = 10;
const STATE_LOCK_ORPHAN_MS = 30_000;
const STATE_LOCK_HEARTBEAT_MS = 250;

function isDirectorySyncUnsupportedError(err: any): boolean {
	return [
		"EACCES",
		"EBADF",
		"EINVAL",
		"EISDIR",
		"ENOSYS",
		"ENOTSUP",
		"EOPNOTSUPP",
		"EPERM",
	].includes(err?.code);
}

async function syncParentDir(filePath: string) {
	await syncDirectory(path.dirname(filePath));
}

async function syncDirectory(dir: string) {
	let handle;
	try {
		handle = await fsp.open(dir, "r");
	} catch (err) {
		if (isDirectorySyncUnsupportedError(err)) return;
		throw err;
	}

	try {
		await handle.sync();
	} catch (err) {
		if (!isDirectorySyncUnsupportedError(err)) throw err;
	} finally {
		if (handle) await handle.close().catch(() => {});
	}
}

async function syncCreatedDirectoryChain(firstCreated: string, finalDir: string) {
	const final = path.resolve(finalDir);
	let current = path.resolve(firstCreated);

	await syncDirectory(path.dirname(current));
	while (current !== final) {
		await syncDirectory(current);
		const relative = path.relative(current, final);
		const next = relative.split(path.sep)[0];
		if (!next || next === "..") break;
		current = path.join(current, next);
	}
}

export async function ensureDirectory(dir: string) {
	const created = await fsp.mkdir(dir, { recursive: true });
	if (created) await syncCreatedDirectoryChain(created, dir);
}

export function isJsonSyntaxError(err) {
	return err instanceof SyntaxError;
}

async function waitForStateLock(signal?: AbortSignal) {
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			try {
				signal?.throwIfAborted();
			} catch (err) {
				reject(err);
			}
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, STATE_LOCK_RETRY_MS);
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isProcessAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code !== "ESRCH";
	}
}

type StateLockOwner = {
	pid: number;
	processStartIdentity: string | null;
	nonce: string;
};

function parseStateLockOwner(ownerText: string): StateLockOwner | null {
	const parts = ownerText.trim().split(":");
	if (parts.length !== 3) return null;
	const pid = Number(parts[0]);
	const processStartIdentity = parts[1] || null;
	const nonce = parts[2];
	if (!Number.isInteger(pid) || pid <= 0 || !nonce) return null;
	return { pid, processStartIdentity, nonce };
}

async function readProcessStartIdentity(pid: number): Promise<string | null> {
	if (process.platform !== "linux") return null;
	try {
		const stat = await fsp.readFile(`/proc/${pid}/stat`, "utf8");
		const closeParen = stat.lastIndexOf(")");
		if (closeParen < 0) return null;
		// The remainder starts at procfs field 3; starttime is field 22.
		const fields = stat
			.slice(closeParen + 1)
			.trim()
			.split(/\s+/);
		return fields[19] || null;
	} catch {
		return null;
	}
}

async function isStateLockOld(lockPath: string) {
	try {
		const stat = await fsp.stat(lockPath);
		return Date.now() - stat.mtimeMs >= STATE_LOCK_ORPHAN_MS;
	} catch (err: any) {
		if (err?.code === "ENOENT") return true;
		throw err;
	}
}

async function hasExpiredStateLockLease(lockPath: string) {
	let first;
	try {
		first = await fsp.stat(lockPath);
	} catch (err: any) {
		if (err?.code === "ENOENT") return true;
		throw err;
	}
	if (Date.now() - first.mtimeMs < STATE_LOCK_ORPHAN_MS) return false;

	await new Promise<void>((resolve) => setTimeout(resolve, STATE_LOCK_HEARTBEAT_MS));
	try {
		const second = await fsp.stat(lockPath);
		return second.mtimeMs === first.mtimeMs && Date.now() - second.mtimeMs >= STATE_LOCK_ORPHAN_MS;
	} catch (err: any) {
		if (err?.code === "ENOENT") return true;
		throw err;
	}
}

async function reclaimOrphanedStateLock(lockPath: string) {
	let stale = false;
	try {
		const ownerPath = path.join(lockPath, "owner");
		const ownerText = (await fsp.readFile(ownerPath, "utf8")).trim();
		const owner = parseStateLockOwner(ownerText);
		if (owner && isProcessAlive(owner.pid)) {
			const processStartIdentity = await readProcessStartIdentity(owner.pid);
			if (owner.processStartIdentity && processStartIdentity) {
				stale = owner.processStartIdentity !== processStartIdentity;
			} else {
				// A live PID without a matching process-instance identity may have
				// been reused. Require a conservative expired lease and a second
				// unchanged observation before reclaiming it.
				stale = await hasExpiredStateLockLease(ownerPath);
			}
		} else if (owner) {
			stale = true;
		} else {
			stale = await isStateLockOld(lockPath);
		}
	} catch (err: any) {
		if (err?.code === "ENOENT") {
			stale = await isStateLockOld(lockPath);
		} else {
			throw err;
		}
	}
	if (!stale) return false;

	const orphanPath = `${lockPath}.${randomBytes(6).toString("hex")}.orphan`;
	try {
		await fsp.rename(lockPath, orphanPath);
	} catch (err: any) {
		if (err?.code === "ENOENT") return true;
		throw err;
	}
	await fsp.rm(orphanPath, { recursive: true, force: true });
	return true;
}

async function stillOwnsStateLock(ownerPath: string, owner: string) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return (await fsp.readFile(ownerPath, "utf8")) === owner;
		} catch (err: any) {
			if (err?.code === "ENOENT" || attempt === 1) return false;
			await new Promise<void>((resolve) => setTimeout(resolve, STATE_LOCK_RETRY_MS));
		}
	}
	return false;
}

async function withStateKeyLock<T>({
	env,
	key,
	signal,
	task,
}: {
	env: Record<string, string | undefined>;
	key: string;
	signal?: AbortSignal;
	task: () => Promise<T>;
}): Promise<T> {
	const stateDir = defaultStateDir(env);
	await ensureDirectory(stateDir);
	const lockPath = `${keyToPath(stateDir, key)}.lock`;
	let acquired = false;
	let owner: string | undefined;
	let ownerWritten = false;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	try {
		while (!acquired) {
			signal?.throwIfAborted();
			try {
				await fsp.mkdir(lockPath, { mode: 0o700 });
				acquired = true;
				const processStartIdentity = await readProcessStartIdentity(process.pid);
				owner = `${process.pid}:${processStartIdentity ?? ""}:${randomBytes(6).toString("hex")}\n`;
				await fsp.writeFile(path.join(lockPath, "owner"), owner, {
					encoding: "utf8",
					mode: 0o600,
				});
				ownerWritten = true;
				const ownerPath = path.join(lockPath, "owner");
				heartbeat = setInterval(() => {
					void fsp.utimes(ownerPath, new Date(), new Date()).catch(() => {});
				}, STATE_LOCK_HEARTBEAT_MS);
				heartbeat.unref?.();
			} catch (err: any) {
				if (acquired) throw err;
				if (err?.code !== "EEXIST") throw err;
				if (!(await reclaimOrphanedStateLock(lockPath))) {
					await waitForStateLock(signal);
				}
			}
		}
		return await task();
	} finally {
		if (heartbeat) clearInterval(heartbeat);
		if (acquired) {
			const ownerPath = path.join(lockPath, "owner");
			if (!ownerWritten || !owner || (await stillOwnsStateLock(ownerPath, owner))) {
				await fsp.rm(lockPath, { recursive: true, force: true }).catch(() => {});
			}
		}
	}
}

function isLinkUnsupportedError(err: any): boolean {
	return ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(err?.code);
}

export function isAtomicExclusiveUnsupportedError(err: any): boolean {
	return err?.code === "ENOTSUP" && err?.cause && isLinkUnsupportedError(err.cause);
}

function isOptionalApprovalIndexPersistenceError(err: any): boolean {
	return (
		isAtomicExclusiveUnsupportedError(err) ||
		["EACCES", "EDQUOT", "EIO", "ENOSPC", "EPERM", "EROFS"].includes(err?.code)
	);
}

/**
 * Write a file atomically: stage to a sibling temp file, fsync, then rename
 * over the target. `rename(2)` is atomic on a single filesystem, so a reader
 * (or a crash) never observes a truncated/partial file — it sees either the
 * complete old content or the complete new content. Plain `fsp.writeFile`
 * truncates the target up front, leaving a corruption window on SIGKILL/OOM/
 * power loss. New state files are private by default; existing file modes are
 * preserved across replacement. The temp file is removed on any failed path.
 */
export async function writeFileAtomic(filePath, data, options: AtomicWriteOptions = {}) {
	const renameFile = options.renameFile ?? fsp.rename;
	const syncDir = options.syncParentDir ?? syncParentDir;
	const dir = path.dirname(filePath);
	const tmpPath = path.join(
		dir,
		`.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
	);
	let mode = 0o600;
	let handle;
	let cleanup = true;
	try {
		try {
			mode = (await fsp.stat(filePath)).mode & 0o777;
		} catch (err) {
			if (err?.code !== "ENOENT") throw err;
		}
		handle = await fsp.open(tmpPath, "wx", mode);
		await handle.writeFile(data, "utf8");
		await handle.chmod(mode);
		await handle.sync();
		await handle.close();
		handle = undefined;
		options.signal?.throwIfAborted();
		await renameFile(tmpPath, filePath);
		options.signal?.throwIfAborted();
		await syncDir(filePath);
		cleanup = false;
	} finally {
		if (handle) await handle.close().catch(() => {});
		if (cleanup) await fsp.rm(tmpPath, { force: true }).catch(() => {});
	}
}

export async function writeFileAtomicExclusive(
	filePath,
	data,
	options: AtomicExclusiveWriteOptions = {},
) {
	const linkFile = options.linkFile ?? fsp.link;
	const syncDir = options.syncParentDir ?? syncParentDir;
	const dir = path.dirname(filePath);
	const tmpPath = path.join(
		dir,
		`.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`,
	);
	let handle;
	try {
		handle = await fsp.open(tmpPath, "wx", 0o600);
		await handle.writeFile(data, "utf8");
		await handle.chmod(0o600);
		await handle.sync();
		await handle.close();
		handle = undefined;
		try {
			await linkFile(tmpPath, filePath);
		} catch (err) {
			if (!isLinkUnsupportedError(err)) throw err;
			const unsupported = new Error(
				"Atomic exclusive file creation requires hard-link support on this filesystem",
			);
			(unsupported as NodeJS.ErrnoException).code = "ENOTSUP";
			(unsupported as Error).cause = err;
			throw unsupported;
		}
		try {
			await fsp.unlink(tmpPath);
			await syncDir(filePath);
		} catch (err) {
			await fsp.unlink(filePath).catch(() => {});
			await syncDir(filePath).catch(() => {});
			throw err;
		}
	} finally {
		if (handle) await handle.close().catch(() => {});
		await fsp.rm(tmpPath, { force: true }).catch(() => {});
	}
}

export async function readStateJson({ env, key }) {
	const stateDir = defaultStateDir(env);
	const filePath = keyToPath(stateDir, key);

	try {
		const text = await fsp.readFile(filePath, "utf8");
		return JSON.parse(text);
	} catch (err) {
		if (err?.code === "ENOENT") return null;
		throw err;
	}
}

async function writeStateJsonUnlocked({
	env,
	key,
	value,
	signal = undefined,
	atomicWriteOptions = undefined,
}: {
	env: Record<string, string | undefined>;
	key: string;
	value: unknown;
	signal?: AbortSignal;
	atomicWriteOptions?: Omit<AtomicWriteOptions, "signal">;
}) {
	const stateDir = defaultStateDir(env);
	const filePath = keyToPath(stateDir, key);

	await ensureDirectory(stateDir);
	await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + "\n", {
		...atomicWriteOptions,
		signal,
	});
}

export async function writeStateJson({
	env,
	key,
	value,
	signal = undefined,
	atomicWriteOptions = undefined,
}: {
	env: Record<string, string | undefined>;
	key: string;
	value: unknown;
	signal?: AbortSignal;
	atomicWriteOptions?: Omit<AtomicWriteOptions, "signal">;
}) {
	return withStateKeyLock({
		env,
		key,
		signal,
		task: () => writeStateJsonUnlocked({ env, key, value, signal, atomicWriteOptions }),
	});
}

/**
 * Retire a resume capability before its first unsafe execution boundary. The
 * replacement is deliberately persistent: a failed later unlink must not make
 * the original token replayable.
 */
export async function consumeResumeState({
	env,
	key,
	signal = undefined,
}: {
	env: Record<string, string | undefined>;
	key: string;
	signal?: AbortSignal;
}) {
	await writeStateJson({
		env,
		key,
		value: { type: CONSUMED_RESUME_STATE_TYPE, consumedAt: new Date().toISOString() },
		signal,
	});
}

/**
 * Check physical state presence without parsing it. Cancellation uses this to
 * retain the authoritative workflow spelling even if the state file is corrupt.
 */
export async function stateJsonExists({
	env,
	key,
}: {
	env: Record<string, string | undefined>;
	key: string;
}) {
	const filePath = keyToPath(defaultStateDir(env), key);
	try {
		await fsp.access(filePath);
		return true;
	} catch (err: any) {
		if (err?.code === "ENOENT") return false;
		throw err;
	}
}

async function deleteStateJsonUnlocked({ env, key }) {
	const stateDir = defaultStateDir(env);
	const filePath = keyToPath(stateDir, key);
	try {
		await fsp.unlink(filePath);
	} catch (err) {
		if (err?.code === "ENOENT") return;
		throw err;
	}
}

export async function deleteStateJson({
	env,
	key,
	signal = undefined,
}: {
	env: Record<string, string | undefined>;
	key: string;
	signal?: AbortSignal;
}) {
	return withStateKeyLock({
		env,
		key,
		signal,
		task: () => deleteStateJsonUnlocked({ env, key }),
	});
}

function sanitizeApprovalId(approvalId: string): string {
	return approvalId.replace(/[^a-f0-9]/g, "");
}

/**
 * Generate a short, human-friendly approval ID (8 hex chars).
 * These are easy to copy/paste in chat interfaces where full
 * base64url resume tokens are unwieldy.
 */
export function generateApprovalId(): string {
	return randomBytes(4).toString("hex");
}

/**
 * Write a reverse-index file that maps approvalId → stateKey.
 * Call this after writeStateJson to enable short-ID resume.
 */
export async function writeApprovalIndex({
	env,
	stateKey,
	approvalId,
	options,
}: {
	env: Record<string, string | undefined>;
	stateKey: string;
	approvalId: string;
	options?: AtomicExclusiveWriteOptions;
}) {
	const stateDir = defaultStateDir(env);
	const safe = sanitizeApprovalId(approvalId);
	if (!safe) return;
	await ensureDirectory(stateDir);
	const indexPath = path.join(stateDir, `approval_${safe}.json`);
	await writeFileAtomicExclusive(
		indexPath,
		JSON.stringify({ stateKey, createdAt: new Date().toISOString() }) + "\n",
		options,
	);
}

/**
 * Create a unique approval ID index without ever overwriting an existing mapping.
 */
export async function createApprovalIndex({
	env,
	stateKey,
	options,
}: {
	env: Record<string, string | undefined>;
	stateKey: string;
	options?: AtomicExclusiveWriteOptions;
}): Promise<string | null> {
	for (let attempt = 0; attempt < 16; attempt++) {
		const approvalId = generateApprovalId();
		try {
			await writeApprovalIndex({ env, stateKey, approvalId, options });
			return approvalId;
		} catch (err: any) {
			if (err?.code === "EEXIST") continue;
			if (isOptionalApprovalIndexPersistenceError(err)) return null;
			throw err;
		}
	}
	throw new Error("Could not allocate a unique approval ID");
}

/**
 * Look up a state key by short approval ID.
 * Returns the stateKey string or null if not found.
 */
export async function findStateKeyByApprovalId({
	env,
	approvalId,
}: {
	env: Record<string, string | undefined>;
	approvalId: string;
}): Promise<string | null> {
	const stateDir = defaultStateDir(env);
	const safe = sanitizeApprovalId(approvalId);
	if (!safe) return null;
	const indexPath = path.join(stateDir, `approval_${safe}.json`);
	try {
		const text = await fsp.readFile(indexPath, "utf8");
		const data = JSON.parse(text);
		return typeof data?.stateKey === "string" ? data.stateKey : null;
	} catch (err: any) {
		if (err?.code === "ENOENT") return null;
		if (isJsonSyntaxError(err)) return null;
		throw err;
	}
}

/**
 * Delete the approval ID index file (cleanup after resume or cancel).
 */
export async function deleteApprovalId({
	env,
	approvalId,
}: {
	env: Record<string, string | undefined>;
	approvalId: string;
}) {
	const stateDir = defaultStateDir(env);
	const safe = sanitizeApprovalId(approvalId);
	if (!safe) return;
	const indexPath = path.join(stateDir, `approval_${safe}.json`);
	try {
		await fsp.unlink(indexPath);
	} catch (err: any) {
		if (err?.code === "ENOENT") return;
		throw err;
	}
}

/**
 * Clean up any approval index file that points to the given stateKey.
 * Used when resuming via --token (where we don't know the approvalId).
 * Scans index files in the state dir — O(n) but n is tiny in practice.
 */
export async function cleanupApprovalIndexByStateKey({
	env,
	stateKey,
}: {
	env: Record<string, string | undefined>;
	stateKey: string;
}) {
	const stateDir = defaultStateDir(env);
	let files: string[];
	try {
		files = await fsp.readdir(stateDir);
	} catch (err: any) {
		if (err?.code === "ENOENT") return;
		throw err;
	}
	for (const file of files) {
		if (!file.startsWith("approval_") || !file.endsWith(".json")) continue;
		try {
			const text = await fsp.readFile(path.join(stateDir, file), "utf8");
			const data = JSON.parse(text);
			if (data?.stateKey === stateKey) {
				await fsp.unlink(path.join(stateDir, file)).catch(() => {});
				return; // one index per stateKey
			}
		} catch {
			/* skip corrupt files */
		}
	}
}

export async function diffAndStore({
	env,
	key,
	value,
	signal = undefined,
	atomicWriteOptions = undefined,
}: {
	env: Record<string, string | undefined>;
	key: string;
	value: unknown;
	signal?: AbortSignal;
	atomicWriteOptions?: Omit<AtomicWriteOptions, "signal">;
}) {
	return withStateKeyLock({
		env,
		key,
		signal,
		task: async () => {
			const filePath = keyToPath(defaultStateDir(env), key);
			let beforeExists = true;
			try {
				await fsp.access(filePath);
			} catch (err: any) {
				if (err?.code !== "ENOENT") throw err;
				beforeExists = false;
			}
			const before = await readStateJson({ env, key }).catch((err) => {
				if (isJsonSyntaxError(err)) return null;
				throw err;
			});
			const changed = stableStringify(before) !== stableStringify(value);
			try {
				signal?.throwIfAborted();
				await writeStateJsonUnlocked({ env, key, value, signal, atomicWriteOptions });
				signal?.throwIfAborted();
			} catch (err) {
				if (signal?.aborted) {
					if (!beforeExists) {
						await deleteStateJsonUnlocked({ env, key });
					} else {
						await writeStateJsonUnlocked({ env, key, value: before });
					}
				}
				throw err;
			}
			return { before, after: value, changed };
		},
	});
}
