# Hermes Provider

Hermes Agent (Nous Research) provider — uses ACP (Agent Client Protocol) over stdio via the shared `src/providers/acp/` infrastructure.

## Runtime

- `HermesChatRuntime` wraps `AcpClientConnection` from shared ACP layer
- Spawns `hermes acp` as a subprocess via `AcpSubprocess`
- Maps ACP `session/update` notifications to Claudian `StreamChunk` types
- Session management: `session/new`, `session/load`, `session/cancel`
- Permission handling via ACP `session/request_permission`

## History

- Reads directly from Hermes SQLite database at `~/.hermes/state.db`
- Schema version 11: `sessions` and `messages` tables
- Session IDs: `YYYYMMDD_HHMMSS_<hex_suffix>` format

## Models

- Hermes supports 30+ model providers (Anthropic, OpenRouter, Nous Portal, etc.)
- Model IDs use `provider/model` format via aggregators
- Config at `~/.hermes/config.yaml` with `model.default` and `model.provider`

## Dependencies

- Shared ACP infrastructure: `src/providers/acp/`
- Follows OpenCode provider pattern (also ACP-based)
