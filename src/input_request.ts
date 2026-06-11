import { stableStringify } from "./state/store.js";
import { compileCached } from "./validation.js";

export type RequestInputParams = {
  prompt: string;
  responseSchema: unknown;
  defaults?: unknown;
  subject?: unknown;
  suspendedState?: unknown;
};

export type RequestInputMetadata = {
  prompt: string;
  responseSchema: unknown;
  defaults?: unknown;
  subject?: unknown;
  signature: string;
};

export type CommandInputHistoryEntry = {
  requestIndex: number;
  metadata: RequestInputMetadata;
  suspendedState?: unknown;
  response: unknown;
};

export type CommandInputPendingRequest = {
  requestIndex: number;
  metadata: RequestInputMetadata;
  suspendedState?: unknown;
};

export type CommandInputState = {
  pending: CommandInputPendingRequest;
  history: CommandInputHistoryEntry[];
};

export type CommandInputResume = {
  state: CommandInputState;
  response: unknown;
  consumed?: boolean;
  onConsumed?: () => void | Promise<void>;
};

export type PipelineCommandInputRequest = {
  type: "input_request";
  prompt: string;
  responseSchema: unknown;
  defaults?: unknown;
  subject?: unknown;
  items: unknown[];
  commandInput: CommandInputState;
};

const MAX_REPLAY_ITEMS = 1000;
const MAX_REPLAY_BYTES = 1024 * 1024;
const MAX_REQUEST_HISTORY = 100;

export class InputRequestSuspension extends Error {
  stageIndex: number;
  request: PipelineCommandInputRequest;

  constructor(stageIndex: number, request: PipelineCommandInputRequest) {
    super("Input request suspended");
    this.name = "InputRequestSuspension";
    this.stageIndex = stageIndex;
    this.request = request;
  }
}

export class RequestInputResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestInputResumeError";
  }
}

export function createInputTracker(input: AsyncIterable<unknown> | Iterable<unknown>) {
  const knownItems = Array.isArray(input) ? input : null;
  let iterator: AsyncIterator<unknown> | null = null;
  let completed = false;
  let closed = false;
  let replayEnabled = true;
  let replaySnapshotItems: unknown[] = [];
  let replaySnapshotIndex = 0;
  let replaySnapshotError: Error | null = null;
  let replaySnapshotBytes = 0;

  const iterable = {
    async *[Symbol.asyncIterator]() {
      const iter = getIterator();
      let hasPrimaryError = false;
      let yieldedIndex = 0;
      try {
        while (true) {
          const next = await iter.next();
          if (next.done) {
            completed = true;
            return;
          }
          if (knownItems) {
            snapshotKnownItemsThrough(yieldedIndex);
            yieldedIndex += 1;
          }
          yield next.value;
        }
      } catch (err) {
        hasPrimaryError = true;
        throw err;
      } finally {
        await closeTrackedIterator({ suppressErrors: hasPrimaryError });
      }
    },
  };

  return {
    iterable,
    getReplayItems(hasSuspendedState: boolean) {
      if (!replayEnabled) {
        throw new Error("requestInput replay is no longer available after command output");
      }
      if (!knownItems) {
        if (hasSuspendedState) return [];
        throw new Error("requestInput requires suspendedState when command input is streaming");
      }
      snapshotKnownItemsThrough(knownItems.length - 1);
      if (replaySnapshotError) throw replaySnapshotError;
      return snapshotArray(replaySnapshotItems, "requestInput replay input");
    },
    disableReplay() {
      replayEnabled = false;
    },
    async close(options: { suppressErrors?: boolean } = {}) {
      await closeTrackedIterator({ suppressErrors: options.suppressErrors === true });
    },
  };

  function getIterator() {
    iterator ??= toAsyncIterator(input);
    return iterator;
  }

  async function closeTrackedIterator({ suppressErrors }: { suppressErrors: boolean }) {
    if (!iterator || completed || closed) return;
    closed = true;
    await closeIterator(iterator, { suppressErrors });
  }

  function snapshotKnownItemsThrough(index: number) {
    if (!knownItems || replaySnapshotError) return;
    while (replaySnapshotIndex <= index && replaySnapshotIndex < knownItems.length) {
      try {
        const snapshot = snapshotJson(knownItems[replaySnapshotIndex], "requestInput replay input");
        replaySnapshotBytes += Buffer.byteLength(JSON.stringify(snapshot), "utf8");
        if (
          replaySnapshotItems.length + 1 > MAX_REPLAY_ITEMS ||
          replaySnapshotBytes > MAX_REPLAY_BYTES
        ) {
          throw new Error("requestInput replay limit exceeded");
        }
        replaySnapshotItems.push(snapshot);
        replaySnapshotIndex += 1;
      } catch (err) {
        replaySnapshotError = err instanceof Error ? err : new Error(String(err));
        return;
      }
    }
  }
}

