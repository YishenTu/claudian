# Codex Provider

`src/providers/codex/` adapts OpenAI Codex through `codex app-server` over stdio JSON-RPC 2.0.

## Dependency Boundary

- App-server JSON-RPC types, notifications, raw response items, and JSONL records remain provider-local until normalized into core execution events, snapshots, or history projections.
- App-server process management, model discovery, skill listing, and chat execution may share transport primitives but must not share a live process or session implicitly.

## Ownership

| Component | Owns |
| --- | --- |
| `CodexExecutionSession` | One provider execution binding, thread/turn requests, pending notification fencing, interactions, cancellation, and provider snapshots |
| `CodexAppServerProcess` and `CodexRpcTransport` | App-server subprocess and JSON-RPC transport mechanics |
| `CodexNotificationRouter` | Projection of live notifications and raw response items into normalized stream chunks |
| `history/CodexHistoryStore.ts` | Read-only JSONL replay projection, session-file lookup, and historical model recovery |
| `CodexSkillListingService` | Independent short-lived skill-listing process and result lifecycle |
| `CodexModelCatalogCoordinator` | Workspace model discovery snapshots and transition fencing |

Live execution state and replay state are separate authorities. Do not fill gaps in one by mutating or polling the other.

## Protocol Rules

- The startup handshake is mandatory: send `initialize`, then notify `initialized`.
- `initialize` must include `{ experimentalApi: true }` for extended capabilities.
- Client requests include `thread/*`, `turn/*`, and `skills/list`.
- Server notifications drive streaming, item events, turn completion, and usage.
- Server requests drive approval gates and ask-user prompts; the client must answer them.

## Live Output vs History

- Live turn output comes from JSON-RPC notifications. `thread/start` and `thread/resume` request `experimentalRawEvents: true`.
- `CodexNotificationRouter` projects normalized notifications and raw response items into Claudian `StreamChunk`s.
- Do not reintroduce live JSONL polling unless the app-server stops emitting equivalent notifications and the tradeoff is documented with a current wire trace.
- JSONL is the replay source for history hydration and session-file discovery.

## Design Rules

- Native transcripts live under `~/.codex/sessions/` and may move to sibling `archived_sessions/`; resolve both through `CodexHistoryPathResolver` (WSL and home-dir aware).
- `CodexSkillListingService` uses a separate short-lived app-server process for `skills/list`. Do not couple skill discovery to the active chat runtime.
- Runtime fingerprint changes invalidate existing Codex sessions. The fingerprint includes `OPENAI_MODEL`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `PATH`, explicit/host CLI-path inputs, installation method, and WSL distro override.
- Existing threads require `thread/resume` before operations in a new app-server process.
- For forks, resume the new fork thread before `thread/rollback`.
- Notifications can arrive before `turn/start` returns; preserve pending-turn buffering.
- Compact turns get their ID from `turn/started`, not from the `thread/compact/start` response.

## History Gotchas

- A session file may contain legacy records and modern records. Prefer the modern path if any modern records are present.
- Do not replay `type: 'compacted'` `replacement_history` as visible UI history. The durable visible marker is `event_msg:context_compacted`.
- Session file names may include a date prefix. Keep DFS fallback in session-file lookup.
- Historical selected-model recovery must honor the persisted rollback/fork checkpoint. For a materialized fork, validate the source segment before trusting the fork transcript, search trusted archived roots when the active session path no longer exists, and never make invalidated thread metadata resumable.

## Runtime Gotchas

- Images are written to a temp directory, passed as local image paths, and cleaned up in `query()` `finally`.
- `serverRequest/resolved` can auto-dismiss approval or ask-user UI without client input.
- The shared no-op task-result interpreter is intentional because Claudian's Claude async-agent task system does not apply to Codex.
- Codex is opt-in and must stay disabled by default.

## Invariants

- A thread must be started or resumed before a turn, rollback, or compact operation targets it in the current app-server process.
- Only current binding, provider generation, and turn notifications may update the active execution.
- Provider state persists opaque Codex thread and fork metadata; feature code must not reconstruct it.
