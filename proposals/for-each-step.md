# Feature Proposal: `for_each` Step Type with Optional Batching

## Problem

Lobster has `map` (transform items inline) and `where` (filter items) as pipeline commands, but there is no way to run a multi-step sub-workflow for each item in a collection at the workflow level.

If you have 10 PRs and want to run a 3-step analysis on each one (fetch details, LLM review, post comment), you need:
- 10 separate workflow invocations via external scripting, or
- A single `openclaw.invoke --each` which only supports one command per item, or
- A complex pipeline with state management to track position

None of these are ergonomic for the core use case of "for each item, do these steps."

## Why This Matters

The canonical lobster workflow is: **fetch N items, process each, approve results.** Today, the "process each" part is limited to single-command operations via pipeline `map` or `openclaw.invoke --each`.

Real-world examples:
- **PR triage**: For each open PR, fetch diff, run LLM review, classify priority, collect results for approval
- **Email processing**: For each unread email, extract entities, look up in CRM, draft response
- **Incident response**: For each alert, fetch metrics, correlate with deploys, generate summary
- **Data migration**: For each record, validate, transform, write to new system, log result

All of these require multiple steps per item — exactly what `for_each` provides.

## Proposed Syntax

### Basic `for_each`

```yaml
steps:
  - id: prs
    run: gh pr list --repo org/repo --json number,title,url

  - id: reviews
    for_each: $prs.json
    item_var: pr              # default: 'item'
    steps:
      - id: diff
        run: gh pr diff ${pr.number}

      - id: review
        pipeline: llm.invoke --prompt "Review this diff: ${diff.stdout}"

      - id: result
        pipeline: >
          map --wrap review_result
          key=pr_number={{pr.number}}
          key=summary={{review.json.output.text}}
```

### With batching

```yaml
  - id: reviews
    for_each: $prs.json
    batch_size: 3             # process 3 items at a time
    pause_ms: 1000            # wait 1s between batches (rate limiting)
    steps:
      - id: enrich
        run: curl -s https://api.example.com/pr/${item.number}
```

### With index access

```yaml
  - id: process
    for_each: $items.json
    item_var: item
    index_var: idx            # default: 'index'
    steps:
      - id: log
        run: echo "Processing item ${idx} of ${items.json | length}"
```

## How Results Work

The `for_each` step collects results from all iterations into an array:

```typescript
// $reviews.json after for_each completes:
[
  { "pr_number": 1, "diff": "...", "review": { ... } },
  { "pr_number": 2, "diff": "...", "review": { ... } },
  // ... one entry per item
]
```

Each iteration's results are scoped — `$diff.stdout` inside the loop refers to that iteration's diff, not a previous one.

## Implementation Approach

### 1. Extend `WorkflowStep` type in `file.ts`

```typescript
export type WorkflowStep = {
  // ... existing fields
  for_each?: string;           // expression resolving to an array
  item_var?: string;           // default: 'item'
  index_var?: string;          // default: 'index'
  batch_size?: number;         // default: 1 (sequential)
  pause_ms?: number;           // delay between batches
  steps?: WorkflowStep[];      // sub-steps to run for each item
};
```

### 2. Loop execution in step runner

```typescript
if (step.for_each) {
  const items = resolveExpression(step.for_each, resolvedArgs, results);
  if (!Array.isArray(items)) {
    throw new Error(`for_each on step '${step.id}': expected array, got ${typeof items}`);
  }

  const itemVar = step.item_var ?? 'item';
  const indexVar = step.index_var ?? 'index';
  const batchSize = step.batch_size ?? 1;
  const iterationResults: unknown[] = [];

  const batches = chunk(items, batchSize);
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    if (batchIdx > 0 && step.pause_ms) {
      await sleep(step.pause_ms);
    }

    for (let itemIdx = 0; itemIdx < batches[batchIdx].length; itemIdx++) {
      const item = batches[batchIdx][itemIdx];
      const globalIdx = batchIdx * batchSize + itemIdx;

      // Create scoped results for this iteration
      const scopedResults = {
        ...results,
        [itemVar]: { json: item },
        [indexVar]: { json: globalIdx },
      };

      // Run sub-steps with scoped results
      for (const subStep of step.steps ?? []) {
        // ... execute sub-step with scopedResults
        // Same logic as the main step loop but with scoped context
      }

      // Collect this iteration's final result
      iterationResults.push(scopedResults);
    }
  }

  results[step.id] = {
    id: step.id,
    json: iterationResults,
  };
}
```

### 3. Template resolution for loop variables

The `resolveTemplate` function needs to handle `${item.field}` and `${index}` references from the scoped results. Since scoped results are injected into the same `results` map, the existing `resolveTemplate` function works without changes — it already resolves `$stepId.field` patterns.

### 4. Validation

- `for_each` requires `steps` to be non-empty
- `steps` inside `for_each` cannot contain `approval` or `input` steps (approval gates inside loops would create UX chaos)
- `batch_size` must be a positive integer
- `item_var` and `index_var` must not collide with existing step IDs
- Nested `for_each` could be allowed but limited to 2 levels deep

### 5. Dry-run support

Display loop structure: "Step `reviews` will iterate over `$prs.json` (unknown length at dry-run time), running 3 sub-steps per item."

## Files to Modify

| File | Change |
|------|--------|
| `src/workflows/file.ts` | Add `for_each` fields to `WorkflowStep`, loop execution logic, scoped results |
| `test/` | Tests for basic iteration, batching, pause, index access, nested results, validation |

## Complexity: Medium

- Type changes: ~10 lines
- Loop execution logic: ~60 lines
- Scoped result management: ~30 lines
- Validation: ~20 lines
- Tests: ~100 lines

## Design Notes

- **Deterministic**: Loop order matches input array order. No parallel execution within batches (v1). Batch size is declared, not adaptive.
- **Composable with retry** (Proposal #1): Sub-steps within the loop can have their own `retry` config.
- **Composable with error handling** (Proposal #2): Sub-steps can use `on_error: continue` to skip failed items without aborting the entire loop. The `for_each` step itself could have `on_error: continue` to skip items where any sub-step fails.
- **Composable with parallel** (Proposal #4): Future enhancement could process batches in parallel rather than sequentially.
- **No approval gates in loops**: This is intentional. If you need approval, collect all results in the loop, then approve them in a subsequent step. This preserves lobster's clean halt/resume semantics.
- **Memory-efficient**: Results are collected incrementally. For very large arrays, a future `stream: true` option could yield results as they complete rather than collecting all.

## Example: Complete PR Triage Workflow

```yaml
name: pr-triage
args:
  repo:
    default: org/main-repo

steps:
  - id: open_prs
    run: gh pr list --repo ${repo} --state open --json number,title,url --limit 20

  - id: reviews
    for_each: $open_prs.json
    item_var: pr
    batch_size: 5
    pause_ms: 2000
    steps:
      - id: diff
        run: gh pr diff ${pr.number} --repo ${repo}

      - id: analysis
        pipeline: >
          llm.invoke --prompt "Review this PR diff and classify as: critical, normal, or low priority.
          PR: ${pr.title}
          Diff: ${diff.stdout}"
          --output-schema '{"type":"object","properties":{"priority":{"type":"string"},"summary":{"type":"string"}}}'

  - id: show_results
    pipeline: >
      pick priority,summary,pr.title |
      sort --key priority |
      table

  - id: approve_actions
    approval:
      prompt: "Review the PR triage results. Approve to post comments?"
      items: $reviews.json
```
