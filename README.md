# Lobster

An OpenClaw-native workflow shell: typed (JSON-first) pipelines, jobs, and approval gates.


## Example of Lobster at work
OpenClaw (or any other AI agent) can use `lobster` as a workflow engine and avoid re-planning every step — saving tokens while improving determinism and resumability.

### Watching a PR that hasn't had changes
```
node bin/lobster.js "workflows.run --name github.pr.monitor --args-json '{\"repo\":\"openclaw/openclaw\",\"pr\":1152}'"
[
  {
    "kind": "github.pr.monitor",
    "repo": "openclaw/openclaw",
    "prNumber": 1152,
    "key": "github.pr:openclaw/openclaw#1152",
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
      "url": "https://github.com/openclaw/openclaw/pull/1152"
    }
  }
]
```
### And a PR that has a state change (in this case an approved PR)

```
 node bin/lobster.js "workflows.run --name github.pr.monitor --args-json '{\"repo\":\"openclaw/openclaw\",\"pr\":1200}'"
[
  {
    "kind": "github.pr.monitor",
    "repo": "openclaw/openclaw",
    "prNumber": 1200,
    "key": "github.pr:openclaw/openclaw#1200",
    "changed": true,
    "summary": {
      "changedFields": [
        "number",
        "title",
        "url",
        "state",
        "isDraft",
        "mergeable",
        "reviewDecision",
        "updatedAt",
        "baseRefName",
        "headRefName"
      ],
      "changes": {
        "number": {
          "from": null,
          "to": 1200
        },
        "title": {
          "from": null,
          "to": "feat(tui): add syntax highlighting for code blocks"
        },
        "url": {
          "from": null,
          "to": "https://github.com/openclaw/openclaw/pull/1200"
        },
        "state": {
          "from": null,
          "to": "MERGED"
        },
        "isDraft": {
          "from": null,
          "to": false
        },
        "mergeable": {
          "from": null,
          "to": "UNKNOWN"
        },
        "reviewDecision": {
          "from": null,
          "to": ""
        },
        "updatedAt": {
          "from": null,
          "to": "2026-01-19T05:06:09Z"
        },
        "baseRefName": {
          "from": null,
          "to": "main"
        },
        "headRefName": {
          "from": null,
          "to": "feat/tui-syntax-highlighting"
        }
      }
    },
    "prSnapshot": {
      "author": {
        "id": "MDQ6VXNlcjE0MzY4NTM=",
        "is_bot": false,
        "login": "vignesh07",
        "name": "Vignesh"
      },
      "baseRefName": "main",
      "headRefName": "feat/tui-syntax-highlighting",
      "isDraft": false,
      "mergeable": "UNKNOWN",
      "number": 1200,
      "reviewDecision": "",
      "state": "MERGED",
      "title": "feat(tui): add syntax highlighting for code blocks",
      "updatedAt": "2026-01-19T05:06:09Z",
      "url": "https://github.com/openclaw/openclaw/pull/1200"
    }
  }
]
```

## Goals


- Typed pipelines (objects/arrays), not text pipes.
- Local-first execution.
- No new auth surface: Lobster must not own OAuth/tokens.
- Composable macros that OpenClaw (or any agent) can invoke in one step to save tokens.

## Quick start

From this folder:

- `pnpm install`
- `pnpm test`
- `pnpm lint`
- `node ./bin/lobster.js --help`
- `node ./bin/lobster.js doctor`
- `node ./bin/lobster.js "exec --json --shell 'echo [1,2,3]' | where '0>=0' | json"`

### Notes

- `pnpm test` runs `tsc` and then executes tests against `dist/`.
- `bin/lobster.js` prefers the compiled entrypoint in `dist/` when present.
## Commands

- `exec`: run OS commands
- `exec --stdin raw|json|jsonl`: feed pipeline input into subprocess stdin
- `where`, `pick`, `head`: data shaping
- `json`, `table`: renderers
- `approve`: approval gate (TTY prompt or `--emit` for OpenClaw integration)

## Next steps

- OpenClaw integration: ship as an optional OpenClaw plugin tool.

## Workflow files

Lobster can run YAML/JSON workflow files with `steps`, `env`, `condition`, and approval gates.

