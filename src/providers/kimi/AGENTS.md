# Kimi Provider

`src/providers/kimi/` adapts the Kimi CLI through Agent Client Protocol over a `kimi acp` subprocess.

## Ownership

- Runtime process management, ACP transport, prompt encoding, stream normalization, native-history hydration, model and command discovery, settings reconciliation, settings UI, and auxiliary services live here.
- Shared code should consume Kimi behavior through `ChatRuntime`, provider capabilities, and workspace-service contracts.
- Provider-owned conversation data stays behind `KimiProviderState` helpers; feature code must not inspect it.

## Protocol Rules

- `kimi acp` takes no extra flags; launch is `kimi acp` with the vault as cwd plus the settings env projection.
- One `kimi acp` process hosts multiple sessions. `session/new` uses the vault cwd; `session/load` replays kimi-native history. Live output comes from ACP session notifications; replay stays on the provider protocol.
- Kimi prefixes tool call ids with `<turn-uuid>/` so re-emitted LLM ids stay unique across turns. `normalization/kimiToolCallId.ts` strips the prefix before the shared ACP normalizer sees the update; never reintroduce prefixed ids into feature code.
- Permission requests offer exactly `approve`, `approve_for_session`, and `reject`. Map them through the shared `AcpPermissionAdapter`; do not invent per-tool rules.
- ACP error code `-32000` (AUTH_REQUIRED) means login is missing or expired. Surface the `terminal-auth` metadata command (fall back to `kimi login`) and let the user authenticate in a terminal; never call `authenticate` automatically or persist Kimi credentials.
- `session/set_model` also persists the selection as kimi's default model in `~/.kimi/config.toml` (kimi-side behavior; the CLI asserts the default config location). Model switching from the UI has this global side effect by design.
- No plan mode, steer, fork, or rewind. Thinking is exposed by kimi as a `,thinking` model variant, not a reasoning-effort control.

## History and Storage

- Sessions live under `~/.kimi-code/sessions/wd_<slug>_<sha256(normalized cwd)[:12]>/session_<uuid>/`; `KIMI_CODE_HOME` relocates the `~/.kimi-code` root. The main agent wire log is `<sessionDir>/agents/main/wire.jsonl` (flat `{type, time, ...}` records, ms epochs); `state.json` holds the session title. `KimiHistoryPathResolver` owns the path rules and trusted-root checks.
- Never mutate kimi-native files (`~/.kimi-code/sessions/**`). Deleting a Claudian conversation only removes `.claudian` session metadata.
- Settings reconciliation is env projection only (`KIMI_*` / `MOONSHOT_*`); it never writes `~/.kimi/config.toml`. Kimi loads `~/.kimi/mcp.json` natively, so there is no `mcpServerManager`.

## Commands and Models

- Runtime commands come from ACP `available_commands_update` and flow through `KimiCommandCatalog`; they are not editable or deletable from Claudian.
- Models come from `session/new` / `session/load` responses via `KimiChatRuntime.getDiscoveredModels()`. The settings tab mirrors the last catalog into the symbol-keyed, non-persisted `discoveryState.ts` so `KimiChatUIConfig` can read it. Selection ids are `kimi:<raw-id>`.
- `visibleModels: null` means the whole discovered catalog is visible; an explicit list restricts it.
- Command discovery and model-catalog warmup create a real kimi session (`session/new`); there is no in-memory equivalent. History-backed conversations with messages but no session id must stay cold until the first send — warm those on an isolated runtime so the first turn still bootstraps history.

## Gotchas

- `KimiAuxQueryRunner` owns one-shot `kimi --print --output-format text --final-message-only` subprocesses, independent from the chat runtime. Print mode auto-approves tools and auto-dismisses AskUserQuestion.
- `kimi --version` prints `kimi, version X.Y.Z` (some builds print the bare version); `KimiCliResolver` also accepts the `kimi-cli` binary name.
- Kimi ACP does not expose subagent events, so there is no `subagentAdapter` and no agent-mention provider (kimi has no vault agent directory convention).
