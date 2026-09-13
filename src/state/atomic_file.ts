import path from "node:path";
import { promises as fsp } from "node:fs";
import { randomBytes } from "node:crypto";

export type AtomicWriteOptions = {
	renameFile?: typeof fsp.rename;
	syncParentDir?: (filePath: string) => Promise<void>;
	signal?: AbortSignal;
};

export type AtomicExclusiveWriteOptions = {
	linkFile?: typeof fsp.link;
	syncParentDir?: (filePath: string) => Promise<void>;
};

type PublishedAtomicWriteError = NodeJS.ErrnoException & {
	atomicWritePublished?: true;
};

function markAtomicWritePublished(err: unknown) {
	if (err && (typeof err === "object" || typeof err === "function")) {
		Object.defineProperty(err, "atomicWritePublished", {
			value: true,
			configurable: true,
		});
	}
	return err;
}

export function atomicWriteWasPublished(err: unknown): err is PublishedAtomicWriteError {
	return Boolean((err as PublishedAtomicWriteError | undefined)?.atomicWritePublished);
}

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

/**
 * On Windows, `fs.mkdir(..., { recursive: true })` reports the first created
 * directory as an extended-length path (`\\?\C:\...`). `path.resolve` keeps
 * that prefix, so such a path never compares equal to the plain drive path we
 * walk toward and `path.relative` between the two yields an absolute path.
 * Map the namespaces that have a plain equivalent back to it so both ends of the
 * chain share one root form. The UNC marker is matched without regard to case,
 * because Windows accepts a lowercase "unc" namespace component just as well.
 *
 * Device namespaces with no drive-letter or UNC equivalent, such as
 * `\\?\Volume{GUID}\...`, are returned unchanged: stripping their prefix would
 * leave a relative path and break an explicitly configured state directory.
 */
export function stripExtendedLengthPrefix(target: string) {
	if (!target.startsWith("\\\\?\\")) return target;
	const rest = target.slice(4);
	if (/^UNC\\/i.test(rest)) return `\\\\${rest.slice(4)}`;
	if (/^[A-Za-z]:[\\/]/.test(rest)) return rest;
	return target;
}

async function syncCreatedDirectoryChain(firstCreated: string, finalDir: string) {
	const final = path.resolve(stripExtendedLengthPrefix(finalDir));
	let current = path.resolve(stripExtendedLengthPrefix(firstCreated));

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

function isLinkUnsupportedError(err: any): boolean {
	return ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(err?.code);
}

export function isAtomicExclusiveUnsupportedError(err: any): boolean {
	return err?.code === "ENOTSUP" && err?.cause && isLinkUnsupportedError(err.cause);
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
		cleanup = false;
		// The rename is the irreversible publication point. Keep propagating a
		// directory-sync failure, but mark it so a state transition can reconcile
		// the visible replacement before deciding whether dispatch is safe.
		try {
			await syncDir(filePath);
		} catch (err) {
			throw markAtomicWritePublished(err);
		}
		return { signalAbortedAfterCommit: options.signal?.aborted === true };
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