export function createStageRequestInput({
  ctx,
  stageIndex,
  mode,
  inputTracker,
  isCommandActive,
  getInactiveReason,
  isOutputStarted,
  resume,
}: {
  ctx: any;
  stageIndex: number;
  mode: string;
  inputTracker: ReturnType<typeof createInputTracker>;
  isCommandActive: () => boolean;
  getInactiveReason?: () => string | undefined;
  isOutputStarted: () => boolean;
  resume?: CommandInputResume;
}) {
  let requestIndex = 0;
  const history: CommandInputHistoryEntry[] = [...(resume?.state.history ?? [])];

  const requestInput = async function requestInput(params: RequestInputParams) {
    if (!isCommandActive()) {
      throw new Error(
        getInactiveReason?.() ?? "requestInput cannot run after the command has completed",
      );
    }

    const metadata = snapshotRequestMetadata(params);
    const requestedSuspendedState =
      params.suspendedState === undefined
        ? undefined
        : snapshotJson(params.suspendedState, "requestInput suspendedState");
    const historical = history[requestIndex];
    if (historical) {
      assertMetadataMatches(historical.requestIndex, historical.metadata, requestIndex, metadata);
      assertSuspendedStateMatches(historical.suspendedState, requestedSuspendedState);
      const response = snapshotJson(historical.response, "requestInput response");
      validateRequestInputResponse(metadata.responseSchema, response, "requestInput");
      requestIndex += 1;
      return response;
    }

    if (resume && !resume.consumed) {
      assertMetadataMatches(
        resume.state.pending.requestIndex,
        resume.state.pending.metadata,
        requestIndex,
        metadata,
      );
      assertSuspendedStateMatches(resume.state.pending.suspendedState, requestedSuspendedState);
      const response = snapshotJson(resume.response, "requestInput response");
      validateRequestInputResponse(metadata.responseSchema, response, "requestInput");
      const historyResponse = snapshotJson(response, "requestInput response");
      await resume.onConsumed?.();
      resume.consumed = true;
      history.push({
        requestIndex,
        metadata,
        ...(requestedSuspendedState !== undefined
          ? { suspendedState: requestedSuspendedState }
          : null),
        response: historyResponse,
      });
      requestIndex += 1;
      return response;
    }

    if (mode === "human" && isInteractive(ctx.stdin)) {
      return requestInputInteractively(ctx, metadata);
    }

    if (isOutputStarted()) {
      throw new Error("requestInput cannot suspend after this command has produced output");
    }
    if (history.length >= MAX_REQUEST_HISTORY) {
      throw new Error("requestInput replay history limit exceeded");
    }

    const items = inputTracker.getReplayItems(requestedSuspendedState !== undefined);
    const pending: CommandInputPendingRequest = {
      requestIndex,
      metadata,
      ...(requestedSuspendedState !== undefined
        ? { suspendedState: requestedSuspendedState }
        : null),
    };
    throw new InputRequestSuspension(stageIndex, {
      type: "input_request",
      prompt: metadata.prompt,
      responseSchema: metadata.responseSchema,
      ...(metadata.defaults !== undefined ? { defaults: metadata.defaults } : null),
      ...(metadata.subject !== undefined ? { subject: metadata.subject } : null),
      items,
      commandInput: {
        pending,
        history,
      },
    });
  };
  requestInput.getSuspendedState = function getSuspendedState() {
    if (requestIndex < history.length) {
      return snapshotOptionalState(history[requestIndex].suspendedState);
    }
    if (resume && !resume.consumed && resume.state.pending.requestIndex === requestIndex) {
      return snapshotOptionalState(resume.state.pending.suspendedState);
    }
    return undefined;
  };
  return requestInput;
}

