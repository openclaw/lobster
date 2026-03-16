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
      # Ensure numeric limit is passed safely via env var
      LOBSTER_ARG_limit: "${limit}"

  - id: summarize
    command: >
      openclaw.invoke --tool llm-task --action json --args-json '{"prompt": "${llm_prompt}"}'
    stdin: $list-tickets.stdout
    # Pass the list of tickets as JSON via stdin to the LLM task

  - id: output
    command: >
      echo "=== Standup Summary ===" && echo && cat
    stdin: $summarize.stdout

# Notes:
# - This workflow expects `jira` CLI to be installed and configured.
# - OPENCLAW_URL and optionally OPENCLAW_TOKEN must be set in the environment.
# - The `openclaw.invoke` shim is installed with Lobster and calls the llm-task tool.
# - Data is passed between steps using stdin, avoiding temporary files.
# - To run manually:
#     lobster run --file examples/daily-standup.lobster --args-json '{"project":"E-commerce","limit":20}'
# - To run from OpenClaw cron:
#     {action:"run", pipeline:"examples/daily-standup.lobster", args:{"project":"E-commerce"}, timeoutMs:60000}
