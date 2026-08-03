# OpenCode Provider

`src/providers/opencode/` adapts OpenCode through Agent Client Protocol over an `opencode acp` subprocess.

## Dependency Boundary

- OpenCode code may depend on core contracts, shared ACP primitives from `src/providers/acp/`, shared UI primitives, and provider-local modules. It must not import chat views or feature controllers.
- ACP transport, session, and interaction mechanics may be shared. OpenCode launch artifacts, config layering, database semantics, modes, tools, agents, and metadata policy remain provider-owned.
- Managed launch files live under `.claudian/opencode/`; user OpenCode config and the native history database remain outside Claudian ownership.

## Ownership

| Component or area | Owns |
| --- | --- |
| `OpencodeExecutionSession` | Provider execution binding, request lifecycle, normalized events, provider snapshots, and recovery |
| `OpencodeAcpSessionKernel` | Managed ACP process, native session, config options, file requests, and working-directory enforcement |
| `OpencodeMetadataService` | Detached model and command metadata probes plus current-device discovery snapshots |
| `history/` | Read-only SQLite history discovery and replay projection |
| `OpencodeAgentStorage` | Claudian-supported parsing and serialization of vault OpenCode agent definitions |
| `runtime/` | Managed config/system-prompt artifacts, environment construction, and path resolution |

## Protocol Rules

- Live output comes from ACP session notifications and is normalized through `AcpSessionUpdateNormalizer` plus OpenCode tool normalization.
- History hydration reads OpenCode's native SQLite database.
- `providerState.databasePath` preserves the database used for a conversation. Keep it when building session updates.
- File requests are resolved and permission-checked against the kernel's configured vault working directory; do not recreate path policy in feature code.

## Launch and Settings

- `prepareOpencodeLaunchArtifacts()` writes managed config and system prompt files under `.claudian/opencode/`.
- Preserve user OpenCode config by loading `OPENCODE_CONFIG` and layering Claudian-managed agent config over it.
- Runtime fingerprint changes invalidate OpenCode sessions. The fingerprint includes `OPENCODE_CONFIG`, `OPENCODE_DB`, `OPENCODE_DISABLE_PROJECT_CONFIG`, `XDG_DATA_HOME`, `PATH`, and explicit/host CLI-path inputs.
- OpenCode mode IDs map to shared permission modes. Keep this mapping in `modes.ts`, not feature code.

## Commands and Agents

- Runtime commands are read from the OpenCode session and exposed through `OpencodeCommandCatalog`.
- Command discovery warmup for blank tabs should use the isolated metadata database, not a persisted conversation session.
- Do not let command discovery create a real session for history-backed conversations that have messages but no provider session yet.
- OpenCode agent definition parsing and serialization stays in `OpencodeAgentStorage`.

## Gotchas

- File read/write permission requests may target paths outside the session working directory. Preserve the existing approval mapping and path checks.
- SQLite reading uses `OpencodeSqliteReader` fallbacks because runtime environments may not expose the same SQLite API.
- OpenCode metadata warmup intentionally uses an in-memory or metadata database to avoid binding tab state to discovery work.

## Invariants

- Live ACP notifications are the live-output source; SQLite is read-only replay input.
- Managed configuration layers over user configuration and must not clobber the user-selected `OPENCODE_CONFIG` source.
- Command and model metadata probes own isolated processes/databases and must not bind a history-backed conversation to a new native session.
- Database-path provider state is preserved until a typed history or environment transition deliberately replaces it.
- Provider mode and variant mappings remain provider-owned and cross into chat only through core capabilities and UI config.
