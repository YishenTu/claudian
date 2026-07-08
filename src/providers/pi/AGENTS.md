# Pi Provider

`src/providers/pi/` adapts Pi through a `pi --mode rpc` subprocess.

## Ownership

- RPC process management, prompt encoding, event normalization, JSONL history hydration, model discovery, command discovery, extension UI bridging, settings UI, and Pi-specific settings reconciliation live here.
- Shared code should consume Pi behavior through `ChatRuntime`, provider capabilities, and workspace-service contracts.

## Protocol Rules

- Launch arguments are built in `PiLaunchSpec.ts`. Keep command-line shape there instead of scattering flags across runtime code.
- Live events are normalized through `normalizePiRpcEvent()` and `PiEventNormalizationState`.
- Extension UI requests are routed through `PiExtensionUiBridge` and rendered by `ObsidianPiExtensionUiRenderer`.
- Compact turns call the `compact` RPC request and emit a `context_compacted` stream chunk.

## Session and History Rules

- `PiProviderState` may store `sessionId`, `sessionFile`, `leafEntryId`, `parentSession`, and fork metadata. Do not infer these fields in feature code.
- Pi can resume by session ID or absolute session file. Absolute session files can be switched in a live process; other target changes require process restart.
- History hydration reads Pi JSONL sessions from vault-local and user-level session roots. Never mutate native history during hydration.
- Forking creates a new Pi session file by copying the source branch up to `resumeAt`. Keep fork materialization provider-owned.
- Environment keys that affect Pi data or package locations invalidate existing Pi sessions.

## Commands and Models

- Runtime commands come from the `get_commands` RPC and are exposed through `PiCommandCatalog`.
- Pi runtime commands are not editable or deletable from Claudian.
- Model discovery uses a separate subprocess and may receive extension UI requests. Keep model normalization in `models.ts`.
- Use model-provided context windows when available; otherwise preserve the existing fallback behavior.

## Gotchas

- `PiAuxQueryRunner` owns its own process and is independent from the chat runtime.
- Images are passed as prompt image blocks only when attachment data is available.
- `new_session` invalidates persisted session state until the provider reports a replacement session.
- Tool mode can launch Pi with readonly tools or no tools. Keep that logic in launch-spec construction.
