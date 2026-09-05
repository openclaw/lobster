# Changelog

All notable changes to Lobster will be documented in this file.

## Unreleased

**Highlights:** Run configured OpenClaw agents directly from workflows, stop cancelled work before further side effects, and track LLM spend without charging cached answers again.

- Add first-class `openclaw.agent` workflow turns with configured agent, session, model, thinking, and timeout selection delegated to OpenClaw. Thanks to [@Stoff81](https://github.com/Stoff81) (Issue [#117](https://github.com/openclaw/lobster/issues/117)).
- Prevent automatic workflow retries after dispatching `openclaw.invoke`, `clawd.invoke`, or `openclaw.agent`, avoiding duplicate remote actions after timeouts or failures, including requests carrying the gateway's currently ignored `dryRun` flag. Thanks to [@SebTardif](https://github.com/SebTardif) (PR [#153](https://github.com/openclaw/lobster/pull/153)).
- Stop cancelled CLI, tool-runtime, and SDK workflows before later commands or side effects; interrupt prompts and stalled streams, terminate child process trees, and prevent replay of approval/input resumes after an effect starts. Thanks to [@zhangguiping-xydt](https://github.com/zhangguiping-xydt) (PR [#119](https://github.com/openclaw/lobster/pull/119)).
- Honor SDK cancellation in `exec()` and shell commands, including constructor signals on run, clone, and resume. Thanks to [@SebTardif](https://github.com/SebTardif) (PR [#144](https://github.com/openclaw/lobster/pull/144)).
- Honor cancellation in `ghPrView()` and both exported GitHub monitor recipes, stopping the GitHub CLI before returning an error without saving a cancelled snapshot. Thanks to [@SebTardif](https://github.com/SebTardif) (PR [#145](https://github.com/openclaw/lobster/pull/145)).
- Cancel timed-out `gog.gmail.send` process trees and suppress automatic retries after dispatch because termination cannot prove Gmail did not accept the message. Thanks to [@SebTardif](https://github.com/SebTardif) (PR [#136](https://github.com/openclaw/lobster/pull/136)).
- Honor LLM step timeouts and cancellation across adapter calls, cached results, and persistence; stop waiting even when a host adapter ignores its abort signal. Thanks to [@Yigtwxx](https://github.com/Yigtwxx) (PR [#132](https://github.com/openclaw/lobster/pull/132)).
- Count each model call once across cached answers, pipeline projections, sub-workflows, and resumes; preserve accumulated spend across approval/input pauses so `cost_limit` covers the whole run. Thanks to [@Yigtwxx](https://github.com/Yigtwxx) (PR [#134](https://github.com/openclaw/lobster/pull/134)).
- Include temperature and maximum output tokens in LLM cache identity so changing generation settings does not return stale answers. Thanks to [@Yigtwxx](https://github.com/Yigtwxx) (PR [#130](https://github.com/openclaw/lobster/pull/130)).
- Enforce `--max-validation-retries` as the number of extra model calls after the first, avoiding an additional billed call on schema failures. Thanks to [@Yigtwxx](https://github.com/Yigtwxx) (PR [#128](https://github.com/openclaw/lobster/pull/128)).
- Serialize state updates and roll back cancelled cache/snapshot publications; preserve a replacement state lock when the filesystem reuses a stale lock's inode.
- Create cache and state directory chains correctly on Windows. Thanks to [@Yigtwxx](https://github.com/Yigtwxx) (PR [#126](https://github.com/openclaw/lobster/pull/126)).
- Handle subprocess stdin closing early without crashing workflow execution with `EPIPE`. Thanks to [@kesslerio](https://github.com/kesslerio) (PR [#122](https://github.com/openclaw/lobster/pull/122)).
- Keep direct executable arguments separate from explicit shell commands, preserving literal shell metacharacters in direct calls. Thanks to [@vincentkoc](https://github.com/vincentkoc) (PRs [#139](https://github.com/openclaw/lobster/pull/139), [#141](https://github.com/openclaw/lobster/pull/141)).
- Contain prototype-named workflow arguments and step IDs, preserve argument environment names, and escape Mermaid graph labels. Thanks to [@vincentkoc](https://github.com/vincentkoc) (PR [#140](https://github.com/openclaw/lobster/pull/140)).
- Normalize long state keys without expensive regular-expression backtracking. Thanks to [@vincentkoc](https://github.com/vincentkoc) (PR [#138](https://github.com/openclaw/lobster/pull/138)).
- Resolve invocation shims relative to the installed package, reject non-HTTP invocation URLs, and require an explicit token before sending gateway credentials to a remote endpoint. Thanks to [@vincentkoc](https://github.com/vincentkoc).
- Refresh TypeScript, Node.js types, and Oxc tooling; align development and CI on pnpm 12.3.1, retain the two-day dependency release-age policy, and update the `fast-uri` override to 4.1.4.
- Run Node 24 CI on pull requests and pushes to `main`, checking workflow syntax, frozen dependency installation, build, types, formatting, lint, and tests; strengthen parser/filter coverage and cancellation-test readiness.

## 2026.6.11

- Add command-level `ctx.requestInput(...)` for CLI/tool/SDK pipeline commands, with state-backed same-command resume, bounded command-input replay, and workflow `pipeline:` propagation (Issue [#101](https://github.com/openclaw/lobster/issues/101)).
- Warn when LLM usage records an unknown or missing model ID or invalid `LOBSTER_LLM_PRICING_JSON`, keeping zero-cost fallback behavior visible for `cost_limit` users. Thanks to [@KrasimirKralev](https://github.com/KrasimirKralev) (Issue [#107](https://github.com/openclaw/lobster/issues/107)).
- Require Node.js 22 or newer for the npm package, matching release CI.
- Write Lobster state files atomically while preserving restricted file modes, preventing truncated resume/session state after process termination. Thanks to [@KrasimirKralev](https://github.com/KrasimirKralev) (Issues [#108](https://github.com/openclaw/lobster/issues/108), [#109](https://github.com/openclaw/lobster/issues/109), PR [#110](https://github.com/openclaw/lobster/pull/110)).
- Harden LLM cache files, diff snapshots, and approval ID indexes against truncated JSON after process termination. Disposable cache/snapshot corruption now recovers as a miss, authoritative resume state still surfaces malformed JSON, and approval short-ID indexes are published atomically without overwriting existing mappings. Thanks to [@TurboTheTurtle](https://github.com/TurboTheTurtle) (Issues [#111](https://github.com/openclaw/lobster/issues/111), [#112](https://github.com/openclaw/lobster/issues/112), [#113](https://github.com/openclaw/lobster/issues/113), PR [#114](https://github.com/openclaw/lobster/pull/114)).
- Fix `timeout_ms` + `retry` so per-attempt timeouts retry as documented while external workflow cancellation still stops immediately. Thanks to [@KrasimirKralev](https://github.com/KrasimirKralev) (PR [#106](https://github.com/openclaw/lobster/pull/106)).

## 2026.5.22

- Memoize Ajv schema compilation for repeated validation paths to avoid retained SchemaEnv/closure growth in long-running processes. Thanks to [@KrasimirKralev](https://github.com/KrasimirKralev) (PR [#98](https://github.com/openclaw/lobster/pull/98)) and [@cmi525](https://github.com/cmi525) (Issue [#96](https://github.com/openclaw/lobster/issues/96)).
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
