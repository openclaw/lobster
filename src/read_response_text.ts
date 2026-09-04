export const HTTP_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;

export async function readResponseTextCapped(res: Response, maxBytes: number): Promise<string> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new Error("maxBytes must be a non-negative safe integer");
	}

	const declared = parseContentLength(res.headers.get("content-length"));
	if (declared !== null && declared > maxBytes) {
		if (res.body) {
			try {
				await res.body.cancel();
			} catch {
				// The socket may already be closed; still refuse the oversized body.
			}
		}
		throw new Error(`HTTP response body exceeded ${maxBytes} bytes`);
	}

	if (!res.body) {
		return "";
	}

	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (!value || value.byteLength === 0) {
				continue;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				try {
					await reader.cancel();
				} catch {
					// Reader is already closed after cancel.
				}
				throw new Error(`HTTP response body exceeded ${maxBytes} bytes`);
			}
			chunks.push(value);
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Already released by cancel().
		}
	}

	if (total === 0) {
		return "";
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function parseContentLength(raw: string | null): number | null {
	if (raw === null || raw.trim() === "") {
		return null;
	}
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		return null;
	}
	return n;
}
