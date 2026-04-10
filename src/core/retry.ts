export type RetryConfig = {
  max?: number;
  backoff?: 'fixed' | 'exponential';
  delay_ms?: number;
  max_delay_ms?: number;
  jitter?: boolean;
};

const DEFAULTS = {
  max: 1,
  backoff: 'fixed' as const,
  delay_ms: 1000,
  max_delay_ms: 30000,
  jitter: false,
};

export function resolveRetryConfig(raw: RetryConfig | undefined): Required<RetryConfig> {
  if (!raw) return { ...DEFAULTS };
  return {
    max: raw.max ?? DEFAULTS.max,
    backoff: raw.backoff ?? DEFAULTS.backoff,
    delay_ms: raw.delay_ms ?? DEFAULTS.delay_ms,
    max_delay_ms: raw.max_delay_ms ?? DEFAULTS.max_delay_ms,
    jitter: raw.jitter ?? DEFAULTS.jitter,
  };
}

function computeDelay(config: Required<RetryConfig>, attempt: number): number {
  let delay: number;
  if (config.backoff === 'exponential') {
    delay = Math.min(config.delay_ms * Math.pow(2, attempt), config.max_delay_ms);
  } else {
    delay = config.delay_ms;
  }
  if (config.jitter) {
    // +/- 10% randomization, clamped to max_delay_ms
    const jitterRange = delay * 0.1;
    delay += (Math.random() * 2 - 1) * jitterRange;
    delay = Math.min(delay, config.max_delay_ms);
  }
  return Math.max(0, Math.round(delay));
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Execute `fn` with retries according to the given config.
 * Abort errors always propagate immediately (no retry).
 * Returns the result of the first successful call, or throws
 * the last error after all retries are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Required<RetryConfig>,
  options?: {
    signal?: AbortSignal;
    shouldRetry?: (error: any, attempt: number) => boolean;
    onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  },
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < config.max; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      // Never retry abort/cancellation errors
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        throw err;
      }
      lastError = err;
      if (attempt + 1 < config.max) {
        if (options?.shouldRetry && !options.shouldRetry(err, attempt + 1)) {
          throw err;
        }
        const delay = computeDelay(config, attempt);
        options?.onRetry?.(attempt + 1, err, delay);
        await abortableSleep(delay, options?.signal);
      }
    }
  }
  throw lastError;
}
