# ADR-001: Workflow Command Resolution

## Status

Accepted (2026-02-14)

## Context

Lobster workflow files (`.workflow.yml`) define steps as shell commands:

```yaml
steps:
  - name: search
    command: |
      clawd.invoke --tool web_search --action search --args-json '{"query":"$QUERY"}'
```

The workflow runner (`workflows/file.ts`) executes each step's `command` via
`/bin/sh -lc "<command>"`. Pipeline commands like `clawd.invoke` and
`llm_task.invoke` are registered in the TypeScript command registry and are
only available when running through the lobster pipeline runner, not as
standalone executables on PATH.

This causes silent failures: the shell cannot find the command, the step
produces empty output, and downstream steps (e.g. `bib-build`) crash on
missing data. Error messages are often masked by `2>/dev/null || true`
patterns in workflow scripts.

## Options Considered

### A. Bin wrappers (chosen)

Create standalone Node.js scripts (`bin/clawd-invoke.js`,
`bin/llm-task-invoke.js`) that import the command's `run()` function and
expose it as a shell-callable binary. Register them in `package.json` `bin`
so `npm install -g` creates symlinks in `/usr/local/bin/`.

Tradeoffs:
- [+] Works immediately with existing workflow files
- [+] No changes to workflow runner
- [+] Each wrapper is self-contained (< 100 lines)
- [-] Duplicates arg parsing (parser.ts vs manual argv parsing)
- [-] Each new pipeline command needs a corresponding bin wrapper

### B. Workflow runner interception

Modify the workflow runner to detect pipeline command names in step commands
and route them through the command registry instead of spawning a shell.

Tradeoffs:
- [+] No bin wrappers needed
- [+] Commands share the existing context (registry, state, caching)
- [-] Mixed shell/lobster commands in one line are hard to parse reliably
  (e.g. `clawd.invoke --tool x | jq .result`)
- [-] Breaks the simple mental model of "steps are shell commands"
- [-] Requires changes to the workflow runner's execution model

### C. HTTP shell wrappers in skills

Have each skill provide its own `curl`-based wrappers that call the OpenClaw
gateway directly, bypassing the lobster command layer entirely.

Tradeoffs:
- [+] Skill-independent, works with any deployment
- [-] Loses caching, run-state management, and schema validation from
  `llm_task.invoke`
- [-] Each skill must reimplement auth, error handling, and retry logic
- [-] Tightly couples skills to the gateway HTTP API

## Decision

Option A (bin wrappers). The arg parsing duplication is acceptable given
that the parser is simple (`--key value` pairs) and the wrappers are thin
pass-through scripts. This provides the fastest fix with minimal risk.

## Future Consideration

The workflow format could support a `pipeline:` step type alongside
`command:` for native lobster command execution without the shell
intermediary:

```yaml
steps:
  - name: search
    pipeline: |
      clawd.invoke --tool web_search --action search | jq-filter --expr '.results'
```

This would use the existing pipeline runner (with its registry, context, and
streaming) for steps that don't need shell features. This approach combines
the reliability of option B with the simplicity of the current model, but
requires a workflow format version bump and runner changes.
