import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';

import { readStateJson, writeStateJson, stableStringify } from '../../state/store.js';

const ajv = new Ajv({ allErrors: true, strict: false });

const artifactSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string' },
    role: { type: 'string' },
    name: { type: 'string' },
    mimeType: { type: 'string' },
    text: { type: 'string' },
    data: {},
    uri: { type: 'string' },
  },
  additionalProperties: true,
};

const payloadSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1 },
    artifacts: { type: 'array', items: artifactSchema },
    artifactHashes: { type: 'array', items: { type: 'string', minLength: 10 } },
    schemaVersion: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'object', additionalProperties: true },
    temperature: { type: 'number' },
    maxOutputTokens: { type: 'number' },
    retryContext: {
      type: 'object',
      properties: {
        attempt: { type: 'number' },
        validationErrors: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  },
  required: ['prompt', 'model', 'artifacts', 'artifactHashes'],
  additionalProperties: false,
};

const responseSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    result: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        model: { type: 'string' },
        prompt: { type: 'string' },
        status: { type: 'string' },
        output: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            data: {},
            format: { type: 'string' },
          },
          required: [],
          additionalProperties: true,
        },
        usage: {
          type: 'object',
          properties: {
            inputTokens: { type: 'number' },
            outputTokens: { type: 'number' },
            totalTokens: { type: 'number' },
          },
          additionalProperties: true,
        },
        warnings: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object', additionalProperties: true },
        diagnostics: { type: 'object', additionalProperties: true },
      },
      required: ['output'],
      additionalProperties: true,
    },
    error: { type: 'object', additionalProperties: true },
  },
  required: ['ok'],
  additionalProperties: true,
};

const validatePayload = ajv.compile(payloadSchema);
const validateResponseEnvelope = ajv.compile(responseSchema);

const DEFAULT_MAX_VALIDATION_RETRIES = 1;

const STATE_VERSION = 1;

type LlmTaskResponseEnvelope = {
  ok: boolean;
  result?: LlmTaskResponse | null;
  error?: { message?: string } | null;
};

type LlmTaskResponse = {
  runId?: string | null;
  model?: string | null;
  prompt?: string | null;
  status?: string | null;
  output?: {
    text?: string | null;
    data?: any;
    format?: string | null;
  } | null;
  usage?: Record<string, unknown> | null;
  warnings?: string[] | null;
  metadata?: Record<string, unknown> | null;
  diagnostics?: Record<string, unknown> | null;
};

type NormalizedInvocationItem = {
  kind: 'llm_task.invoke';
  runId: string | null;
  prompt: string | null;
  model: string | null;
  schemaVersion: string | null;
  status: string;
  cacheKey: string;
  artifactHashes: string[];
  output: { format: string | null; text: string | null; data: any };
  usage: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  warnings: string[] | null;
  diagnostics: Record<string, unknown> | null;
  createdAt: string;
  source: string;
  cached: boolean;
  attemptCount: number;
};

type CacheEntry = {
  items: NormalizedInvocationItem[];
  cacheKey: string;
  storedAt: string;
};

