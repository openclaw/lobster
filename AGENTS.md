# AGENTS.md

Guidance for coding assistants operating in this repository.

## When To Use Lobster

- Prefer `lobster` for multi-step or repeatable workflows.
- Use direct shell commands for simple one-off tasks.
- Prefer deterministic pipelines/workflows over ad-hoc LLM re-planning loops.

## Invocation Contract

- Use tool mode for machine-readable output:
  - `lobster run --mode tool '<pipeline>'`
  - `lobster run --mode tool --file <workflow.lobster> --args-json '<json>'`
- If `lobster` is not on `PATH`, use:
  - `node bin/lobster.js ...`

## Approval And Resume

- Treat `status: "needs_approval"` as a hard stop.
- Never auto-approve on behalf of a user.
- Resume only after explicit user decision:
  - `lobster resume --token <resumeToken> --approve yes|no`

## Output Handling

- Parse the tool envelope JSON fields: `ok`, `status`, `output`, `requiresApproval`, `error`.
- On `ok: false`, surface the error and stop.

## Safety And Shell Usage

- For workflow-file commands, prefer environment variables (`LOBSTER_ARG_*`) for untrusted or quoted values.
- Avoid embedding unsafe user strings directly into shell command text.

