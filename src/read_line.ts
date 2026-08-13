const unreadInput = new WeakMap<NodeJS.ReadableStream, string>();
type ObservableReadableStream = NodeJS.ReadableStream & {
	readableEnded?: boolean;
	destroyed?: boolean;
	closed?: boolean;
};

export function readLineFromStream(
	stream: NodeJS.ReadableStream,
	opts?: { timeoutMs?: number; signal?: AbortSignal },
) {
	const timeoutMs = Number(opts?.timeoutMs ?? 0);
	const signal = opts?.signal;
	const observableStream = stream as ObservableReadableStream;

	return new Promise<string>((resolve, reject) => {
		let settled = false;
		let buf = unreadInput.get(stream) ?? "";
		unreadInput.delete(stream);
		let timer: NodeJS.Timeout | null = null;

		const cleanup = () => {
			stream.off("data", onData);
			stream.off("end", onEnd);
			stream.off("close", onClose);
			stream.off("error", onError);
			stream.pause();
			signal?.removeEventListener("abort", onAbort);
			if (timer) clearTimeout(timer);
		};

		const finish = (value: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};

		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			unreadInput.delete(stream);
			cleanup();
			reject(err);
		};

		const consumeLine = () => {
			const idx = buf.indexOf("\n");
			if (idx === -1) return false;
			unreadInput.set(stream, buf.slice(idx + 1));
			finish(buf.slice(0, idx));
			return true;
		};

		const onData = (chunk: Buffer | string) => {
			buf += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
			consumeLine();
		};
		const drainBuffered = () => {
			let chunk: Buffer | string | null;
			while (!settled && (chunk = stream.read()) !== null) onData(chunk);
		};

		const onEnd = () => {
			drainBuffered();
			if (settled) return;
			unreadInput.delete(stream);
			finish(buf);
		};
		const onClose = () => {
			drainBuffered();
			if (settled) return;
			unreadInput.delete(stream);
			finish(buf);
		};
		const onError = (err: Error) => fail(err);
		const onAbort = () => {
			const reason = signal?.reason;
			fail(reason instanceof Error ? reason : new Error("Input read aborted"));
		};

		if (signal?.aborted) {
			onAbort();
			return;
		}

		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				fail(new Error(`Timed out waiting for input (${timeoutMs}ms)`));
			}, timeoutMs);
		}

		stream.on("data", onData);
		stream.on("end", onEnd);
		stream.on("close", onClose);
		stream.on("error", onError);
		signal?.addEventListener("abort", onAbort, { once: true });
		drainBuffered();
		if (!settled && !consumeLine()) {
			if (observableStream.readableEnded || observableStream.destroyed || observableStream.closed)
				onEnd();
			else stream.resume();
		}
	});
}
