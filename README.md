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

### Prerequisites

- `OPENCLAW_URL` points at a running OpenClaw gateway
- optionally `OPENCLAW_TOKEN` if auth is enabled

```bash
export OPENCLAW_URL=http://127.0.0.1:18789
# export OPENCLAW_TOKEN=...
```

### openclaw.invoke — Call any OpenClaw tool

The `openclaw.invoke` command calls any OpenClaw tool with typed arguments.

**Basic syntax:**
```bash
openclaw.invoke --tool <tool-name> --action <action> --args-json '<json-args>'
```

**Example: Send a message via OpenClaw**
```yaml
name: send-notification
steps:
  - id: notify
    command: >
      openclaw.invoke --tool message --action send --args-json '{"provider":"discord","channel":"alerts","message":"Build completed!"}'
```

**Example: List Discord channels**
```yaml
name: list-channels
steps:
  - id: list
    command: >
      openclaw.invoke --tool message --action channel-list --args-json '{"guildId":"123456789"}'
```

**Using --each to process pipeline items:**
```yaml
name: broadcast
steps:
  - id: users
    command: echo '[{"user":"alice"},{"user":"bob"}]'
  - id: notify-each
    command: >
      openclaw.invoke --tool message --action send --each --item-key to --args-json '{"provider":"discord","message":"Hello!"}'
    stdin: $users.stdout
```

### Calling the LLM task tool via openclaw.invoke

Use `openclaw.invoke` with `--tool llm_task` (or your configured LLM tool name) to call the LLM:

**Example: Simple LLM call in a workflow**
```yaml
name: daily-summary
args:
  topic:
    default: "project updates"
steps:
  - id: generate
    command: >
      openclaw.invoke --tool llm_task --action invoke --args-json '{"prompt":"Write a brief summary of today'"'"'s project updates"}'
```

**Example: LLM with structured output (JSON schema)**
```yaml
name: classify-tickets
steps:
  - id: classify
    command: >
      openclaw.invoke --tool llm_task --action invoke --args-json '{"prompt":"Classify this feedback as positive, negative, or neutral","output_schema":{"type":"object","required":["sentiment"],"properties":{"sentiment":{"type":"string","enum":["positive","negative","neutral"]}}}}'
```

**Example: LLM with input artifacts**
```yaml
name: summarize-article
args:
  article:
    default: ""
steps:
  - id: prepare
    env:
      ARTICLE: "$LOBSTER_ARG_ARTICLE"
    command: |
      jq -n --arg text "$ARTICLE" '{"kind":"text","text":$text}'
  - id: summarize
    command: >
      openclaw.invoke --tool llm_task --action invoke --args-json '{"prompt":"Summarize this article in 3 bullet points"}'
    stdin: $prepare.stdout
```

