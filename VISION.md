# Lobster

Lobster executes repeatable workflows for OpenClaw. The host chooses a workflow, presents requests for approval or structured input, and resumes with the user's decision. Lobster owns deterministic execution and saved continuation state.

## Responsibilities

- Compose JSON pipelines and workflow files with shell commands, native stages, conditions, loops, and parallel branches.
- Pause at explicit approval or input gates and return a continuation token.
- Persist snapshots and resume state locally, with atomic publication and cancellation-aware cleanup.
- Report estimated LLM spend and enforce configured workflow cost limits.

Approvals are explicit workflow steps. They protect actions placed after the gate; they are not an automatic sandbox for arbitrary shell commands or tool calls. Workflow authors must put gates before actions that require user consent.

## Host boundary

OpenClaw owns intent, user interaction, authentication, provider integration, and tool execution policy. Lobster orchestrates those capabilities. It does not own OAuth or a credential store.

The intended inference direction is gateway-only, as recorded in [#135](https://github.com/openclaw/lobster/issues/135). Current releases still support OpenClaw, Pi, HTTP, and injected adapters. The gateway contract and compatibility window must be settled before those configurations are retired; no new vendor adapters belong in the engine.

Lobster currently renders static workflow graphs in Mermaid, DOT, and ASCII. A live dashboard and retained run history are separate product decisions, tracked in [#163](https://github.com/openclaw/lobster/issues/163).

## Use

Use a direct tool call for a one-off action. Use Lobster when a sequence is repeatable, needs saved state, or includes a human checkpoint. Deterministic steps avoid repeatedly asking a model to reconstruct the same execution sequence; model calls remain explicit stages where judgment is needed.

See the [README](README.md) for working commands, workflow syntax, cancellation, output limits, and SDK examples.