export const llmTaskInvokeCommand = {
  name: 'llm_task.invoke',
  meta: {
    description: 'Call the llm-task /tool/invoke endpoint with typed payloads and caching',
    argsSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'llm-task base URL (or LLM_TASK_URL)' },
        token: { type: 'string', description: 'Bearer token (or LLM_TASK_TOKEN)' },
        prompt: { type: 'string', description: 'Primary prompt / instructions' },
        model: { type: 'string', description: 'Model identifier (e.g. claude-3-sonnet)' },
        'artifacts-json': { type: 'string', description: 'JSON array of artifacts to send' },
        'metadata-json': { type: 'string', description: 'JSON object of metadata to include' },
        'output-schema': { type: 'string', description: 'JSON schema LLM output must satisfy' },
        'schema-version': { type: 'string', description: 'Logical schema version for caching' },
        'max-validation-retries': { type: 'number', description: 'Retries when schema validation fails' },
        temperature: { type: 'number', description: 'Sampling temperature' },
        'max-output-tokens': { type: 'number', description: 'Max completion tokens' },
        'state-key': { type: 'string', description: 'Run-state key override (else LOBSTER_RUN_STATE_KEY)' },
        refresh: { type: 'boolean', description: 'Bypass run-state + cache' },
        'disable-cache': { type: 'boolean', description: 'Skip persistent cache' },
        _: { type: 'array', items: { type: 'string' } },
      },
      required: ['model'],
    },
    sideEffects: ['calls_llm_task'],
  },
  help() {
    return (
      `llm_task.invoke — call llm-task /tool/invoke with caching and schema validation\n\n` +
      `Usage:\n` +
      `  llm_task.invoke --model claude-3-sonnet --prompt 'Write summary'\n` +
      `  cat artifacts.json | llm_task.invoke --model claude-3-sonnet --prompt 'Score each item'\n` +
      `  ... | llm_task.invoke --model claude-3-sonnet --prompt 'Plan next steps' --output-schema '{"type":"object"}'\n\n` +
      `Features:\n` +
      `  - Typed payload validation before invoking remote tool.\n` +
      `  - Run-state + file cache so resumes do not re-call the LLM.\n` +
      `  - Optional JSON-schema enforcement with bounded retries.\n`
    );
  },
  async run({ input, args, ctx }) {
    const env = ctx.env ?? process.env;
    const baseUrl = String(args.url ?? env.LLM_TASK_URL ?? '').trim();
    if (!baseUrl) throw new Error('llm_task.invoke requires --url or LLM_TASK_URL');

    const prompt = extractPrompt(args);
    if (!prompt) throw new Error('llm_task.invoke requires --prompt or positional text');

    const model = String(args.model ?? '').trim();
    if (!model) throw new Error('llm_task.invoke requires --model');

    const schemaVersion = args['schema-version']
      ? String(args['schema-version']).trim()
      : env.LLM_TASK_SCHEMA_VERSION
        ? String(env.LLM_TASK_SCHEMA_VERSION).trim()
        : 'v1';

    const maxOutputTokens = parseOptionalNumber(args['max-output-tokens']);
    const temperature = parseOptionalNumber(args.temperature);

    const providedArtifacts = parseJsonArray(args['artifacts-json'], 'llm_task.invoke --artifacts-json');
    const metadataObject = parseJsonObject(args['metadata-json'], 'llm_task.invoke --metadata-json');
    const userOutputSchema = parseJsonObject(args['output-schema'], 'llm_task.invoke --output-schema');

    const maxValidationRetriesRaw = args['max-validation-retries'] ?? env.LLM_TASK_VALIDATION_RETRIES;
    const maxValidationRetries = userOutputSchema
      ? Math.max(0, Number.isFinite(Number(maxValidationRetriesRaw))
        ? Number(maxValidationRetriesRaw)
        : DEFAULT_MAX_VALIDATION_RETRIES)
      : 0;

    const disableCache = flag(args['disable-cache']);
    const forceRefresh = flag(args.refresh ?? env.LLM_TASK_FORCE_REFRESH);

    const stateKey = String(args['state-key'] ?? env.LOBSTER_RUN_STATE_KEY ?? '').trim() || null;

    const inputArtifacts = [] as any[];
    for await (const item of input) inputArtifacts.push(item);

    const normalizedArtifacts = [...inputArtifacts, ...providedArtifacts].map(normalizeArtifact);
    const artifactHashes = normalizedArtifacts.map(hashArtifact);

    const cacheKey = computeCacheKey({ prompt, model, schemaVersion, artifactHashes, outputSchema: userOutputSchema });

    if (stateKey && !forceRefresh) {
      const stored = await readStateJson({ env, key: stateKey }).catch(() => null);
      const reused = pickReusableState(stored, cacheKey);
      if (reused) {
        return {
          output: streamOf(reused.items.map((item) => ({ ...item, source: 'run_state', cached: true }))),
        };
      }
    }

    if (!disableCache && !forceRefresh) {
      const cache = await readCacheEntry(env, cacheKey);
      if (cache) {
        return {
          output: streamOf(cache.items.map((item: any) => ({ ...item, source: 'cache', cached: true }))),
        };
      }
    }

    const payload: Record<string, any> = {
      prompt,
      model,
      artifacts: normalizedArtifacts,
      artifactHashes,
    };

    if (metadataObject) payload.metadata = metadataObject;
    if (userOutputSchema) payload.outputSchema = userOutputSchema;
    if (schemaVersion) payload.schemaVersion = schemaVersion;
    if (Number.isFinite(maxOutputTokens ?? NaN)) payload.maxOutputTokens = Number(maxOutputTokens);
    if (Number.isFinite(temperature ?? NaN)) payload.temperature = Number(temperature);

    if (!validatePayload(payload)) {
      throw new Error(`llm_task.invoke payload invalid: ${ajv.errorsText(validatePayload.errors)}`);
    }

    const endpoint = buildEndpoint(baseUrl);
    const token = String(args.token ?? env.LLM_TASK_TOKEN ?? '').trim();

    const validator = userOutputSchema ? ajv.compile(userOutputSchema) : null;

    let attempt = 0;
    let lastError: Error | null = null;
    let lastValidationErrors: string[] = [];

    while (true) {
      attempt++;
      if (attempt > 1) {
        payload.retryContext = {
          attempt,
          ...(lastValidationErrors.length ? { validationErrors: lastValidationErrors } : null),
        };
      } else {
        delete payload.retryContext;
      }

      let responseEnvelope: LlmTaskResponseEnvelope;
      try {
        responseEnvelope = await invokeRemote({ endpoint, token, payload });
      } catch (err: any) {
        throw new Error(`llm_task.invoke request failed: ${err?.message ?? String(err)}`);
      }

      if (!validateResponseEnvelope(responseEnvelope)) {
        throw new Error('llm_task.invoke received invalid response envelope');
      }

      if (responseEnvelope.ok !== true) {
        const message = responseEnvelope.error?.message ?? 'llm-task returned an error';
        throw new Error(`llm_task.invoke remote error: ${message}`);
      }

      const normalized = normalizeResult({
        envelope: responseEnvelope,
        cacheKey,
        schemaVersion,
        artifactHashes,
        source: 'remote',
        attempt,
      });

      if (!validator) {
        await persistOutputs({ env, stateKey, cacheKey, items: normalized });
        if (!disableCache) await writeCacheEntry(env, cacheKey, normalized);
        return { output: streamOf(normalized) };
      }

      const structured = normalized[0]?.output?.data ?? null;
      if (validator(structured)) {
        await persistOutputs({ env, stateKey, cacheKey, items: normalized });
        if (!disableCache) await writeCacheEntry(env, cacheKey, normalized);
        return { output: streamOf(normalized) };
      }

      lastValidationErrors = collectAjvErrors(validator.errors);
      lastError = new Error(`llm_task.invoke output failed schema validation: ${lastValidationErrors.join('; ')}`);
      if (attempt > maxValidationRetries) {
        throw lastError;
      }
    }
  },
};

