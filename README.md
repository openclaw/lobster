# Lobster

A Clawdbot-native workflow shell: typed (JSON-first) pipelines, jobs, and approval gates.

This repo is an MVP scaffold focused on the core shell runtime and a first Gmail integration via the `steipete/gog` skill/CLI.

## Goals

- Typed pipelines (objects/arrays), not text pipes.
- Local-first execution.
- No new auth surface: Lobster must not own OAuth/tokens.
- Composable macros that Clawdbot can invoke in one step to save tokens.

## Quick start

From this folder:

- `node ./bin/lobster.js --help`
- `node ./bin/lobster.js "exec --json 'echo [1,2,3]' | where '0>=0' | json"`

If you have `gog` installed:

- `node ./bin/lobster.js "gog.gmail.search --query 'newer_than:7d' --max 5 | table"`

## Commands

- `exec`: run OS commands
- `gog.gmail.search`: fetch Gmail search results via `gog`
- `gog.gmail.send`: send email via `gog` (use approval gates)
- `email.triage`: deterministic triage report (rule-based)
- `where`, `pick`, `head`: data shaping
- `json`, `table`: renderers
- `approve`: approval gate (TTY prompt or `--emit` for Clawdbot integration)

## Next steps

- Canonical `EmailMessage` schema (normalize gog output predictably).
- `email.draft` + `email.send` macros (compose approvals cleanly).
- Clawdbot integration: expose Lobster as a first-class tool (`lobster.run`).