**Example: Daily standup with Jira tickets (from issue #26)**
```yaml
name: daily-standup
args:
  team:
    default: "CLAW"
  project:
    default: "E-commerce"
  limit:
    default: "10"

steps:
  - id: list-tickets
    command: >
      jira issues search "" --status Todo 2>/dev/null |
      jq -s '[.[][] | {id: .identifier, title, status: .state.name, priority: .priority, assignee: (.assignee.name // "unassigned")}] | sort_by(.priority) | .[:20]'

  - id: summarize
    env:
      TEAM: "$LOBSTER_ARG_TEAM"
      PROJECT: "$LOBSTER_ARG_PROJECT"
      LIMIT: "$LOBSTER_ARG_LIMIT"
    command: >
      jq -n --argjson tickets "$cat" --arg team "$TEAM" --arg project "$PROJECT" --arg limit "$LIMIT" '{"prompt":("Summarize the top " + $limit + " most urgent tickets for the daily standup. Team: " + $team + ", Project: " + $project),"context":$tickets}' |
      openclaw.invoke --tool llm_task --action invoke --args-json @/dev/stdin
    stdin: $list-tickets.stdout
```

### Passing data between steps (no temp files)

Use `stdin: $stepId.stdout` to pipe output from one step into the next:

```yaml
steps:
  - id: fetch
    command: curl -s https://api.example.com/data
  - id: transform
    command: jq '.items'
    stdin: $fetch.stdout  # Pipe previous step's output to stdin
  - id: analyze
    command: openclaw.invoke --tool llm_task --action invoke --args-json '{"prompt":"Analyze this data"}'
    stdin: $transform.stdout  # Chain multiple steps
```

Access JSON output with `$stepId.json`:
```yaml
steps:
  - id: parse
    command: echo '{"count": 42}'
  - id: report
    command: |
      COUNT=$(echo '$parse.json' | jq -r '.count')
      openclaw.invoke --tool llm_task --action invoke --args-json "{\"prompt\":\"The count is $COUNT. Write a brief status report.\"}"
```

### Accessing workflow arguments safely

For shell-safe argument handling, use environment variables:

```yaml
args:
  text:
    default: ""
  user:
    default: "unknown"
steps:
  - id: safe
    env:
      TEXT: "$LOBSTER_ARG_TEXT"
      USER: "$LOBSTER_ARG_USER"
    command: |
      # Use jq to safely JSON-escape arguments before passing to --args-json
      ARGS=$(jq -n --arg text "$TEXT" --arg user "$USER" '{"prompt":("Process this: " + $text + " for user " + $user)}')
      openclaw.invoke --tool llm_task --action invoke --args-json "$ARGS"
```

## Cookbook: Common Patterns

### Pattern 1: Fetch → LLM → Notify

```yaml
name: fetch-analyze-notify
args:
  url:
    default: "https://api.example.com/news"
  channel:
    default: "general"
steps:
  - id: fetch
    command: curl -s "$LOBSTER_ARG_URL"

  - id: analyze
    command: >
      openclaw.invoke --tool llm_task --action invoke --args-json '{"prompt":"Summarize this content in 3 key points"}'
    stdin: $fetch.stdout

  - id: notify
    env:
      CHANNEL: "$LOBSTER_ARG_CHANNEL"
    command: |
      # Use jq to safely JSON-escape the LLM output
      MSG=$(cat)
      PAYLOAD=$(jq -n --arg msg "$MSG" --arg channel "$CHANNEL" '{"provider":"discord","channel":$channel,"message":$msg}')
      openclaw.invoke --tool message --action send --args-json "$PAYLOAD"
    stdin: $analyze.stdout
```

### Pattern 2: Approval workflow with LLM recommendation

```yaml
name: approve-with-llm
steps:
  - id: gather
    command: echo '{"amount": 5000, "requester": "alice", "reason": "New equipment"}'

  - id: recommend
    command: >
      openclaw.invoke --tool llm_task --action invoke --args-json '{"prompt":"Should this expense request be approved? Answer yes or no with a brief reason."}'
    stdin: $gather.stdout

  - id: approve
    command: >
      echo '{"requiresApproval":{"prompt":"Approve expense based on LLM recommendation?","items":[]}}'
    stdin: $recommend.stdout
    approval: required

  - id: finalize
    command: echo "Expense processed"
    condition: $approve.approved
```

### Pattern 3: Batch processing with --each

```yaml
name: batch-translate
args:
  texts:
    default: '["Hello", "Goodbye", "Thank you"]'
  target_lang:
    default: "Spanish"
steps:
  - id: prepare-items
    command: echo "$LOBSTER_ARG_TEXTS"

  - id: translate-all
    env:
      TARGET_LANG: "$LOBSTER_ARG_TARGET_LANG"
    command: |
      openclaw.invoke --tool llm_task --action invoke --each --item-key text --args-json "{\"prompt\":\"Translate to $TARGET_LANG:\"}"
    stdin: $prepare-items.stdout
```

### Pattern 4: Conditional steps based on LLM output

Lobster conditions only support `true`/`false` literals or `$<stepId>.approved|skipped`. For complex conditional logic, use the approval mechanism:

```yaml
name: smart-router
steps:
  - id: classify
    command: >
      openclaw.invoke --tool llm_task --action invoke --args-json '{"prompt":"Classify this message as urgent or normal. Reply with ONLY the word urgent or normal.","output_schema":{"type":"object","required":["priority"],"properties":{"priority":{"type":"string"}}}}'

  - id: route
    env:
      PRIORITY: "$classify.json.priority"
    command: |
      PRIORITY=$(echo '$classify.json' | jq -r '.priority // "normal"')
      if [ "$PRIORITY" = "urgent" ]; then
        echo '{"requiresApproval":{"prompt":"Urgent item detected! Send to urgent channel?","items":[]}}'
      else
        echo "Added to normal queue"
      fi
    approval: required

  - id: handle-urgent
    command: openclaw.invoke --tool message --action send --args-json '{"provider":"discord","channel":"urgent","message":"Urgent item detected!"}'
    condition: $route.approved
```

**Note:** For more complex branching, consider using separate workflows or shell logic within a single step.

### Pattern 5: Retry with different models

```yaml
name: robust-llm-call
steps:
  - id: try-primary
    command: |
      openclaw.invoke --tool llm_task --action invoke --args-json '{"model":"claude-3-opus","prompt":"Complex analysis task"}' || echo '{"error": true}'

  - id: check-error
    command: |
      if echo '$try-primary.json' | jq -e '.error' > /dev/null 2>&1; then
        echo '{"requiresApproval":{"prompt":"Primary model failed. Retry with fallback model?","items":[]}}'
      else
        echo '{"success": true}'
      fi
    approval: required

  - id: fallback
    command: >
      openclaw.invoke --tool llm_task --action invoke --args-json '{"model":"claude-3-sonnet","prompt":"Complex analysis task"}'
    condition: $check-error.approved
```

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