```
lobster run path/to/workflow.lobster
lobster run --file path/to/workflow.lobster --args-json '{"tag":"family"}'
```

Example file:

```yaml
name: inbox-triage
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

## Calling OpenClaw tools from workflows

Workflow `steps[].command` runs in `/bin/sh`, so *tool calls must be real executables*.

If you install Lobster via npm/pnpm, it installs a small shim executable named:

- `openclaw.invoke` (preferred)
- `clawd.invoke` (alias)

These shims forward to the Lobster pipeline command of the same name.

### Example: invoke llm-task

Prereqs:

- `OPENCLAW_URL` points at a running OpenClaw gateway
- optionally `OPENCLAW_TOKEN` if auth is enabled

```bash
export OPENCLAW_URL=http://127.0.0.1:18789
# export OPENCLAW_TOKEN=...
```

In a workflow:

```yaml
name: hello-world
steps:
  - id: greeting
    command: >
      openclaw.invoke --tool llm-task --action json --args-json '{"prompt":"Hello"}'
```

### Passing data between steps (no temp files)

Use `stdin: $stepId.stdout` to pipe output from one step into the next.

## Args and shell-safety

`${arg}` substitution is a raw string replace into the shell command text.

For anything that may contain quotes, `$`, backticks, or newlines, prefer env vars:

- every resolved workflow arg is exposed as `LOBSTER_ARG_<NAME>` (uppercased, non-alnum → `_`)
- the full args object is also available as `LOBSTER_ARGS_JSON`

Example:

```yaml
args:
  text:
    default: ""
steps:
  - id: safe
    env:
      TEXT: "$LOBSTER_ARG_TEXT"
    command: |
      jq -n --arg text "$TEXT" '{"result": $text}'
```

## Real-world example: Daily standup with Jira and LLM

A common pattern: fetch data via shell CLI, then feed it to an LLM tool for summarization. We include a complete, documented example:

**File**: [`examples/daily-standup.lobster`](examples/daily-standup.lobster)

```yaml
name: daily-standup
description: |
  Daily standup pipeline: fetch tickets from Jira, summarize with LLM.
  Demonstrates mixing shell commands (jira, jq) with openclaw.invoke tool calls.

args:
  team:
    default: "CLAW"
    description: "Jira team/project key"
  project:
    default: "E-commerce"
    description: "Project name for filtering"
  limit:
    default: "30"
    description: "Maximum number of tickets to fetch"
  llm_prompt:
    default: "Summarize the top 10 most urgent tickets for the daily standup. Output a concise bullet list with ticket IDs and key points."
    description: "Prompt sent to the LLM"

steps:
  - id: list-tickets
    command: >
      jira issues search "project=${project} AND status=Todo" --json |
      jq -s '[.[] | {id: .key, title: .fields.summary, status: .fields.status.name, priority: .fields.priority.name, assignee: (.fields.assignee.displayName // "unassigned")] | .[0:env.LOBSTER_ARG_limit | tonumber]' 2>/dev/null
    env:
      LOBSTER_ARG_limit: "${limit}"

  - id: summarize
    command: >
      openclaw.invoke --tool llm-task --action json --args-json '{"prompt": "${llm_prompt}"}'
    stdin: $list-tickets.stdout

  - id: output
    command: >
      echo "=== Standup Summary ===" && echo && cat
    stdin: $summarize.stdout
```

Key takeaways:

- Use `stdin: $stepId.stdout` to pass data without temp files
- Access numeric/complex args via safe env vars: `env.LOBSTER_ARG_<NAME>`
- Call `openclaw.invoke` directly from any shell step
- Works both standalone and from OpenClaw cron

### Running standalone

```bash
export OPENCLAW_URL=http://127.0.0.1:18789
lobster run --file examples/daily-standup.lobster --args-json '{"project":"E-commerce","limit":20}'
```

### From OpenClaw cron

```json
{
  "action": "run",
  "pipeline": "examples/daily-standup.lobster",
  "args": { "project": "E-commerce", "limit": 20 },
  "timeoutMs": 60000
}
```

This example addresses the confusion reported in [#26](https://github.com/openclaw/lobster/issues/26) and shows a clean, maintainable way to compose shell and tool steps.
