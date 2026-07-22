# OpenCode Provider

`src/providers/opencode/` adapts OpenCode through Agent Client Protocol over an `opencode acp` subprocess.

## Ownership

- Runtime process management, ACP transport, prompt encoding, stream normalization, SQLite history hydration, model/mode discovery, command discovery, agent storage, settings UI, and OpenCode-specific settings reconciliation live here.
- Shared code should consume OpenCode behavior through `ChatRuntime`, provider capabilities, and workspace-service contracts.

## Protocol Rules

- Live output comes from ACP session notifications and is normalized through `AcpSessionUpdateNormalizer` plus OpenCode tool normalization.
- History hydration reads OpenCode's native SQLite database. Never mutate OpenCode native history from Claudian.
- `providerState.databasePath` preserves the database used for a conversation. Keep it when building session updates.
- `sessionCwds` maps ACP session IDs to vault working directories for read/write request path resolution.

## Launch and Settings

- `prepareOpencodeLaunchArtifacts()` writes managed config and system prompt files under `.claudian/opencode/`.
- Preserve user OpenCode config by loading `OPENCODE_CONFIG` and layering Claudian-managed agent config over it.
- Environment keys that affect config or data location invalidate OpenCode sessions: `OPENCODE_CONFIG`, `OPENCODE_DB`, `OPENCODE_DISABLE_PROJECT_CONFIG`, and `XDG_DATA_HOME`.
- OpenCode mode IDs map to shared permission modes. Keep this mapping in `modes.ts`, not feature code.

## Commands and Agents

- Runtime commands are read from the OpenCode session and exposed through `OpencodeCommandCatalog`.
- OpenCode runtime commands are not editable or deletable from Claudian.
- Command discovery warmup for blank tabs should use the isolated metadata database, not a persisted conversation session.
- Do not let command discovery create a real session for history-backed conversations that have messages but no provider session yet.
- OpenCode agent definitions are stored under `.opencode/agent` and `.opencode/agents`; keep parsing and serialization in `OpencodeAgentStorage`.
- Only explicitly enabled models belong in the chat selector. Do not add a synthetic OpenCode entry, preserve hidden session models, or use the ACP default when none are enabled.

## Gotchas

- `OpencodeAuxQueryRunner` owns its own process and session. It is independent from the chat runtime.
- File read/write permission requests may target paths outside the session working directory. Preserve the existing approval mapping and path checks.
- SQLite reading uses `OpencodeSqliteReader` fallbacks because runtime environments may not expose the same SQLite API.
- OpenCode metadata warmup intentionally uses an in-memory or metadata database to avoid binding tab state to discovery work.
