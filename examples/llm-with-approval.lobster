# LLM with Human Approval Example
# This workflow shows how to add a human checkpoint before calling an LLM
#
# Usage:
#   lobster run examples/llm-with-approval.lobster --args-json '{"query":"What is the weather?","costly":true}'
#
# The workflow will pause and ask for approval before running the expensive LLM call

name: llm-with-approval
args:
  query:
    default: "Answer this question"
  costly:
    default: false

steps:
  # Step 1: Check if approval is needed
  - id: check-cost
    run: >
      echo '{"needsApproval": ${costly}}' | json

  # Step 2: Request approval if the operation is costly
  - id: approval
    approval: "About to run an LLM query. Proceed?"
    when: $check-cost.json.needsApproval
    # If costly=false, this step is skipped and approval.approved is treated as true

  # Step 3: Call LLM (only if approved or not costly)
  - id: answer
    pipeline: >
      llm.invoke
      --provider openclaw
      --prompt "${query}"
    when: $check-cost.json.needsApproval ? $approval.approved : true
    # Ternary condition: if costly, check approval; otherwise always run

  # Step 4: Format output
  - id: output
    run: >
      echo '{"query": "${query}", "answer": "${answer.stdout}"}' | json

# Key concepts demonstrated:
# 1. Conditional step execution with `when:`
# 2. Human approval gates with `approval:`
# 3. Pipeline steps for LLM calls
# 4. Data passing between steps via ${stepId.json} and ${stepId.stdout}
