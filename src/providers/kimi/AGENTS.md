# Kimi Provider

`src/providers/kimi/` adapts the Kimi CLI through Agent Client Protocol over a `kimi acp` subprocess.

## Ownership

- Runtime process management, ACP transport, prompt encoding, stream normalization, native-history hydration, model and command discovery, settings reconciliation, settings UI, and auxiliary services live here.
- Shared code should consume Kimi behavior through `ChatRuntime`, provider capabilities, and workspace-service contracts.
- Provider-owned conversation data stays behind `KimiProviderState` helpers; feature code must not inspect it.

## Protocol Rules

- `kimi acp` takes no extra flags; launch is `kimi acp` with the vault as cwd plus the settings env projection.
- One `kimi acp` process hosts multiple sessions. `session/new` uses the vault cwd; `session/load` replays kimi-native history. Live output comes from ACP session notifications; replay stays on the provider protocol.
- Kimi prefixes tool call ids with `<turnId>:` (integer turn id) so re-emitted LLM ids stay unique across turns. `normalization/kimiToolCallId.ts` strips the numeric prefix before the shared ACP normalizer sees the update (raw `tool_*` ids may contain colons, so only a numeric first segment is stripped); never reintroduce prefixed ids into feature code.
- Permission requests offer `approve_once`, `approve_always`, and `reject`. Map them through the shared `AcpPermissionAdapter`; do not invent per-tool rules. ExitPlanMode-style approvals arrive as `plan_review` requests whose option ids live in the `plan_*` namespace (`plan_opt_<i>` / `plan_approve` / `plan_revise` / `plan_reject_and_exit`); each option is a distinct choice that round-trips its own id rather than an allow/deny decision.
- ACP error code `-32000` (AUTH_REQUIRED) means login is missing or expired. Surface the `terminal-auth` metadata command (fall back to `kimi login`) and let the user authenticate in a terminal; never call `authenticate` automatically or persist Kimi credentials.
- `session/new` and `session/load` return `configOptions` (no `models` state): a `model` select (bare aliases), a `thought_level` select (id `thinking`, present only for thinking-capable models, rows `off` + effort levels or legacy `off`/`on`), and a `mode` select (`default`/`plan`/`auto`/`yolo`). Writes go through `session/set_config_option` (model, thinking) and `session/set_mode` (mode); the server pushes `config_option_update` after every change. `session/set_model` exists but is not used here.
- Mode is session-scoped and resets to `default` on every new/load. The shared permission-mode contract maps `normal`→`default`, `yolo`→`yolo`, `plan`→`plan`; kimi's `auto` has no shared equivalent and never syncs back into the toggle.
- No steer, fork, or rewind.

## History and Storage

- Sessions live under `~/.kimi-code/sessions/wd_<slug>_<sha256(normalized cwd)[:12]>/session_<uuid>/`; `KIMI_CODE_HOME` relocates the `~/.kimi-code` root. The main agent wire log is `<sessionDir>/agents/main/wire.jsonl` (flat `{type, time, ...}` records, ms epochs); `state.json` holds the session title. `KimiHistoryPathResolver` owns the path rules and trusted-root checks.
- Never mutate kimi-native files (`~/.kimi-code/sessions/**`). Deleting a Claudian conversation only removes `.claudian` session metadata.
- Settings reconciliation is env projection only (`KIMI_*`); it never writes `~/.kimi-code/config.toml`. Kimi loads `~/.kimi-code/mcp.json` natively, so there is no `mcpServerManager`.

## Commands and Models

- Runtime commands come from ACP `available_commands_update` and flow through `KimiCommandCatalog`; they are not editable or deletable from Claudian.
- Models come from the `configOptions` on `session/new` / `session/load` responses (and `config_option_update` notifications) via `KimiChatRuntime.getDiscoveredModels()`. The runtime mirrors the catalog into the symbol-keyed `discoveryState.ts` so `KimiChatUIConfig` can read it, writes it through to the persisted `discoveredModels` provider config (which re-seeds the mirror after a plugin reload), and mirrors per-model thinking options and current levels there. `refreshKimiModelCatalog` (exposed as the `refreshModelCatalog` workspace hook) rediscovers the catalog on an isolated runtime and keeps the old catalog on failure. Selection ids are `kimi:<raw-id>`.
- Thinking is a reasoning-effort control (`reasoningControl: 'effort'`), not a model variant. The user's per-model effort choice persists in `preferredThinkingByModel`; the session write goes through `session/set_config_option` with the discovered thought-level config id.
- `visibleModels: null` means the whole discovered catalog is visible; an explicit list restricts it.
- Command discovery and model-catalog warmup create a real kimi session (`session/new`); there is no in-memory equivalent. History-backed conversations with messages but no session id must stay cold until the first send — warm those on an isolated runtime so the first turn still bootstraps history.

## Gotchas

- `KimiAuxQueryRunner` owns one-shot `kimi --prompt <prompt> --output-format text` subprocesses, independent from the chat runtime. Prompt mode forces auto permission and auto-approves tools; text output carries only the assistant text on stdout.
- Kimi Code ships a single `kimi` binary (npm `@moonshot-ai/kimi-code`); `KimiCliResolver` resolves only that name.
- Kimi ACP does not expose subagent events, so there is no `subagentAdapter` and no agent-mention provider (kimi has no vault agent directory convention).
