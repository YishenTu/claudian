# Codex Provider

Adaptor for OpenAI Codex via `codex app-server` over stdio JSON-RPC 2.0.

## Protocol Overview

The app-server speaks JSON-RPC 2.0 over stdio (newline-delimited JSON) with three message flows:
- **Client → Server** (request/response): `initialize`, `thread/*`, `turn/*`, `skills/list`
- **Server → Client** (notifications): streaming deltas, item events, `turn/completed`, usage
- **Server → Client → Server** (server requests): approval gates, user input requests — the server asks a question, the client responds

The `initialize` handshake is mandatory and must include `{ experimentalApi: true }` to unlock extended capabilities. Wire types are probed against a specific app-server version in `codexAppServerTypes.ts`.

## Design Decisions

### Dual Tool Source — Why File Tailing

Tools are displayed from two possible sources:

| Mode | Source | When |
|------|--------|------|
| `transcript` (default) | Session JSONL file via `CodexFileTailEngine` polling at 100ms | Session file found during `primeCursor()` |
| `fallback` | Live RPC notifications via `CodexNotificationRouter` | File not found, or 5 consecutive read failures |

**Why transcript mode exists**: the session JSONL has richer tool result data than live notifications (e.g., exit codes from `exec_command_end`, structured MCP enrichment). Using it ensures tool display is consistent between live streaming and replayed conversations from history.

**Timing coordination**: in transcript mode, the notification router suppresses tool chunks. Before emitting `done`, the runtime calls `waitForSettle()` — waits until the tail engine has been idle for 500ms (no new events) and polling was recent (within 250ms) — then drains remaining tail chunks. This prevents the turn from completing before the last tools are displayed.

### Skill Listing Via Ephemeral Process

`CodexSkillListingService` spawns a **separate short-lived app-server process** for each `skills/list` RPC call (TTL-cached for 5 seconds). This avoids coupling skill discovery to the chat runtime lifecycle — skills can be listed even when no chat is active, and skill discovery errors can't crash the main runtime.

### Environment Hash Invalidation

`CodexSettingsReconciler` watches `OPENAI_MODEL`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`. Any hash change invalidates all existing Codex sessions (clears `sessionId` and `providerState`), preventing the UI from trying to resume sessions against a different API endpoint.

## Non-Obvious Behaviors

### Thread Resume Requirement

The app-server requires `thread/resume` before any operation on an existing thread in a new daemon process. `loadedThreadId` tracks which thread has been resumed in the current daemon session. If the process is killed and restarted, the next query will resume the thread first. For forks, `thread/resume` must be called on the **new fork** (not the source) before `thread/rollback`.

### Pending Turn Notification Buffering

The server may emit notifications before the client has processed the `turn/start` RPC response and set `currentTurnId`. These early notifications buffer in `pendingTurnNotifications` and flush once the turn ID is established.

### Compact Turn ID

For normal turns, the turn ID comes from the `turn/start` RPC response. For compact (`thread/compact/start`), the response is `{}` with no turn ID — the ID is established when the `turn/started` notification arrives. `routeNotification` handles this special case.

### JSONL Format Duality

A single session file may contain both legacy (`type: 'event'`) and modern (`type: 'event_msg'`, `type: 'response_item'`) records. The parser scans all records and uses the modern path if any modern records are present. A `type: 'compacted'` record completely resets the turn context and replays from `replacement_history`.

### Image Lifecycle

Images are written to a temp directory (`os.tmpdir()/claudian-codex-images-{random}/`), passed as `{ type: 'localImage', path }` inputs, and cleaned up in the `query()` `finally` block.

### `serverRequest/resolved`

The server can resolve approval/ask-user requests without waiting for client input (e.g., timeout). The `serverRequest/resolved` notification auto-dismisses the pending approval/ask-user UI.

## Gotchas

- `CodexAuxQueryRunner` uses its own separate process + transport + thread — completely independent from the chat runtime
- `CodexTaskResultInterpreter` is all no-ops — Claudian's async agent task system (used for Claude) doesn't apply to Codex
- Session file paths may include a date prefix (`{date}-{threadId}.jsonl`) — `findCodexSessionFile` handles both patterns via DFS fallback
- Codex is opt-in: `isEnabled()` defaults to `false`
