# Grok Provider

`src/providers/grok/` adapts xAI Grok Build through Agent Client Protocol over a
`grok agent … stdio` subprocess.

## Ownership

- Runtime process management, ACP transport, prompt encoding, stream
  normalization, headless auxiliary queries, JSONL history hydration, CLI
  resolution, settings UI, and Grok-specific settings reconciliation live here.
- Shared code should consume Grok behavior through `ChatRuntime`, provider
  capabilities, and workspace-service contracts.

## Protocol Rules

- Chat launches `grok agent [-m MODEL] [--reasoning-effort EFFORT] [--always-approve] stdio`.
- Plan mode is applied via ACP `session/set_mode` with `modeId: "plan"` or
  `"default"` (normal/yolo). Launch key tracks `yolo` only for process restart;
  plan↔normal uses `setMode` without restarting. YOLO still uses launch
  `--always-approve`.
- Safe sandbox maps to `GROK_SANDBOX` in the process environment when the user
  did not set it; `grok agent` has no `--sandbox` flag. Changing sandbox restarts
  the ACP process (launch key includes `safeMode`). It constrains Grok agent
  tools only — not Claudian ACP client filesystem access.
- Live output comes from ACP session notifications and is normalized through
  `AcpSessionUpdateNormalizer`.
- Headless auxiliary work (title generation, instruction refine, inline edit)
  uses the main CLI with `--output-format streaming-json` and
  `--prompt-file`. Do not use `grok agent headless` (WebSocket relay) for those
  calls.
- History hydration reads Grok-native
  `<grokHome>/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl`. Persist
  resolved `providerState.grokHome` so Claudian-configured `GROK_HOME` matches
  the runtime. Never mutate native history from Claudian.

## Session State

- Persist `Conversation.sessionId`, `providerState.sessionId`, and
  `providerState.grokHome` for resume/hydration.
- `GROK_HOME` overrides the session root (`~/.grok` by default); resolve from
  providerState first, then settings/process env.
- Environment keys that affect Grok data or model selection should invalidate
  sessions via `GrokSettingsReconciler` (`GROK_HOME`, model keys, API keys).

## Capabilities (conservative)

- Supported: persistent ACP runtime, native history, plan mode, effort control,
  instruction mode.
- Not claimed: rewind, fork, image attachments, Claudian-managed MCP tools,
  provider command catalogs, turn steer.

## Settings

- Grok is opt-in and disabled by default (`providerConfigs.grok.enabled`).
- Safe-mode sandbox profiles are Grok-native: `workspace` and `read-only`
  (legacy `workspace-write` normalizes to `workspace`).
- CLI resolution order: host-scoped path → legacy `cliPath` → PATH /
  `~/.grok/bin` / `~/.local/bin`.
- Environment keys `/^GROK_/i` and `/^XAI_/i` are provider-owned. Trace upload is
  disabled by default (`GROK_TELEMETRY_TRACE_UPLOAD=0`) unless explicitly set.

## Gotchas

- `GrokAuxQueryRunner` owns its own headless process and is independent from the
  chat runtime.
- Model/effort defaults follow Grok Build 0.2.99 (`grok-4.5`, efforts
  low/medium/high). Prefer runtime discovery over hardcoding new models later.
- File read/write ACP delegates resolve relative paths against the session cwd
  (vault path).