export function assertRequestInputResumeConsumed(resume?: CommandInputResume) {
  if (resume && !resume.consumed) {
    throw new RequestInputResumeError("resume input response was not consumed by requestInput");
  }
}

export function snapshotRequestMetadata(params: RequestInputParams): RequestInputMetadata {
  validateRequestInputParams(params);
  const responseSchema = snapshotJson(params.responseSchema, "requestInput responseSchema");
  const defaults =
    params.defaults === undefined
      ? undefined
      : snapshotJson(params.defaults, "requestInput defaults");
  const subject =
    params.subject === undefined ? undefined : snapshotJson(params.subject, "requestInput subject");
  const unsigned = {
    prompt: params.prompt,
    responseSchema,
    ...(defaults !== undefined ? { defaults } : null),
    ...(subject !== undefined ? { subject } : null),
  };
  return {
    ...unsigned,
    signature: stableStringify(unsigned),
  };
}

export function validateCommandInputState(value: unknown): CommandInputState {
  if (!value || typeof value !== "object") throw new Error("Invalid pipeline resume state");
  const data = value as Partial<CommandInputState>;
  validatePending(data.pending);
  if (!Array.isArray(data.history)) throw new Error("Invalid pipeline resume state");
  if (data.history.length !== data.pending.requestIndex) {
    throw new Error("Invalid pipeline resume state");
  }
  data.history.forEach(validateHistoryEntry);
  return data as CommandInputState;
}

export function validateRequestInputResponse(schema: unknown, response: unknown, label: string) {
  let validator;
  try {
    validator = compileCached(schema as any);
  } catch {
    throw new Error(`${label} response schema is invalid`);
  }
  if (validator(response)) return;
  const first = validator.errors?.[0];
  const pathValue = first?.instancePath || "/";
  const reason = first?.message ? ` ${first.message}` : "";
  throw new Error(`${label} response failed schema validation at ${pathValue}:${reason}`);
}

function validateRequestInputParams(params: RequestInputParams) {
  if (!params || typeof params !== "object") {
    throw new Error("requestInput params must be an object");
  }
  if (typeof params.prompt !== "string" || params.prompt.length === 0) {
    throw new Error("requestInput prompt is required");
  }
  if (params.responseSchema === undefined) {
    throw new Error("requestInput responseSchema is required");
  }
  try {
    compileCached(params.responseSchema as any);
  } catch {
    throw new Error("requestInput response schema is invalid");
  }
}

function validatePending(value: unknown): asserts value is CommandInputPendingRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid pipeline resume state");
  const data = value as Partial<CommandInputPendingRequest>;
  if (
    typeof data.requestIndex !== "number" ||
    !Number.isInteger(data.requestIndex) ||
    data.requestIndex < 0
  ) {
    throw new Error("Invalid pipeline resume state");
  }
  validateStoredMetadata(data.metadata);
  if (data.suspendedState !== undefined) {
    snapshotJson(data.suspendedState, "requestInput suspendedState");
  }
}

function validateHistoryEntry(value: unknown, index: number) {
  if (!value || typeof value !== "object") throw new Error("Invalid pipeline resume state");
  const data = value as Partial<CommandInputHistoryEntry>;
  if (data.requestIndex !== index) throw new Error("Invalid pipeline resume state");
  validateStoredMetadata(data.metadata);
  if (data.suspendedState !== undefined) {
    snapshotJson(data.suspendedState, "requestInput suspendedState");
  }
  if (data.response === undefined) throw new Error("Invalid pipeline resume state");
  snapshotJson(data.response, "requestInput response");
}

function validateStoredMetadata(value: unknown): asserts value is RequestInputMetadata {
  if (!value || typeof value !== "object") throw new Error("Invalid pipeline resume state");
  const data = value as Partial<RequestInputMetadata>;
  if (typeof data.prompt !== "string" || data.prompt.length === 0) {
    throw new Error("Invalid pipeline resume state");
  }
  if (typeof data.signature !== "string" || data.signature.length === 0) {
    throw new Error("Invalid pipeline resume state");
  }
  if (data.responseSchema === undefined) throw new Error("Invalid pipeline resume state");
  const actual = snapshotRequestMetadata({
    prompt: data.prompt,
    responseSchema: data.responseSchema,
    ...(data.defaults !== undefined ? { defaults: data.defaults } : null),
    ...(data.subject !== undefined ? { subject: data.subject } : null),
  });
  if (actual.signature !== data.signature) throw new Error("Invalid pipeline resume state");
}

