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

## Examples

Check out the [`examples/`](examples/) directory for ready-to-run workflow files:

- **llm-basic.lobster** - Simple LLM invocation
- **llm-with-approval.lobster** - LLM calls with human approval gates
- **openclaw-tool-call.lobster** - Calling OpenClaw tools (llm-task, sessions.list, etc.)
- **data-pipeline.lobster** - Data passing between steps without temp files

```bash
# Run an example
lobster run examples/llm-basic.lobster --args-json '{"text":"Hello world"}'

# See all examples
ls examples/*.lobster
```

See [examples/README.md](examples/README.md) for detailed documentation and common patterns.

## Commands

- `exec`: run OS commands
- `exec --stdin raw|json|jsonl`: feed pipeline input into subprocess stdin
- `where`, `pick`, `head`: data shaping
- `json`, `table`: renderers
- `approve`: approval gate (TTY prompt or `--emit` for OpenClaw integration)

## Next steps

- OpenClaw integration: ship as an optional OpenClaw plugin tool.

## Workflow files

Lobster workflow files are meant to read like small scripts:

- `run:` or `command:` for deterministic shell/CLI steps
- `pipeline:` for native Lobster stages like `llm.invoke`
- `approval:` for hard workflow gates between steps
- `stdin: $step.stdout` or `stdin: $step.json` to pass data forward

```
lobster run path/to/workflow.lobster
lobster run --file path/to/workflow.lobster --args-json '{"tag":"family"}'
```

Example file:

```yaml
name: jacket-advice
args:
  location:
    default: Phoenix
steps:
  - id: fetch
    run: weather --json ${location}

  - id: confirm
    approval: Want jacket advice from the LLM?
    stdin: $fetch.json

  - id: advice
    pipeline: >
      llm.invoke --prompt "Given this weather data, should I wear a jacket?
      Be concise and return JSON."
    stdin: $fetch.json
    when: $confirm.approved
```

Notes:

- `run:` and `command:` are equivalent; `run:` is the preferred spelling for new files.
- `pipeline:` shares the same args/env/results model as shell steps, so later steps can still reference `$step.stdout` or `$step.json`.
- If you need a human checkpoint before an LLM call, use a dedicated `approval:` step in the workflow file rather than `approve` inside the nested pipeline.
- `cwd`, `env`, `stdin`, `when`, and `condition` work for both shell and pipeline steps.

## Calling LLMs from workflows

Use `llm.invoke` from a native `pipeline:` step for model-backed work:

```bash
llm.invoke --prompt 'Summarize this diff'
llm.invoke --provider openclaw --prompt 'Summarize this diff'
llm.invoke --provider pi --prompt 'Summarize this diff'
```

### In a workflow file

```yaml
name: summarize
args:
  text:
    default: "Some text to summarize"

steps:
  - id: summary
    pipeline: >
      llm.invoke
      --provider openclaw
      --model claude-3-sonnet
      --prompt "Summarize concisely: ${text}"

  - id: formatted
    pipeline: >
      llm.invoke
      --provider openclaw
      --prompt "Format as bullet points: ${summary.json}"
```

### Provider resolution order

1. `--provider` flag (explicit)
2. `LOBSTER_LLM_PROVIDER` environment variable
3. Auto-detect from environment

### Built-in providers

- **`openclaw`** via `OPENCLAW_URL` / `OPENCLAW_TOKEN`
- **`pi`** via `LOBSTER_PI_LLM_ADAPTER_URL` (typically supplied by the Pi extension)
- **`http`** via `LOBSTER_LLM_ADAPTER_URL`

> **Note:** `llm_task.invoke` remains available as a backward-compatible alias for the OpenClaw provider, but `llm.invoke` is preferred for new workflows.

### Common patterns

```yaml
# Simple call
- id: answer
  pipeline: llm.invoke --prompt "${question}"

# With specific model
- id: analyze
  pipeline: llm.invoke --model claude-3-sonnet --prompt "${data}"

# With output schema
- id: structured
  pipeline: >
    llm.invoke
    --prompt "Extract entities"
    --output-schema '{"type":"object","required":["name","date"]}'

# Conditional LLM call
- id: ai-enhance
  pipeline: llm.invoke --prompt "Enhance: ${draft.json}"
  when: $config.json.useAI
```

## Calling OpenClaw tools from workflows

Shell `run:` steps execute in your system shell, so OpenClaw tool calls there must be real executables.

If you install Lobster via npm/pnpm, it installs shim executables:

- **`openclaw.invoke`** (preferred)
- **`clawd.invoke`** (alias for backward compatibility)

These shims forward to the Lobster pipeline command of the same name.

### Prerequisites

```bash
# Set OpenClaw gateway URL
export OPENCLAW_URL=http://127.0.0.1:18789

# Set token if auth is enabled
export OPENCLAW_TOKEN=your-gateway-token
```

### Method 1: Using openclaw.invoke (recommended)

```yaml
name: hello-world
steps:
  - id: greeting
    run: >
      openclaw.invoke
      --tool llm-task
      --action json
      --args-json '{"prompt":"Hello"}'
```

### Method 2: Using lobster pipeline directly

```yaml
name: hello-world
steps:
  - id: greeting
    pipeline: >
      openclaw.invoke
      --tool llm-task
      --action json
      --args-json '{"prompt":"Hello"}'
```

### Available OpenClaw tools

All OpenClaw tools are available:

```bash
# LLM tasks
openclaw.invoke --tool llm-task --args-json '{"prompt":"..."}'

# Session management
openclaw.invoke --tool sessions.list --args-json '{"limit":10}'
openclaw.invoke --tool sessions.send --args-json '{"sessionKey":"...","message":"..."}'

# Browser control
openclaw.invoke --tool browser.snapshot --args-json '{"action":"snapshot"}'

# And more: cron, message, gateway, nodes, etc.
```

### Complete example: LLM + Session

```yaml
name: summarize-and-send
args:
  sessionKey:
    default: "main"
  text:
    default: "Summarize this"

steps:
  # Step 1: Call LLM to summarize
  - id: summary
    run: >
      openclaw.invoke
      --tool llm-task
      --action json
      --args-json '{"prompt":"Summarize: ${text}"}'

  # Step 2: Send result to session
  - id: notify
    run: >
      openclaw.invoke
      --tool sessions.send
      --action json
      --args-json '{"sessionKey":"${sessionKey}","message":"${summary.json}"}'
```

### Passing data between steps (no temp files)

Use `stdin: $stepId.stdout` or `${stepId.json}` to pipe data between steps:

```yaml
steps:
  - id: fetch
    run: curl -s https://api.example.com/data | json

  - id: process
    stdin: $fetch.json
    run: jq '.items[]'

  - id: summarize
    pipeline: >
      llm.invoke
      --prompt "Summarize: ${process.json}"
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
