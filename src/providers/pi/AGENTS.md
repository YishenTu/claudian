# Pi Provider

`src/providers/pi/` adapts Pi through a `pi --mode rpc` subprocess.

## Dependency Boundary

- Pi RPC payloads, extension UI, session files, model metadata, commands, and provider state remain provider-owned until normalized into core contracts.

## Ownership

| Component or area | Owns |
| --- | --- |
| `PiExecutionSession` | Provider execution binding, request/event lifecycle, provider snapshots, cancellation, and recovery |
| `PiRpcSessionKernel` behind `PiExecutionKernel` | RPC turn coordination and live Pi execution mechanics |
| `PiLaunchSpec` and `PiSubprocess` | Command-line, environment, subprocess, and transport construction |
| `PiExtensionUiBridge` | Typed routing of provider extension UI requests to the Obsidian renderer |
| `history/` | Native JSONL discovery, read-only replay and historical model recovery, and new fork-file materialization |
| `PiModelDiscoveryService` and `PiCommandMetadataProbe` | Independent metadata subprocesses and their results |

## Protocol Rules

- Launch arguments are built in `PiLaunchSpec.ts`. Keep command-line shape there instead of scattering flags across runtime code.
- Live events are normalized through `normalizePiRpcEvent()` and `PiEventNormalizationState`.
- Extension UI requests are routed through `PiExtensionUiBridge` and rendered by `ObsidianPiExtensionUiRenderer`; execution code must not manipulate Obsidian DOM directly.
- Compact turns call the `compact` RPC request and emit a `context_compacted` stream chunk.

## Session and History Rules

- `PiProviderState` may store `sessionId`, `sessionFile`, `leafEntryId`, `parentSession`, `previousSessions`, and fork metadata. Do not infer these fields in feature code.
- Pi can resume by session ID or absolute session file. Absolute session files can be switched in a live process; other target changes require process restart.
- History hydration reads Pi JSONL sessions from vault-local (`.pi/agent/sessions/`) and user-level (`~/.pi/agent/sessions/`) roots.
- Forking creates a new Pi session file by copying the source branch up to `resumeAt` without altering or truncating the source. Keep fork materialization provider-owned.
- Historical selected-model recovery walks the active JSONL branch to `leafEntryId` and preserves the last native provider/model pair. A missing persisted leaf must fail closed instead of using another branch; never promote `previousSessions` or a recovery-only locator into the live binding.
- Environment keys that affect Pi data or package locations invalidate existing Pi sessions.
- The runtime fingerprint includes `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_CACHE_RETENTION`, `PATH`, and explicit/host CLI-path inputs.

## Commands and Models

- Runtime commands come from the `get_commands` RPC and are exposed through `PiCommandCatalog`.
- Model discovery uses a separate subprocess and may receive extension UI requests. Keep model normalization in `models.ts`.
- Use model-provided context windows when available; otherwise preserve the existing fallback behavior.

## Gotchas

- Images are passed as prompt image blocks only when attachment data is available.
- `new_session` invalidates persisted session state until the provider reports a replacement session.
- Tool mode can launch Pi with readonly tools or no tools. Keep that logic in launch-spec construction.
