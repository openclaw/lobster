# Changelog

All notable changes to Lobster will be documented in this file.

## Unreleased

- Improve workflow resume compatibility for `stateKey` naming by accepting both `workflow_resume_` and `workflow-resume_` prefixes, including cleanup against the resolved on-disk key. Thanks to [@brownetw-ai](https://github.com/brownetw-ai) (PR [#4](https://github.com/openclaw/lobster/pull/4)).
- Add per-step workflow `retry` policies (`max`, `backoff`, `delay_ms`, `max_delay_ms`, `jitter`) with retry-aware stderr logs and dry-run visibility. Thanks to [@scottgl9](https://github.com/scottgl9) (PR [#84](https://github.com/openclaw/lobster/pull/84)).
- Add optional approval identity constraints for workflow gates (`approval.initiated_by`, `approval.required_approver`, `approval.require_different_approver`) with resume-time enforcement via `LOBSTER_APPROVAL_APPROVED_BY` and envelope metadata for integrations. Thanks to [@coolmanns](https://github.com/coolmanns) (Issue [#44](https://github.com/openclaw/lobster/issues/44)).
- Clarify `pipeline:` vs `run:` usage for `llm.invoke` / `llm_task.invoke` in workflow files, and add regression coverage to ensure `stdin: $step.stdout` is forwarded as LLM artifacts for `llm_task.invoke` pipeline steps. Thanks to [@RatkoJ](https://github.com/RatkoJ) (Issue [#41](https://github.com/openclaw/lobster/issues/41)).
- Add `lobster graph` workflow visualization with `mermaid` (default), `dot`, and `ascii` outputs, including step-type nodes, `stdin` data-flow edges, conditional dependency labels (`when`/`condition`), approval-gate diamond shapes, and `--args-json` label resolution support. Thanks to [@vignesh07](https://github.com/vignesh07) (Issue [#53](https://github.com/openclaw/lobster/issues/53)).
- Add workflow composition via `workflow:` + `workflow_args`, including recursive sub-workflow execution, cycle detection, and dry-run visibility for workflow steps. Sub-workflow approval/input halts are rejected with resume-state cleanup. Thanks to [@scottgl9](https://github.com/scottgl9) (PR [#73](https://github.com/openclaw/lobster/pull/73)).
- Add per-step `on_error` workflow policies (`stop|continue|skip_rest`) for partial-failure recovery, with structured step error fields (`error`, `errorMessage`) for condition-based branching. Thanks to [@scottgl9](https://github.com/scottgl9) (PR [#72](https://github.com/openclaw/lobster/pull/72)).
- Add per-step workflow `timeout_ms` handling, including timeout-triggered aborts, `SIGKILL` for timed shell steps, and dry-run annotations. Thanks to [@scottgl9](https://github.com/scottgl9) (PR [#74](https://github.com/openclaw/lobster/pull/74)).
- Add workflow condition comparison operators `<`, `<=`, `>`, and `>=` with strict numeric semantics (booleans/null do not coerce), including mixed boolean-expression support with `&&`/`||`. Thanks to [@scottgl9](https://github.com/scottgl9) (PR [#71](https://github.com/openclaw/lobster/pull/71)).
- Add workflow-level LLM cost tracking with `_meta.cost` summaries, per-step usage attribution, and optional `cost_limit` controls with `warn`/`stop` actions (plus custom pricing via `LOBSTER_LLM_PRICING_JSON`). Thanks to [@scottgl9](https://github.com/scottgl9) (PR [#70](https://github.com/openclaw/lobster/pull/70)).
- Add `parallel` workflow steps with branch fan-out, `wait: all|any`, block-level timeout support, and branch result references in downstream steps. Thanks to [@scottgl9](https://github.com/scottgl9) (PR [#69](https://github.com/openclaw/lobster/pull/69)).
- Add `for_each` workflow steps for per-item sub-step execution over arrays, including loop-scoped vars (`item_var`/`index_var`), optional `batch_size` + `pause_ms`, and collected iteration outputs for downstream steps. Thanks to [@scottgl9](https://github.com/scottgl9) (PR [#68](https://github.com/openclaw/lobster/pull/68)).
- Add pipe-based template filters (for example `upper`, `length`, `join`, `default`, `date`) for the `template` command with quote-aware filter parsing and chain evaluation. Thanks to [@scottgl9](https://github.com/scottgl9) (PR [#67](https://github.com/openclaw/lobster/pull/67)).

## 2026.4.6

- Add workflow file support for `.lobster`, YAML, and JSON, including workflow args/env, native pipeline steps, and shell-safe `LOBSTER_ARG_*` inputs.
- Add structured input pauses with `ask`, workflow `input`, `needs_input`, and `lobster resume --response-json '{...}'` for resumable human-in-the-loop flows.
- Add richer workflow condition expressions with `!`, `==`, `!=`, `&&`, `||`, and parentheses.
- Export the embeddable runtime via `@clawdbot/lobster/core` so Lobster can run in-process inside OpenClaw and other hosts.
- Add generic `llm.invoke` adapters, `openclaw.invoke --each`, and keep `clawd.invoke` as a supported alias.
- Add compact state-backed workflow/pipeline resume tokens, safer resume validation, and hardened approval ID handling.
- Improve dry-run and shell interoperability with `exec --stdin raw|json|jsonl`, `approve --preview-from-stdin --limit N`, and better template/shell-variable preservation.
- Improve Windows CLI/build compatibility and fix quoted-argument parser edge cases.

## 2026.1.21-1

- Published release (pre-changelog).

## 2026.1.21

- Initial published release (pre-changelog).
