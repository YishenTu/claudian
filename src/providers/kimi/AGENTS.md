# Kimi Code Provider

`src/providers/kimi/` adapts Moonshot Kimi Code through Agent Client Protocol over a
`kimi acp` subprocess (Kimi Code >= 0.27.0).

## Ownership

- Runtime process management, ACP transport, prompt encoding, stream
  normalization, CLI resolution, settings UI, model/mode/thinking discovery,
  auxiliary ACP queries, and Kimi-specific settings reconciliation live here.
- Shared code should consume Kimi behavior through `ChatRuntime`, provider
  capabilities, and workspace-service contracts.

## Protocol Rules

- Chat launches `[resolved kimi binary, "acp"]`.
- Live output comes from ACP session notifications and is normalized through
  `AcpSessionUpdateNormalizer`.
- Model, mode, and thought-level options come from `configOptions` on
  `session/new` / `session/load` and `config_option_update` notifications.
- Model IDs are namespaced as `kimi:<rawId>` (`KIMI_SYNTHETIC_MODEL_ID` = `kimi`
  before discovery).
- Modes map to shared permission modes in `modes.ts` (default/plan/auto/yolo).
- Claudian does not launch ACP terminal auth. JSON-RPC `-32000 Authentication
  required` must surface guidance to run `kimi login`.
- Phase 1 does not forward Claudian-managed MCP servers.
- Never mutate native Kimi history or credentials under `~/.kimi-code/`.

## Session State

- Persist `Conversation.sessionId`, `providerState.sessionId`, and
  `providerState.kimiCodeHome` for resume/hydration.
- `KIMI_CODE_HOME` overrides the data root (`~/.kimi-code` by default).
- Deleting a Claudian conversation must not delete native Kimi data.

## Capabilities

- Supported: persistent ACP runtime, native history, plan mode, provider
  commands, image attachments, instruction mode, thinking on/off effort axis.
- Not claimed: rewind, fork, managed MCP, turn steer.

## Settings

- Kimi is opt-in and disabled by default (`providerConfigs.kimi.enabled`).
- CLI resolution: host-scoped path → legacy `cliPath` → PATH / common install
  dirs (`kimi`, `kimi.exe`, `kimi.cmd`).
- Environment keys `/^KIMI_/i` and `/^MOONSHOT_/i` are provider-owned.

## Gotchas

- `KimiAuxQueryRunner` owns its own ACP process and session; it never silently
  approves tools.
- Cancel marks the process for restart (`restartRequiredAfterCancel`) for
  deterministic cleanup.
- Auxiliary prompts should not approve tools.