function extractPrompt(args) {
  if (args.prompt) return String(args.prompt);
  if (Array.isArray(args._) && args._.length) {
    return args._.join(' ');
  }
  return '';
}

function parseJsonArray(raw, label) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) throw new Error('must be array');
    return parsed;
  } catch {
    throw new Error(`${label} must be a JSON array`);
  }
}

function parseJsonObject(raw, label) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be an object');
    }
    return parsed;
  } catch {
    throw new Error(`${label} must be a JSON object`);
  }
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function flag(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'no'].includes(normalized)) return false;
    if (['true', '1', 'yes'].includes(normalized)) return true;
  }
  return Boolean(value);
}

function normalizeArtifact(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    return { kind: 'text', text: raw };
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return { kind: 'text', text: String(raw) };
  }
  return { kind: 'json', data: raw };
}

function hashArtifact(artifact) {
  const stable = stableStringify(artifact);
  return createHash('sha256').update(stable).digest('hex');
}

function computeCacheKey({ prompt, model, schemaVersion, artifactHashes, outputSchema }) {
  const payload = {
    prompt,
    model,
    schemaVersion,
    artifactHashes,
    outputSchema: outputSchema ?? null,
  };
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function buildEndpoint(baseUrl: string) {
  const base = new URL(baseUrl);
  const cleanBase = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
  base.pathname = `${cleanBase}/tool/invoke`.replace(/\/+/g, '/');
  return base;
}

async function invokeRemote({
  endpoint,
  token,
  payload,
}: {
  endpoint: URL;
  token: string;
  payload: Record<string, unknown>;
}): Promise<LlmTaskResponseEnvelope> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : null),
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }

  try {
    return text
      ? (JSON.parse(text) as LlmTaskResponseEnvelope)
      : ({ ok: true, result: {} as LlmTaskResponse } satisfies LlmTaskResponseEnvelope);
  } catch {
    throw new Error('Response was not JSON');
  }
}

