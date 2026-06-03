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

function toTokenCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export class CostTracker {
  private steps: StepCost[] = [];

  private pricing: Record<string, { input: number; output: number }>;

  constructor(customPricing?: Record<string, { input: number; output: number }>) {
    this.pricing = { ...DEFAULT_PRICING, ...(customPricing ?? {}) };
  }

  recordUsage(stepId: string, model: string | null, usage: Record<string, unknown>) {
    const inputTokens = toTokenCount(
      usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens,
    );
    const outputTokens = toTokenCount(
      usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens,
    );
    const pricing = this.pricing[model ?? ""] ?? { input: 0, output: 0 };
    const costUsd = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
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
  ): Record<string, { input: number; output: number }> | undefined {
    const raw = env.LOBSTER_LLM_PRICING_JSON;
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
}
