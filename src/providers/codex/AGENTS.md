# Codex Provider

`src/providers/codex/` adapts OpenAI Codex through `codex app-server` over stdio JSON-RPC 2.0.

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

- `CodexSkillListingService` uses a separate short-lived app-server process for `skills/list`. Do not couple skill discovery to the active chat runtime.
- Environment hash changes for `OPENAI_MODEL`, `OPENAI_BASE_URL`, and `OPENAI_API_KEY` invalidate existing Codex sessions.
- Existing threads require `thread/resume` before operations in a new app-server process.
- For forks, resume the new fork thread before `thread/rollback`.
- Notifications can arrive before `turn/start` returns; preserve pending-turn buffering.
- Compact turns get their ID from `turn/started`, not from the `thread/compact/start` response.

## History Gotchas

- A session file may contain legacy records and modern records. Prefer the modern path if any modern records are present.
- Do not replay `type: 'compacted'` `replacement_history` as visible UI history. The durable visible marker is `event_msg:context_compacted`.
- Session file names may include a date prefix. Keep DFS fallback in session-file lookup.

## Runtime Gotchas

- Images are written to a temp directory, passed as local image paths, and cleaned up in `query()` `finally`.
- `serverRequest/resolved` can auto-dismiss approval or ask-user UI without client input.
- `CodexAuxQueryRunner` owns its own process, transport, and thread. It is independent from the chat runtime.
- `CodexTaskResultInterpreter` is intentionally no-op because Claudian's Claude async-agent task system does not apply to Codex.
- Codex is opt-in and must stay disabled by default.
- Only explicitly enabled models belong in the chat selector. Do not preserve hidden session models or fall back to the app-server default when none are enabled.
