# Feature Proposal: Parallel Step Execution with Deterministic Join

## Problem

Lobster workflows are strictly sequential. The step execution loop in `src/workflows/file.ts` (line 328) is a `for` loop that processes one step at a time:

```typescript
for (let idx = startIndex; idx < steps.length; idx++) {
  const step = steps[idx];
  // ... execute step, wait for completion, then next
}
```

There is no way to run independent steps concurrently. The only data-parallel operation is `--each` in `openclaw.invoke`, which maps a single command over input items — it doesn't support running different steps in parallel.

## Why This Matters

Multi-source aggregation is a core lobster use case (evidenced by `diff.last`, `state.get/set`, and the PR monitor recipe). A workflow that fetches from GitHub, Jira, and Slack sequentially takes 3x the wall-clock time:

```
Sequential:  GitHub (2s) → Jira (3s) → Slack (1s) = 6s total
Parallel:    GitHub (2s) ┐
             Jira   (3s) ├ = 3s total (2x faster)
             Slack  (1s) ┘
```

For monitoring and triage workflows that poll multiple sources every few minutes, this difference compounds significantly.

## Proposed Syntax

```yaml
steps:
  - parallel:
      wait: all                 # all | any | first_N(2)
      timeout_ms: 30000         # optional overall timeout
      branches:
        - id: github_data
          run: gh pr list --repo org/repo --json number,title

        - id: jira_data
          run: curl -s https://jira.example.com/api/sprint

        - id: slack_data
          pipeline: >
            openclaw.invoke --tool slack --action search
            --args-json '{"query": "incident"}' | pick id,text

  - id: merge_report
    pipeline: >
      template --text "GitHub: {{$github_data.json | length}} PRs,
      Jira: {{$jira_data.json | length}} tickets,
      Slack: {{$slack_data.json | length}} messages"
```

### Wait Strategies

| Strategy | Behavior |
|----------|----------|
| `all` | (Default) Wait for all branches to complete. Fail if any fails (unless `on_error: continue`). |
| `any` | Return as soon as the first branch succeeds. Cancel remaining branches. |
| `first_N(n)` | Return after N branches succeed. Cancel remaining. |

## Implementation Approach

### 1. Extend step types in `file.ts`

```typescript
export type WorkflowStep = {
  // ... existing fields
  parallel?: {
    wait?: 'all' | 'any' | string;   // 'first_N(2)' parsed at runtime
    timeout_ms?: number;
    branches: ParallelBranch[];
  };
};

export type ParallelBranch = {
  id: string;
  run?: string;
  pipeline?: string;
  env?: Record<string, string>;
  cwd?: string;
  on_error?: 'stop' | 'continue';    // per-branch error policy
};
```

### 2. Parallel execution in step loop

When a `parallel` step is encountered, execute all branches concurrently:

```typescript
if (step.parallel) {
  const branches = step.parallel.branches;
  const wait = step.parallel.wait ?? 'all';

  const controller = new AbortController();
  const timeout = step.parallel.timeout_ms
    ? setTimeout(() => controller.abort(), step.parallel.timeout_ms)
    : null;

  const promises = branches.map(async (branch) => {
    // Each branch runs as a mini-step (shell or pipeline)
    const env = mergeEnv(ctx.env, workflow.env, branch.env, resolvedArgs, results);
    const execution = getStepExecution(branch);
    // ... execute and return WorkflowStepResult
  });

  if (wait === 'all') {
    const settled = await Promise.allSettled(promises);
    // Map results by branch.id into results object
  } else if (wait === 'any') {
    const winner = await Promise.race(promises);
    controller.abort(); // cancel remaining
  }

  clearTimeout(timeout);
}
```

### 3. Result access

Each branch's result is stored in `results` under its `id`, so subsequent steps reference them naturally:
- `$github_data.json` — parsed JSON from the github_data branch
- `$jira_data.stdout` — raw stdout from the jira_data branch

The parallel block itself gets a synthetic aggregate result.

### 4. Constraints

- **No approval gates inside parallel blocks**: This would violate the single-halt invariant. Validation should reject workflows with `approval: true` inside a `parallel.branches` step.
- **No nested parallel blocks**: Keep it simple for v1. Validation should reject nesting.
- **Branch IDs must be unique**: Enforced at validation time.

### 5. SDK primitive

```typescript
import { ParallelConfig, Stage } from '../types.js';

export function parallel(branches: Record<string, Stage>, config?: { wait?: string }): Stage {
  return {
    async *run(input, ctx) {
      const promises = Object.entries(branches).map(([id, stage]) =>
        collectOutput(stage.run(input, ctx)).then(output => ({ id, output }))
      );
      // ... wait strategy logic
    }
  };
}
```

## Files to Modify

| File | Change |
|------|--------|
| `src/workflows/file.ts` | Add `parallel` to `WorkflowStep`, execution logic, validation |
| New: `src/sdk/primitives/parallel.ts` | SDK parallel wrapper |
| `test/` | Tests for all/any/first_N strategies, timeout, error handling, result access |

## Complexity: Large

- Type definitions: ~25 lines
- Execution logic: ~80 lines
- Validation (no nested parallel, no approvals inside): ~20 lines
- Wait strategy logic: ~40 lines
- SDK primitive: ~40 lines
- Tests: ~150 lines

## Design Notes

- **Deterministic declaration**: The set of branches and join strategy are static YAML. The order of completion is non-deterministic, but the result set is deterministic (all named branches produce named results).
- **Respects lobster's philosophy**: Parallel blocks are explicit, declared, and bounded. This isn't "run anything anywhere" — it's "these specific independent steps can overlap."
- **Composes with error handling** (Proposal #2): Each branch can have its own `on_error` policy. A failed branch with `on_error: continue` records the error; the parallel block succeeds with partial results.
- **Composes with retry** (Proposal #1): Individual branches could support `retry` config.
- **Composes with timeout** (Proposal #5): The parallel block's `timeout_ms` creates an `AbortSignal` shared by all branches.
- **No magic**: Unlike some frameworks that auto-detect parallelizable steps, lobster requires explicit declaration. This is safer and easier to reason about.
