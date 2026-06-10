export type StepCost = {
  stepId: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type CostSummary = {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  byStep: StepCost[];
};

export type CostLimit = {
  max_usd: number;
  action?: "warn" | "stop";
};

const DEFAULT_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "claude-sonnet-4-5-20250514": { input: 3.0, output: 15.0 },
  "claude-haiku-3-5": { input: 0.8, output: 4.0 },
  "gemini-1.5-pro": { input: 1.25, output: 5.0 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
};

const INVALID_PRICING_JSON_WARNING =
  "[WARN] Ignoring invalid LOBSTER_LLM_PRICING_JSON; custom LLM pricing must be a JSON object whose model entries have finite non-negative input and output rates.\n";

function toTokenCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export class CostTracker {
  private steps: StepCost[] = [];

  private pricing: Record<string, { input: number; output: number }>;

  private stderr?: NodeJS.WritableStream;

  private warnedUnknownModels = new Set<string>();

  constructor(
    customPricing?: Record<string, { input: number; output: number }>,
    stderr?: NodeJS.WritableStream,
  ) {
    this.pricing = { ...DEFAULT_PRICING, ...customPricing };
    this.stderr = stderr;
  }

  recordUsage(stepId: string, model: string | null, usage: Record<string, unknown>) {
    const inputTokens = toTokenCount(
      usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens,
    );
    const outputTokens = toTokenCount(
      usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens,
    );
    const pricingKey = typeof model === "string" && model.trim() ? model : null;
    const pricing =
      pricingKey && Object.prototype.hasOwnProperty.call(this.pricing, pricingKey)
        ? this.pricing[pricingKey]
        : undefined;
    if (!pricing) {
      this.warnUnknownModel(pricingKey ?? "<missing>");
    }
    const effectivePricing = pricing ?? { input: 0, output: 0 };
    const costUsd =
      (inputTokens * effectivePricing.input + outputTokens * effectivePricing.output) / 1_000_000;
    this.steps.push({ stepId, model, inputTokens, outputTokens, costUsd });
  }

  getSummary(): CostSummary {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let estimatedCostUsd = 0;

    for (const step of this.steps) {
      totalInputTokens += step.inputTokens;
      totalOutputTokens += step.outputTokens;
      estimatedCostUsd += step.costUsd;
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      estimatedCostUsd: Math.round(estimatedCostUsd * 1_000_000) / 1_000_000,
      byStep: [...this.steps],
    };
  }

  hasUsage() {
    return this.steps.length > 0;
  }

  checkLimit(limit: CostLimit, stderr?: NodeJS.WritableStream) {
    const summary = this.getSummary();
    if (summary.estimatedCostUsd <= limit.max_usd) return;

    if (limit.action === "stop") {
      throw new Error(
        `Cost limit exceeded: $${summary.estimatedCostUsd.toFixed(4)} > $${limit.max_usd.toFixed(2)} limit`,
      );
    }

    if (stderr) {
      stderr.write(
        `[WARN] Cost $${summary.estimatedCostUsd.toFixed(4)} exceeds limit $${limit.max_usd.toFixed(2)}\n`,
      );
    }
  }

  static parsePricingFromEnv(
    env: Record<string, string | undefined>,
    stderr?: NodeJS.WritableStream,
  ): Record<string, { input: number; output: number }> | undefined {
    const raw = env.LOBSTER_LLM_PRICING_JSON;
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (!isPricingMap(parsed)) {
        stderr?.write(INVALID_PRICING_JSON_WARNING);
        return undefined;
      }
      return parsed;
    } catch {
      stderr?.write(INVALID_PRICING_JSON_WARNING);
      return undefined;
    }
  }

  private warnUnknownModel(model: string) {
    if (this.warnedUnknownModels.has(model)) return;
    this.warnedUnknownModels.add(model);
    const safeModel = safeJsonString(model);
    this.stderr?.write(
      `[WARN] No LLM pricing configured for model ${safeModel}; recording zero cost. Set LOBSTER_LLM_PRICING_JSON to enable cost_limit enforcement for this model.\n`,
    );
  }
}

function isPricingMap(value: unknown): value is Record<string, { input: number; output: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [model, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!model.trim()) return false;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const rates = entry as Record<string, unknown>;
    if (!isValidRate(rates.input) || !isValidRate(rates.output)) return false;
  }
  return true;
}

function isValidRate(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeJsonString(value: string) {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}
