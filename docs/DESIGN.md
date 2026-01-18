# Lobster design (draft)

## What Lobster is

Lobster is a Clawdbot-native workflow shell.

- JSON-first typed pipelines (records/arrays) instead of byte streams.
- Deterministic composition of tools/skills into reusable macros.
- Human-in-the-loop approval gates as language primitives.
- Local-first: Lobster should talk to a local Clawdbot runtime and/or local CLIs.

## What Lobster is not

- Not a terminal emulator.
- Not a POSIX-compatible shell (at least initially).
- Not an auth broker: Lobster must not store OAuth tokens.

## Why it exists

- Turns multi-step tool orchestration into a single `lobster.run(...)` call.
- Saves tokens by moving deterministic orchestration out of the LLM.
- Makes automation auditable and safe-by-default.

## Data model

- A pipeline is a list of stages.
- Each stage consumes an async stream of items and produces an async stream.
- Items are arbitrary JSON values, but common shapes should be standardized (e.g. EmailMessage).

## Safety model

- Commands declare capabilities (e.g. `email.read`, `email.send`, `fs.write`).
- Approval gates must fail closed in non-interactive mode.
- When integrated into Clawdbot, approvals are surfaced to the user by Clawdbot.

## Clawdbot integration (target)

Preferred: Lobster does not run `gog` directly. Instead it calls Clawdbot tools.

- Clawdbot exposes `gog` (or `google`) as a tool.
- Lobster calls `tools.invoke({ tool: 'gog', action: 'gmail.search', ...})`.

In the MVP, `gog.gmail.search` shells out to `gog` for fast iteration.

## MVP scope

- Parser for `cmd ... | cmd ...` pipelines.
- A minimal standard library (where/pick/head/json/table).
- An interactive `approve` primitive.
- A first Gmail read primitive via `gog.gmail.search`.

## Next milestones

1. `email.normalize`: normalize gog output to `EmailMessage`.
2. `email.triage`: classify + draft + propose label actions.
3. Non-interactive approvals: emit `requiresApproval` objects instead of prompting.
4. Clawdbot tool bridge: replace `gog` exec with tool invocation.
