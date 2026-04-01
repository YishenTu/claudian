# Claude Provider

SDK adaptor wrapping `@anthropic-ai/claude-code` Agent SDK behind `ChatRuntime`.

## Design Decisions

### Persistent Query — Why Not Restart

The persistent query stays alive across turns. Model, thinking budget, permission mode, and MCP servers are updated dynamically via SDK API calls (`setModel`, `setMaxThinkingTokens`, `setPermissionMode`, `setMcpServers`). Only system prompt, plugins, CLI path, effort level, and external context paths require a restart. This eliminates cold-start latency for every turn.

### Text Deduplication

The SDK delivers assistant text twice: incrementally via `stream_event/content_block_delta`, and again as complete text in the `assistant` message. The handler tracks `sawStreamText` — if stream events were seen, the assistant message's text blocks are skipped. Without this, every response would render double.

### Usage Chunk Two-Phase Buffering

Usage info comes from two SDK messages:
1. **Assistant message**: accurate input/output token counts, but only from main-agent messages (`parent_tool_use_id === null` filter) — subagent messages are excluded to avoid inflated counts
2. **Result message**: authoritative `contextWindow` from `modelUsage` that corrects the estimated percentage

Using result-message token counts would be wrong because they aggregate across subagents. Using assistant-message context window would be wrong because it's estimated. The two-phase merge gets both right.

### Custom Spawn — Electron Workarounds

`createCustomSpawnFunction()` works around two Obsidian/Electron-specific issues:
- Resolves `node` to a full path because GUI apps don't inherit shell PATH
- Does NOT pass `signal` to `spawn()` — Obsidian's Electron uses a different `AbortSignal` realm that breaks Node's internal `instanceof` check; manually calls `child.kill()` on abort instead

## Non-Obvious Behaviors

### SDK Amnesia Detection

When the SDK returns a different session ID than the one provided in `resume`, `SessionManager.captureSession()` sets `needsHistoryRebuild = true`. The feature layer detects this and injects full conversation history into the next user message. This handles the case where the SDK silently lost context without explicit error signaling.

**Fork interaction**: on the first `session_init` after a fork, `clearHistoryRebuild()` prevents the amnesia logic from triggering — the SDK legitimately returns a different session ID for forks.

### Crash Recovery

On consumer loop error, if `!crashRecoveryAttempted && lastSentMessage && !handler.sawAnyChunk` (first failure, message was sent, nothing was streamed yet): restart the persistent query with `preserveHandlers: true` and re-enqueue the message. Single retry only — second failure surfaces the error.

### Auto-Triggered Turns

The SDK can send messages without a registered handler (e.g., background subagent completion notifications). These chunks buffer in `_autoTurnBuffer` and deliver via `_autoTurnCallback` on the `result` event.

### MessageChannel Queue

- Text-only messages merge with `\n\n` up to 12000 chars while a turn is active (fast follow-up messages coalesce)
- Attachment messages replace the previous queued attachment (one at a time)
- Queue overflow beyond 8 messages drops the newest

### Branch Filtering

SDK session files are tree-structured — rewind + re-prompt creates branches. `sdkBranchFilter` finds the canonical branch by locating the latest leaf, walking ancestry to root, then including non-user-branch siblings (tool results belonging to ancestors). This is the most algorithmically complex part of the history layer.

## Storage Traps

### CC Settings Merge

`CCSettingsStorage.save()` reads the existing `.claude/settings.json` first and merges — it only manages `permissions` and `enabledPlugins`. Without the merge, saving would clobber CC-owned fields (model, env, MCP settings) that users set via the CLI.

### MCP Dual-Namespace

`.claude/mcp.json` stores servers in two namespaces: `mcpServers` (CC-compatible, read by the CLI) and `_claudian.servers` (Claudian metadata: enabled, contextSaving, disabledTools, description). CC ignores the `_claudian` key. This avoids polluting the CC-compatible format with Claudian-specific data.

### Plugin Dual-Write

Plugin enabled state is written to both `.claude/settings.json` (so the CC CLI also respects it) and kept in `PluginManager.plugins[].enabled` (for Claudian's restart check). These must stay in sync.

### Slash Command ID Encoding

Dashes are escaped as `-_`, slashes become `--`. This is a reversible encoding for subdirectory support: `a/b-c.md` → `cmd-a--b-_c`.

## Gotchas

- `DISABLED_BUILTIN_SUBAGENTS = ['Task(statusline-setup)']` — disabled because it has no meaning in Obsidian
- `previousProviderSessionIds` tracks all prior SDK sessions for a conversation (e.g., after forks). All are loaded during history hydration to build the complete message set — not just the current session
- `EnterPlanMode` never hits `canUseTool` — the SDK auto-approves it; the runtime detects it in the stream to sync UI. `ExitPlanMode` does go through `canUseTool`
- Context window `selectContextWindowEntry()` handles multi-model scenarios (subagent uses different model) by matching model signatures — exact match first, then family match (haiku/sonnet/opus + 1M flag), null if ambiguous
