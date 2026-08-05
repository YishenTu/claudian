# OpenCode Provider

`src/providers/opencode/` adapts OpenCode through Agent Client Protocol over an `opencode acp` subprocess.

## Dependency Boundary

- ACP transport, session, and interaction mechanics may be shared. OpenCode launch artifacts, config layering, database semantics, modes, tools, agents, and metadata policy remain provider-owned.
- Managed launch files live under `.claudian/opencode/`; user OpenCode config and the native history database remain outside Claudian ownership.

## Ownership

| Component or area | Owns |
| --- | --- |
| `OpencodeExecutionSession` | Provider execution binding, request lifecycle, normalized events, provider snapshots, and recovery |
| `OpencodeAcpSessionKernel` | Managed ACP process, native session, config options, file requests, and working-directory enforcement |
| `OpencodeMetadataService` | Detached model and command metadata probes plus current-device discovery snapshots |
| `history/` | Read-only SQLite history discovery, replay projection, and historical model recovery |
| `OpencodeAgentStorage` | Claudian-supported parsing and serialization of vault OpenCode agent definitions |
| `runtime/` | Managed config/system-prompt artifacts, environment construction, and path resolution |

## Protocol Rules

- Live output comes from ACP session notifications and is normalized through `AcpSessionUpdateNormalizer` plus OpenCode tool normalization.
- History hydration reads OpenCode's native SQLite database.
- Historical selected-model recovery reads the session row's stored provider/model identifiers from the trusted database path. Preserve the raw historical selection even when it is no longer in the current model catalog, and never promote a recovery-only locator into a live ACP binding.
- `providerState.databasePath` preserves the database used for a conversation until a typed history or environment transition replaces it. Keep it when building session updates.
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
