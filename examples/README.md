# Lobster Examples

This directory contains example Lobster workflow files demonstrating common patterns.

## Quick Start

```bash
# Install dependencies
pnpm install

# Set up OpenClaw connection
export OPENCLAW_URL=http://127.0.0.1:18789
# export OPENCLAW_TOKEN=your-token  # if auth is enabled

# Run an example
lobster run examples/llm-basic.lobster --args-json '{"text":"Hello world"}'
```

## Examples

### 1. Basic LLM Invocation (`llm-basic.lobster`)

Demonstrates the simplest way to call an LLM from a workflow.

```bash
lobster run examples/llm-basic.lobster --args-json '{"text":"Summarize this article..."}'
```

**Key concepts:**
- `pipeline:` for native Lobster commands like `llm.invoke`
- Provider selection (`--provider openclaw`)
- Output capture (`.json` and `.stdout`)

### 2. LLM with Human Approval (`llm-with-approval.lobster`)

Shows how to add a human checkpoint before expensive operations.

```bash
lobster run examples/llm-with-approval.lobster --args-json '{"query":"What is...?","costly":true}'
```

**Key concepts:**
- `approval:` for human gates
- `when:` for conditional execution
- Ternary expressions in conditions

### 3. OpenClaw Tool Invocation (`openclaw-tool-call.lobster`)

Demonstrates three methods to call OpenClaw tools:

```bash
lobster run examples/openclaw-tool-call.lobster --args-json '{"prompt":"Hello!"}'
```

**Methods:**
1. `openclaw.invoke` - Recommended shim executable
2. `lobster pipeline` - Direct pipeline command
3. `clawd.invoke` - Legacy alias

**Key concepts:**
- `--tool` to specify the OpenClaw tool
- `--action json` for structured output
- `--args-json` for tool arguments

### 4. Data Pipeline (`data-pipeline.lobster`)

Shows data passing between steps without temp files.

```bash
lobster run examples/data-pipeline.lobster --args-json '{"items":["apple","banana","cherry"]}'
```

**Key concepts:**
- `${stepId.json}` - Access JSON output
- `${stepId.stdout}` - Access raw stdout
- `stdin: $stepId.json` - Pipe data directly
- `env:` - Environment variables for shell safety

## Common Patterns

### Calling LLMs

```yaml
# Simple LLM call
- id: summarize
  pipeline: >
    llm.invoke
    --provider openclaw
    --prompt "Summarize: ${text}"

# LLM with specific model
- id: analyze
  pipeline: >
    llm.invoke
    --provider openclaw
    --model claude-3-sonnet
    --prompt "Analyze: ${data.json}"
```

### Calling OpenClaw Tools

```yaml
# Using openclaw.invoke shim
- id: task
  run: >
    openclaw.invoke
    --tool llm-task
    --action json
    --args-json '{"prompt":"Hello"}'

# Using sessions.list
- id: sessions
  run: >
    openclaw.invoke
    --tool sessions.list
    --action json
    --args-json '{"limit":10}'
```

### Passing Data Between Steps

```yaml
# Method 1: Variable substitution
- id: step1
  run: echo '{"data":"value"}' | json

- id: step2
  run: echo '${step1.json}' | jq '.data'

# Method 2: stdin pipe
- id: step2
  stdin: $step1.json
  run: jq '.data'

# Method 3: Environment variables (safest)
- id: step2
  env:
    DATA: "$LOBSTER_ARG_INPUT"
  run: echo "$DATA" | jq '.'
```

### Conditional Execution

```yaml
# Simple condition
- id: notify
  run: echo "Sending notification"
  when: $approval.approved

# Ternary expression
- id: process
  run: echo "Processing"
  when: $costly ? $approval.approved : true

# Complex condition
- id: cleanup
  run: rm -rf /tmp/cache
  when: $status.json.success && $config.json.autoCleanup
```

### Human Approval Gates

```yaml
# Simple approval
- id: confirm
  approval: "Proceed with deletion?"

# Approval with context
- id: review
  approval: |
    About to execute:
    - Files: ${files.json.length}
    - Size: ${size.json}MB
    Proceed?
  stdin: $data.json
```

## Troubleshooting

### "openclaw.invoke: command not found"

Make sure lobster is installed globally:

```bash
npm install -g @openclaw/lobster
# or
pnpm add -g @openclaw/lobster
```

### "OPENCLAW_URL not set"

Set the environment variable:

```bash
export OPENCLAW_URL=http://127.0.0.1:18789
```

### LLM calls failing

1. Check that OpenClaw gateway is running: `openclaw gateway status`
2. Verify the URL is correct
3. Check token if auth is enabled

### Data not passing between steps

1. Ensure step IDs are unique
2. Use `${stepId.json}` for JSON output
3. For special characters, use `env:` instead of `${}` substitution

## See Also

- [Main README](../README.md) - Lobster overview and quick start
- [VISION.md](../VISION.md) - Lobster design goals
- [OpenClaw Docs](https://github.com/openclaw/openclaw) - OpenClaw integration
