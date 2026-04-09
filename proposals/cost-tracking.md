# Feature Proposal: LLM Cost Tracking

## Problem

The `llm.invoke` command already receives `usage` data from LLM responses (`src/commands/stdlib/llm_invoke.ts`, line 119: `usage?: Record<string, unknown> | null`) and normalizes it into output items. But this data flows through the pipeline and disappears — there is no aggregation, no cost estimation, no limits, and no summary reporting.

Token counts are technically available in the raw pipeline output, but:
- There's no per-workflow cost summary
- There's no way to set spending limits
- There's no way to compare costs across runs
- Multi-step workflows with several `llm.invoke` calls require manual addition of token counts

## Why This Matters

When lobster manages multi-step workflows with LLM calls, costs escalate silently:
- A workflow with 5 LLM steps might cost $0.50 or $5.00 depending on model and input length
- Running that workflow every 5 minutes costs $144-$1440/day
- Without visibility, teams discover cost overruns from billing alerts, not from the tool

Cost awareness is table stakes for any LLM-integrated automation framework.

## Proposed Syntax

### Workflow-level cost tracking

```yaml
name: pr-triage
cost_limit:
  max_usd: 1.00                # stop workflow if cost exceeds this
  action: warn                  # warn | stop (default: warn)
  
steps:
  - id: classify
    pipeline: llm.invoke --prompt "Classify this PR" --model gpt-4o

  - id: summarize
    pipeline: llm.invoke --prompt "Summarize findings" --model claude-sonnet-4-5-20250514
```

### Cost report in output

After workflow completion, include cost metadata:

```json
{
  "status": "ok",
  "output": [...],
  "_meta": {
    "cost": {
      "totalInputTokens": 2450,
      "totalOutputTokens": 890,
      "estimatedCostUsd": 0.0234,
      "byStep": [
        { "stepId": "classify", "model": "gpt-4o", "inputTokens": 1200, "outputTokens": 450, "costUsd": 0.0123 },
        { "stepId": "summarize", "model": "claude-sonnet-4-5-20250514", "inputTokens": 1250, "outputTokens": 440, "costUsd": 0.0111 }
      ]
    }
  }
}
```

### CLI output (human mode)

```
Cost: $0.0234 (2,450 input + 890 output tokens)
  classify:  $0.0123 (gpt-4o)
  summarize: $0.0111 (claude-sonnet-4-5-20250514)
```

## Implementation Approach

### 1. New cost tracker: `src/core/cost_tracker.ts`

```typescript
type StepCost = {
  stepId: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

type CostSummary = {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  byStep: StepCost[];
};

// Built-in pricing (per 1M tokens)
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o':             { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':        { input: 0.15,  output: 0.60  },
  'gpt-4-turbo':        { input: 10.00, output: 30.00 },
  'claude-opus-4-20250514':     { input: 15.00, output: 75.00 },
  'claude-sonnet-4-5-20250514': { input: 3.00,  output: 15.00 },
  'claude-haiku-3-5':   { input: 0.80,  output: 4.00  },
  'gemini-1.5-pro':     { input: 1.25,  output: 5.00  },
  'gemini-1.5-flash':   { input: 0.075, output: 0.30  },
};

export class CostTracker {
  private steps: StepCost[] = [];

  recordUsage(stepId: string, model: string | null, usage: Record<string, unknown>): void {
    const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
    const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
    const pricing = PRICING[model ?? ''] ?? { input: 0, output: 0 };
    const costUsd = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
    this.steps.push({ stepId, model, inputTokens, outputTokens, costUsd });
  }

  getSummary(): CostSummary { ... }
  checkLimit(limit: { max_usd: number; action: 'warn' | 'stop' }): void { ... }
}
```

### 2. Integrate into workflow runner (`file.ts`)

Create a `CostTracker` at workflow start. After each pipeline step that produces items with `usage` fields, extract token counts:

```typescript
const costTracker = new CostTracker();

// After pipeline step execution:
if (result.json && typeof result.json === 'object') {
  const item = Array.isArray(result.json) ? result.json[0] : result.json;
  if (item?.usage) {
    costTracker.recordUsage(step.id, item.model ?? null, item.usage);
    if (workflow.cost_limit) {
      costTracker.checkLimit(workflow.cost_limit);
    }
  }
}
```

### 3. Include in output

For tool mode, add `_meta.cost` to the output envelope. For human mode, print a summary line to stderr.

### 4. Custom pricing

Allow overriding built-in pricing via environment variable:

```bash
export LOBSTER_LLM_PRICING_JSON='{"custom-model": {"input": 5.0, "output": 15.0}}'
```

## Files to Modify

| File | Change |
|------|--------|
| New: `src/core/cost_tracker.ts` | Cost tracker class with pricing table (~80 lines) |
| `src/workflows/file.ts` | Integrate tracker into step loop, add `cost_limit` to `WorkflowFile` type |
| `src/commands/stdlib/llm_invoke.ts` | No changes needed (usage data already in output) |
| `test/` | Cost calculation tests, limit enforcement tests |

## Complexity: Small

- Cost tracker: ~80 lines
- Integration: ~20 lines
- Type changes: ~10 lines
- Tests: ~60 lines
- Zero new dependencies

## Design Notes

- **Non-invasive**: The data is already flowing through `llm.invoke` output. This proposal just aggregates it.
- **Pricing will drift**: Built-in pricing is a best-effort snapshot. The `LOBSTER_LLM_PRICING_JSON` override handles custom/updated pricing without code changes.
- **Works with all LLM providers**: The `usage` normalization in `llm.invoke` already handles different provider formats (OpenAI's `prompt_tokens`/`completion_tokens` vs Anthropic's `input_tokens`/`output_tokens`).
- **Cost limits are soft by default**: `action: warn` logs a warning; `action: stop` throws an error (composable with Proposal #2's error handling).
- **Historical tracking**: Future enhancement could write cost data to `state.set` for tracking across runs. Not in scope for v1.
