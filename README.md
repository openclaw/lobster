# Lobster

A Clawdbot-native workflow shell: typed (JSON-first) pipelines, jobs, and approval gates.

This repo is an MVP scaffold focused on the core shell runtime and a first Gmail integration via the `steipete/gog` skill/CLI.


## Example of lobster at work
Clawdbot or any other AI agent can use `lobster` as a workflow engine and not construct a query every time - thus saving tokens, providing room for determinism, and resumability.
```
node bin/lobster.js "workflows.run --name github.pr.monitor --args-json '{\"repo\":\"clawdbot/clawdbot\",\"pr\":1152}'"
[
  {
    "kind": "github.pr.monitor",
    "repo": "clawdbot/clawdbot",
    "pr": 1152,
    "key": "github.pr:clawdbot/clawdbot#1152",
    "changed": false,
    "summary": {
      "changedFields": [],
      "changes": {}
    },
    "prSnapshot": {
      "author": {
        "id": "MDQ6VXNlcjE0MzY4NTM=",
        "is_bot": false,
        "login": "vignesh07",
        "name": "Vignesh"
      },
      "baseRefName": "main",
      "headRefName": "feat/lobster-plugin",
      "isDraft": false,
      "mergeable": "MERGEABLE",
      "number": 1152,
      "reviewDecision": "",
      "state": "OPEN",
      "title": "feat: Add optional lobster plugin tool (typed workflows, approvals/resume)",
      "updatedAt": "2026-01-18T20:16:56Z",
      "url": "https://github.com/clawdbot/clawdbot/pull/1152"
    }
  }
]
```
## Goals

- Typed pipelines (objects/arrays), not text pipes.
- Local-first execution.
- No new auth surface: Lobster must not own OAuth/tokens.
- Composable macros that Clawdbot can invoke in one step to save tokens.

## Quick start

From this folder:

- `node ./bin/lobster.js --help`
- `node ./bin/lobster.js version`
- `node ./bin/lobster.js doctor`
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
- Clawdbot integration: ship as an optional Clawdbot plugin tool.
