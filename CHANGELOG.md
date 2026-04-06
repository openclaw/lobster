# Changelog

All notable changes to Lobster will be documented in this file.

## Unreleased

## 2026.4.6

- Add workflow file support for `.lobster`/YAML/JSON files, including args, env, native pipeline steps, and shell-safe `LOBSTER_ARG_*` workflow args.
- Export the embeddable core runtime via `@clawdbot/lobster/core` so Lobster can be loaded in-process by OpenClaw and other hosts.
- Add compact state-backed workflow and pipeline resume tokens, plus hardened approval ID handling and safer resume validation.
- Add structured input pauses with `ask`, workflow `input`, `needs_input`, and `lobster resume --response-json '{...}'`.
- Add richer workflow condition expressions with `!`, `==`, `!=`, `&&`, `||`, and parentheses.
- Add generic `llm.invoke` adapters, `openclaw.invoke --each`, and keep `clawd.invoke` as a supported alias.
- Add `exec --stdin raw|json|jsonl`, `approve --preview-from-stdin --limit N`, and extensive dry-run hardening for workflow templates and shell-variable preservation.
- Improve Windows compatibility for CLI startup/build scripts and fix quoted-argument parser edge cases.

## 2026.1.21-1

- Published release (pre-changelog).

## 2026.1.21

- Initial published release (pre-changelog).
