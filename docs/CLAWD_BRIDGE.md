# Clawd bridge contract (draft)

This document defines the **local-only HTTP contract** Lobster expects from a running `clawd`/Clawdbot instance.

Goals:
- Lobster stays a **pure client**.
- No OAuth/token handling in Lobster.
- Auth is **piggy-backed** on Clawdbot’s existing local auth model.

## Transport

- Base URL: `CLAWD_URL` (e.g. `http://127.0.0.1:xxxx`)
- All requests are JSON.

## Auth

- Optional `Authorization: Bearer <token>`
- Token source for Lobster:
  - `CLAWD_TOKEN` env var
  - (future) `clawd auth print-token` or a local token file owned by clawd

Lobster **must not** store or mint credentials.

## Endpoint: POST `/tools/invoke`

Invokes a tool action with structured args.

**Request body**
```json
{
  "tool": "message",
  "action": "send",
  "args": { "provider": "telegram", "to": "@me", "message": "hi" },
  "sessionKey": "optional-session-key",
  "dryRun": false
}
```

- `tool` and `action` are required strings.
- `args` is an arbitrary JSON object.
- `sessionKey` is optional (lets clawd attribute actions to a session).
- `dryRun` is optional; if true, tool should not perform side-effects.

**Response body (preferred)**
```json
{
  "ok": true,
  "result": { "...": "tool-specific" }
}
```

**Response body (error)**
```json
{
  "ok": false,
  "error": {
    "type": "permission_denied",
    "message": "..."
  }
}
```

**Compatibility**
Lobster also accepts the legacy shape where the endpoint returns `result` directly (array/object) instead of the `{ok,result}` envelope.

## Why this matters

This endpoint lets Lobster implement:
- skill/tool pipelines without spawning local CLIs
- safe approvals (clawd can gate side effects)
- token savings (clawd can call `lobster.run` once and let Lobster orchestrate)
