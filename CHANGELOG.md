# Changelog

All notable changes to Lobster will be documented in this file.

## Unreleased

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
