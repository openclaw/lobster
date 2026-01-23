# Changelog

All notable changes to Lobster will be documented in this file.

## Unreleased

- Add workflow file runner for `.lobster`/YAML/JSON workflows with args, env, conditions, and approval gates.
- Add compact workflow resume tokens backed by Lobster state storage.
- Add `exec --stdin raw|json|jsonl` to pipe workflow output into subprocess stdin.
- Add `approve --preview-from-stdin --limit N` for approval previews without extra glue.
- Add `clawd.invoke --each` to map pipeline input items into tool calls.
- Extend CLI to run workflow files with `lobster run <file>` or `--file` + `--args-json`.

## 2026.1.21-1

- Published release (pre-changelog).

## 2026.1.21

- Initial published release (pre-changelog).
