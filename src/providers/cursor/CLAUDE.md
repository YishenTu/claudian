# Cursor Provider

Adaptor for the headless **Cursor CLI** (`cursor-agent`). Opt-in (`enabled: false` by default), local-only, modeled on the Codex provider's CLI subprocess pattern.

## Status

Phase 1 (current): skeleton + registration. Capabilities, settings, types, model picker, settings reconciler, history seam, settings tab placeholder, and runtime/aux stubs are wired so the provider can register and the settings tab can render. The runtime stubs throw on actual invocation; see Phases 2-4 below.

## Phased Rollout

| Phase | Scope |
|-------|-------|
| 1 | Skeleton + registration + opt-in toggle (this commit) |
| 2 | Real `cursor-agent` subprocess wrapper, NDJSON event transport, prompt encoder, stream normalization |
| 3 | Auxiliary services backed by ephemeral `cursor-agent` runs (title, instruction refine, inline edit) |
| 4 | Settings UX polish: per-host CLI path validation, custom models, environment scope |

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
