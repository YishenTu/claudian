# Cursor Provider

Adaptor for the headless **Cursor CLI** (`cursor-agent`). Opt-in (`enabled: false` by default), local-only, modeled on the Codex provider's CLI subprocess pattern.

## Status

Phase 2 (current): real runtime + streaming. `cursor-agent create-chat` is invoked once per conversation to mint a chat id, then every turn spawns `cursor-agent --print --output-format stream-json --stream-partial-output --force --resume <id> [--model <id>] [--workspace <cwd>] "<prompt>"`. The NDJSON event stream is parsed by `CursorEventTransport` and translated to provider-neutral `StreamChunk`s by `cursorEventNormalization`. Auxiliary services (title, instruction refine, inline edit) share the same one-shot mechanism via `CursorAuxQueryRunner`.

## Phased Rollout

| Phase | Status | Scope |
|-------|--------|-------|
| 1 | done | Skeleton + registration + opt-in toggle |
| 2 | done | Real `cursor-agent` subprocess wrapper, NDJSON transport, prompt encoder, stream normalization, env/settings reconciler |
| 3 | next | Settings UX polish, integration test fixtures, end-to-end test harness |
| 4 | later | History reload, fork, plan mode, images, instruction mode, MCP, commands, skills, subagents, rewind |

## Runtime model

- `CursorChatRuntime` keeps no persistent process between turns. Each turn spawns a fresh `cursor-agent`.
- Conversation continuity is supplied by `--resume <threadId>`, where `threadId` is the chat id returned by `cursor-agent create-chat` on the first turn and surfaced as `session_id` in every event.
- Cancellation: SIGTERM the active subprocess, then SIGKILL after a 3s grace period.
- Tool calls run with `--force` (no in-app approval UI yet); approvals are deferred until Cursor's events expose an interactive permission prompt.

## Event mapping

| `cursor-agent` event | StreamChunk emit |
|----------------------|------------------|
| `system.init` | (capture `session_id`, `model`) |
| `user` | (skip — feature layer already echoes) |
| `thinking.delta` | `thinking` |
| `thinking.completed` | (skip) |
| `tool_call.started` | `tool_use` (shell tool detected via `shellToolCall` key) |
| `tool_call.completed` | `tool_result` (`isError` from `exitCode`) |
| `assistant` (with `timestamp_ms`) | `text` (incremental) |
| `assistant` (without `timestamp_ms`) | (skip — final consolidated; would duplicate) |
| `result.success` | `usage` + `done` |
| `result.error` / `is_error` | `error` + `done` |

## Capabilities

Conservative MVP: no MCP, no plan mode, no fork, no rewind, no images, no instruction mode, no provider commands, no turn steer, `reasoningControl: 'none'`. The capability surface widens only when the runtime backs each toggle.

## Provider state

`CursorProviderState` carries pointers only:

- `threadId`: `cursor-agent` session id, used to pass `--resume <threadId>` on subsequent turns once the runtime lands.

Provider-native transcripts are not imported. Claudian-stored messages are the source of truth for history.

## Environment

Environment variables matching `/^CURSOR_/i` route to the `provider:cursor` env scope when users add snippets via the shared environment settings UI. The settings reconciler hashes `CURSOR_API_KEY`, `CURSOR_MODEL`, and `CURSOR_BASE_URL` and invalidates Cursor sessions on change.

## Settings storage

Lives under `settings.providerConfigs.cursor`. Defaults are provided via `getBuiltInProviderDefaultConfigs()`.

## Validation before Phase 2

Before locking the launch spec and event normalizer:

- Confirm `cursor-agent --output-format stream-json` is the streaming JSON event mode.
- Confirm `--resume <id>` and `--model <id>` flag names.
- Capture sample NDJSON output and pin the parser via fixture under `tests/unit/providers/cursor/runtime/fixtures/`.
- Confirm thread/session id surfaces in the event stream so `--resume` is feasible.
- Confirm cancellation behavior (SIGTERM/SIGKILL) leaves no orphan processes.

Real runtime output beats guessed event shapes.