function assertMetadataMatches(
  storedIndex: number,
  stored: RequestInputMetadata,
  actualIndex: number,
  actual: RequestInputMetadata,
) {
  if (
    storedIndex !== actualIndex ||
    stored.prompt !== actual.prompt ||
    stored.signature !== actual.signature
  ) {
    throw new RequestInputResumeError(
      "requestInput resume request does not match suspended request",
    );
  }
}

function assertSuspendedStateMatches(stored: unknown, actual: unknown) {
  if (stableStringify(stored) !== stableStringify(actual)) {
    throw new RequestInputResumeError("requestInput resume state does not match suspended request");
  }
}

function snapshotOptionalState(state: unknown) {
  return state === undefined ? undefined : snapshotJson(state, "requestInput suspendedState");
}

function snapshotArray(items: readonly unknown[], label: string) {
  if (items.length > MAX_REPLAY_ITEMS) throw new Error("requestInput replay item limit exceeded");
  let totalBytes = 0;
  return items.map((item) => {
    const snapshot = snapshotJson(item, label);
    totalBytes += Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    if (totalBytes > MAX_REPLAY_BYTES) {
      throw new Error("requestInput replay byte limit exceeded");
    }
    return snapshot;
  });
}

function snapshotJson(value: unknown, label: string): unknown {
  assertJsonSerializable(value, label, new WeakSet());
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error(`${label} must be JSON-serializable`);
  return JSON.parse(text);
}

function assertJsonSerializable(value: unknown, label: string, seen: WeakSet<object>) {
  if (value === null) return;
  const type = typeof value;
  if (type === "string" || type === "boolean") return;
  if (type === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must be JSON-serializable`);
    return;
  }
  if (type === "undefined" || type === "function" || type === "symbol" || type === "bigint") {
    throw new Error(`${label} must be JSON-serializable`);
  }
  const object = value as object;
  if (seen.has(object)) throw new Error(`${label} must be JSON-serializable`);
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new Error(`${label} must be JSON-serializable`);
  }
  seen.add(object);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) throw new Error(`${label} must be JSON-serializable`);
      assertJsonSerializable(value[index], label, seen);
    }
  } else {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      assertJsonSerializable((value as Record<string, unknown>)[key], label, seen);
    }
  }
  seen.delete(object);
}

async function requestInputInteractively(ctx: any, metadata: RequestInputMetadata) {
  ctx.stdout.write(`${metadata.prompt}\n> `);
  const { readLineFromStream } = await import("./read_line.js");
  const raw = await readLineFromStream(ctx.stdin, { timeoutMs: 0 });
  let response;
  try {
    response = JSON.parse(String(raw ?? "").trim());
  } catch {
    throw new Error("requestInput response must be valid JSON");
  }
  validateRequestInputResponse(metadata.responseSchema, response, "requestInput");
  return snapshotJson(response, "requestInput response");
}

function isInteractive(stdin: any) {
  return Boolean(stdin?.isTTY);
}

async function closeIterator(
  iterator: AsyncIterator<unknown>,
  { suppressErrors }: { suppressErrors: boolean },
) {
  if (typeof iterator.return !== "function") return;
  try {
    await iterator.return();
  } catch (err) {
    if (!suppressErrors) throw err;
    // Cleanup must not mask the original command error or suspension.
  }
}

function toAsyncIterator(input: AsyncIterable<unknown> | Iterable<unknown>) {
  if (typeof (input as any)[Symbol.asyncIterator] === "function") {
    return (input as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  }
  if (typeof (input as any)[Symbol.iterator] === "function") {
    const iterator = (input as Iterable<unknown>)[Symbol.iterator]();
    return {
      async next() {
        return iterator.next();
      },
      async return() {
        if (typeof iterator.return === "function") iterator.return();
        return { done: true, value: undefined };
      },
    };
  }
  throw new Error("input is not iterable");
}
