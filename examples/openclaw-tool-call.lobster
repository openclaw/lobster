# OpenClaw Tool Invocation Example
# This workflow demonstrates how to call OpenClaw tools from Lobster
#
# Usage:
#   lobster run examples/openclaw-tool-call.lobster
#
# Prerequisites:
#   - OPENCLAW_URL environment variable set to your OpenClaw gateway
#   - OPENCLAW_TOKEN if auth is enabled
#   - OpenClaw gateway must be running

name: openclaw-tool-example
args:
  prompt:
    default: "Hello! What can you help me with?"

steps:
  # Method 1: Using openclaw.invoke shim (recommended)
  # This is the cleanest way to call OpenClaw tools
  - id: llm-task
    run: >
      openclaw.invoke
      --tool llm-task
      --action json
      --args-json '{"prompt": "${prompt}"}'

  # Method 2: Using the lobster pipeline command directly
  # This is equivalent but more verbose
  - id: llm-task-alt
    pipeline: >
      openclaw.invoke
      --tool llm-task
      --action json
      --args-json '{"prompt": "${prompt}"}'

  # Method 3: Using clawd.invoke alias (legacy)
  # Same as openclaw.invoke, kept for backward compatibility
  - id: llm-task-legacy
    run: >
      clawd.invoke
      --tool llm-task
      --action json
      --args-json '{"prompt": "${prompt}"}'

  # Example: Calling other OpenClaw tools
  # - id: sessions-list
  #   run: >
  #     openclaw.invoke
  #     --tool sessions.list
  #     --action json
  #     --args-json '{"limit": 5}'

  # Example: Using result from previous step
  - id: format-response
    pipeline: >
      llm.invoke
      --provider openclaw
      --prompt "Format this response nicely: ${llm-task.json}"

# Output format:
# The workflow returns an array of step results.
# Access individual step results via ${stepId.json} or ${stepId.stdout}

# Notes:
# 1. `openclaw.invoke` is a shim that forwards to lobster's pipeline command
# 2. The shim is installed when you install lobster via npm/pnpm
# 3. All OpenClaw tools are available: llm-task, sessions.list, browser.snapshot, etc.
# 4. Use --action json for structured output, --action text for plain text
