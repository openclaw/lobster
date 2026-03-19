# Data Pipeline Example
# This workflow demonstrates data passing between steps without temp files
#
# Usage:
#   lobster run examples/data-pipeline.lobster --args-json '{"items":["apple","banana","cherry"]}'

name: data-pipeline-example
args:
  items:
    default: ["item1", "item2", "item3"]

steps:
  # Step 1: Create initial data
  - id: init
    run: >
      echo '${items}' | json

  # Step 2: Filter data (keep items with length > 5)
  - id: filtered
    run: >
      echo '${init.json}' | jq '[.[] | select(length > 5)]'

  # Step 3: Transform data (add prefix)
  - id: transformed
    pipeline: >
      llm.invoke
      --provider openclaw
      --prompt "Add a descriptive prefix to each item in this list: ${filtered.json}. Return as JSON array."

  # Step 4: Pass to LLM for analysis
  - id: analyze
    pipeline: >
      llm.invoke
      --provider openclaw
      --prompt "Analyze this data and provide insights: ${transformed.json}"

  # Step 5: Format final output
  - id: final
    run: >
      echo '{"original": ${init.json}, "filtered": ${filtered.json}, "transformed": ${transformed.json}, "analysis": "${analyze.stdout}"}' | json

# Data passing patterns demonstrated:
# 1. ${stepId.json} - Access JSON output from previous step
# 2. ${stepId.stdout} - Access raw stdout from previous step
# 3. stdin: $stepId.json - Pipe JSON directly to next step's stdin
# 4. env: variables - Pass data via environment variables for shell safety

# Alternative: Using stdin for data passing
# - id: process
#   stdin: $init.json
#   run: jq '.[]'  # Reads from stdin

# Alternative: Using environment variables (safer for special characters)
# - id: safe-process
#   env:
#     DATA: "$LOBSTER_ARG_ITEMS"
#   run: echo "$DATA" | jq '.'
