# Basic LLM Invocation Example
# This workflow demonstrates how to call an LLM from a Lobster workflow
#
# Usage:
#   lobster run examples/llm-basic.lobster --args-json '{"text":"Hello, world!"}'
#
# Prerequisites:
#   - OPENCLAW_URL environment variable set to your OpenClaw gateway
#   - Optionally: OPENCLAW_TOKEN if auth is enabled

name: llm-basic-example
args:
  text:
    default: "Summarize this text"
  model:
    default: "claude-3-sonnet"

steps:
  # Step 1: Call LLM to process the input text
  - id: summarize
    pipeline: >
      llm.invoke
      --provider openclaw
      --model ${model}
      --prompt "Please summarize the following text concisely: ${text}"
    # Note: pipeline steps automatically capture output as .json and .stdout

  # Step 2: Format the result
  - id: format
    pipeline: >
      llm.invoke
      --provider openclaw
      --prompt "Format this summary as a bullet list: ${summarize.json}"

# Output: The final step's output is returned as the workflow result
# Access via: ${format.json} or ${format.stdout}