function normalizeResult({
  envelope,
  cacheKey,
  schemaVersion,
  artifactHashes,
  source,
  attempt,
}: {
  envelope: LlmTaskResponseEnvelope;
  cacheKey: string;
  schemaVersion: string;
  artifactHashes: string[];
  source: string;
  attempt: number;
}): NormalizedInvocationItem[] {
  const result = envelope.result ?? {};
  const output = result.output ?? {};
  const item: NormalizedInvocationItem = {
    kind: 'llm_task.invoke',
    runId: result.runId ?? null,
    prompt: result.prompt ?? null,
    model: result.model ?? null,
    schemaVersion,
    status: result.status ?? 'completed',
    cacheKey,
    artifactHashes,
    output: {
      format: output.format ?? (output.data ? 'json' : 'text'),
      text: output.text ?? null,
      data: output.data ?? null,
    },
    usage: (result.usage as Record<string, unknown>) ?? null,
    metadata: (result.metadata as Record<string, unknown>) ?? null,
    warnings: (result.warnings as string[]) ?? null,
    diagnostics: (result.diagnostics as Record<string, unknown>) ?? null,
    createdAt: new Date().toISOString(),
    source,
    cached: source !== 'remote',
    attemptCount: attempt,
  };
  return [item];
}

async function persistOutputs({
  env,
  stateKey,
  cacheKey,
  items,
}: {
  env: Record<string, string | undefined>;
  stateKey: string | null;
  cacheKey: string;
  items: NormalizedInvocationItem[];
}) {
  if (!stateKey) return;
  const record = {
    type: 'llm_task.invoke',
    version: STATE_VERSION,
    cacheKey,
    items,
    storedAt: new Date().toISOString(),
  };
  await writeStateJson({ env, key: stateKey, value: record });
}

function pickReusableState(stored: any, cacheKey: string) {
  if (!stored || typeof stored !== 'object') return null;
  if (stored.type !== 'llm_task.invoke') return null;
  if (stored.cacheKey !== cacheKey) return null;
  if (!Array.isArray(stored.items)) return null;
  return { items: stored.items };
}

function collectAjvErrors(errors: ErrorObject[] | null | undefined) {
  if (!errors?.length) return [];
  return errors.map((err) => `${err.instancePath || '/'} ${err.message ?? ''}`.trim());
}

async function readCacheEntry(env: Record<string, string | undefined>, key: string): Promise<CacheEntry | null> {
  const filePath = path.join(getCacheDir(env), 'llm_task.invoke', `${key}.json`);
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text) as CacheEntry;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeCacheEntry(
  env: Record<string, string | undefined>,
  key: string,
  items: NormalizedInvocationItem[],
) {
  const dir = path.join(getCacheDir(env), 'llm_task.invoke');
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${key}.json`);
  await fsp.writeFile(filePath, JSON.stringify({ items, cacheKey: key, storedAt: new Date().toISOString() }, null, 2));
}

function getCacheDir(env: Record<string, string | undefined>) {
  if (env?.LOBSTER_CACHE_DIR) return env.LOBSTER_CACHE_DIR;
  return path.join(process.cwd(), '.lobster-cache');
}

async function* streamOf(items: NormalizedInvocationItem[]) {
  for (const item of items) {
    yield item;
  }
}
