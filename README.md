# Lobster

A Moltbot-native workflow shell: typed (JSON-first) pipelines, jobs, and approval gates.


## Example of lobster at work
Moltbot or any other AI agent can use `lobster` as a workflow engine and not construct a query every time - thus saving tokens, providing room for determinism, and resumability.

### Watching a PR that hasn't had changes
```
node bin/lobster.js "workflows.run --name github.pr.monitor --args-json '{\"repo\":\"moltbot/moltbot\",\"pr\":1152}'"
[
  {
    "kind": "github.pr.monitor",
    "repo": "moltbot/moltbot",
    "prNumber": 1152,
    "key": "github.pr:moltbot/moltbot#1152",
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
      "url": "https://github.com/moltbot/moltbot/pull/1152"
    }
  }
]
```
### And a PR that has a state change (in this case an approved PR)

```
 node bin/lobster.js "workflows.run --name github.pr.monitor --args-json '{\"repo\":\"moltbot/moltbot\",\"pr\":1200}'"
[
  {
    "kind": "github.pr.monitor",
    "repo": "moltbot/moltbot",
    "prNumber": 1200,
    "key": "github.pr:moltbot/moltbot#1200",
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
          "to": "https://github.com/moltbot/moltbot/pull/1200"
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
      "url": "https://github.com/moltbot/moltbot/pull/1200"
    }
  }
]
```

## Goals


- Typed pipelines (objects/arrays), not text pipes.
- Local-first execution.
- No new auth surface: Lobster must not own OAuth/tokens.
- Composable macros that Moltbot can invoke in one step to save tokens.

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
- `approve`: approval gate (TTY prompt or `--emit` for Moltbot integration)

## Next steps

- Moltbot integration: ship as an optional Moltbot plugin tool.

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

### Step fields

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique step identifier; used to reference the step's output in subsequent steps via `$id.stdout` or `$id.json`. |
| `command` | yes (for regular steps) | Shell command to run. Mutually exclusive with `lobster`. |
| `lobster` | yes (for sub-workflow steps) | Path to a `.lobster` file to run as a sub-workflow (resolved relative to the parent workflow). Mutually exclusive with `command`. |
| `args` | no | Key/value map of input arguments passed to the sub-workflow. Values support `${arg}` and `$stepId.stdout`/`$stepId.json` template syntax. Only valid when `lobster` is set. |
| `loop` | no | Repeat the sub-workflow step in a loop. Only valid when `lobster` is set. |
| `loop.maxIterations` | yes (when `loop` is set) | Maximum number of iterations. |
| `loop.condition` | no | Shell command evaluated after each iteration. Exit code 0 continues the loop; non-zero stops it early. Receives `LOBSTER_LOOP_STDOUT`, `LOBSTER_LOOP_JSON`, and `LOBSTER_LOOP_ITERATION` as environment variables. |
| `stdin` | no | Pass a previous step's output as stdin. |
| `approval` | no | Set to `required` to insert an approval gate before the step runs. |
| `condition` | no | Expression that must be truthy for the step to run. |

### Sub-workflow step example

Use the `lobster` field to embed another `.lobster` file as a step in your workflow, optionally passing arguments and looping until a condition is met:

```yaml
steps:
  - id: prepare
    command: echo "hello"

  - id: process
    lobster: ./sub_workflow.lobster
    args:
      input: $prepare.stdout
    loop:
      maxIterations: 10
      condition: '! echo "$LOBSTER_LOOP_STDOUT" | grep -q "^done"'
```

The sub-workflow's last step result (stdout/json) is stored as the step result and is accessible via `$process.stdout` / `$process.json` in subsequent steps.
