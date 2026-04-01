# Chat Feature

Main sidebar chat interface. `ClaudianView` is a thin shell; logic lives in controllers and services.

## Provider Boundary Status

- Current state: chat features depend on `ChatRuntime` (provider-neutral interface). `InputController` builds structured `ChatTurnRequest` objects; prompt encoding is delegated to the runtime via `prepareTurn()`. Session bookkeeping lives in `Conversation.providerState` (opaque), managed by `ChatRuntime.buildSessionUpdates()`. Auxiliary services, history/session fallback, task-result interpretation, and chat-facing agent mention lookup are created via `ProviderRegistry`. Conversations carry `providerId` for routing and `providerState` for provider-owned data; feature code never reads provider-specific fields directly. Fork state is built via `ProviderConversationHistoryService.buildForkProviderState()`. `FileContext.ts` uses the provider-neutral `AgentMentionProvider` interface.
- Remaining debt: plugin management and full provider-owned agent authoring/storage are still bootstrap concerns; only the chat-facing mention seam is provider-neutral.
- Target state: chat should talk exclusively to the thin runtime facade; agent/plugin management should also go through provider-neutral contracts.

## Architecture

```
ClaudianView (lifecycle + assembly)
├── ChatState (centralized state)
├── Controllers
│   ├── ConversationController  # History, session switching
│   ├── StreamController        # Streaming, auto-scroll, abort
│   ├── InputController         # Text input, file context, images
│   ├── SelectionController     # Editor selection awareness
│   ├── BrowserSelectionController # Browser view selection
│   ├── CanvasSelectionController  # Canvas selection
│   └── NavigationController    # Keyboard navigation (vim-style)
├── Services
│   ├── SubagentManager          # Unified sync/async subagent lifecycle
│   └── BangBashService          # Direct bash execution ("!" mode)
│   # TitleGenerationService and InstructionRefineService are created via
│   # ProviderRegistry; each provider has its own impl in src/providers/{id}/aux/
├── Rendering
│   ├── MessageRenderer         # Main rendering orchestrator
│   ├── ToolCallRenderer        # Tool use blocks
│   ├── ThinkingBlockRenderer   # Extended thinking
│   ├── WriteEditRenderer       # File write/edit with diff
│   ├── DiffRenderer            # Inline diff display
│   ├── TodoListRenderer        # Todo panel
│   ├── SubagentRenderer        # Subagent status panel
│   ├── InlineExitPlanMode      # Claude plan mode approval card (tool-driven)
│   ├── InlinePlanApproval # Plan completion approval card (post-stream)
│   ├── InlineAskUserQuestion   # AskUserQuestion inline card
│   └── collapsible             # Collapsible block utility
├── Tabs
│   ├── TabManager              # Multi-tab orchestration
│   ├── TabBar                  # Tab UI component
│   └── Tab                     # Individual tab state + fork request handling
└── UI Components
    ├── InputToolbar            # Model selector, thinking, permissions, context meter
    ├── FileContext             # @-mention chips and dropdown
    ├── ImageContext            # Image attachments
    ├── StatusPanel             # Todo/command output panels container
    ├── NavigationSidebar       # Sidebar navigation
    ├── InstructionModeManager  # "#" mode UI
    └── BangBashModeManager     # "!" bash mode UI
```

## State Flow

```
User Input → InputController → ChatRuntime.query()
                                      ↓
                              StreamController (handle messages)
                                      ↓
                              MessageRenderer (update DOM)
                                      ↓
                              ChatState (persist)
```

Current flow now routes through the runtime facade, and provider-owned services handle prompt encoding, history/session fallback, and task-result interpretation.

## Controllers

| Controller | Responsibility |
|------------|----------------|
| `ConversationController` | Load/save sessions, history panel, session switching, fork session setup |
| `StreamController` | Process SDK messages, auto-scroll, streaming UI state |
| `InputController` | Input textarea, file/image attachments, slash commands |
| `SelectionController` | Poll editor selection (250ms), CM6 decoration |
| `BrowserSelectionController` | Observe browser view selections |
| `CanvasSelectionController` | Observe canvas selections |
| `NavigationController` | Vim-style keyboard navigation (j/k scroll, i focus) |

## Rendering Pipeline

| Renderer | Handles |
|----------|---------|
| `MessageRenderer` | Orchestrates all rendering, manages message containers, fork button on user messages |
| `ToolCallRenderer` | Tool use blocks with status, input display |
| `ThinkingBlockRenderer` | Extended thinking with collapse/expand |
| `WriteEditRenderer` | File operations with before/after diff |
| `DiffRenderer` | Hunked inline diffs (del/ins highlighting) |
| `InlineExitPlanMode` | Claude plan mode approval card (approve/feedback/new session) |
| `InlinePlanApproval` | Plan completion approval card (implement/revise/cancel) |
| `InlineAskUserQuestion` | AskUserQuestion inline card |
| `TodoListRenderer` | Todo items with status icons |
| `SubagentRenderer` | Background agent progress |

## Key Patterns

### Lazy Tab Initialization
```typescript
// Chat runtime created on first query, not on tab create
tab.ensureService(); // Creates runtime if needed
```

### Message Rendering
```typescript
// StreamController receives SDK messages
for await (const message of response) {
  this.messageRenderer.render(message);  // Updates DOM
  this.chatState.appendMessage(message); // Persists
}
```

### Auto-Scroll
- Enabled by default during streaming
- User scroll-up disables; scroll-to-bottom re-enables
- Resets to setting value on new query

## Gotchas

- `ClaudianView.onClose()` must abort all tabs and dispose services
- Tab switching preserves scroll position per-tab
- `ChatState` is per-tab; `TabManager` coordinates across tabs (including fork orchestration)
- Title generation runs concurrently per-conversation (separate AbortControllers)
- `FileContext` has nested state in `ui/file-context/state/`
- `/compact` has a special code path: `InputController` skips context mentions so the SDK recognizes the built-in command; `ClaudeTurnEncoder` skips context appending for compact; `StreamController` handles the `context_compacted` chunk as a standalone separator; `ClaudeHistoryStore` (in `src/providers/claude/history/`) prevents merge with adjacent assistant messages; ESC during compact produces an SDK stderr (`Compaction canceled`) that the history store maps to `isInterrupt` for persistent rendering
- `/compact` (Codex): `encodeCodexTurn` detects `/compact` and sets `isCompact: true`, skipping all context. `CodexChatRuntime.query()` routes compact turns to `thread/compact/start` instead of `turn/start`. The turn ID is established via `turn/started` notification (not the RPC response). Bare `/compact` only — extra arguments emit a local error before any thread-side effect. The live separator is emitted when the `contextCompaction` item completes. Auto-compaction was already supported via `contextCompaction` item. History reload applies persisted `compacted.replacement_history` and renders the durable `context_compacted` boundary marker.
- Plan mode (Claude): `EnterPlanMode` is auto-approved by the SDK (detected in stream to sync UI); `ExitPlanMode` uses a dedicated callback in `canUseTool` that bypasses normal approval flow. Shift+Tab toggles plan mode and saves/restores the previous permission mode. "Approve (new session)" stops the current session and auto-sends plan content as the first message in a fresh session.
- Plan mode (Codex): Client-driven via `collaborationMode` on `turn/start`. `CodexNotificationRouter.beginTurn()` tracks plan state per-turn. After a successful plan turn with plan deltas, the runtime records `planCompleted` in turn metadata; `InputController` consumes that metadata in its post-stream `finally` block to trigger `InlinePlanApproval`. "Implement" restores pre-plan mode and auto-sends a follow-up. "Revise" keeps plan mode and populates feedback in the input. The approval flow is invalidation-safe: if the conversation switches or tab closes while the prompt is open, the pending promise resolves and the post-await guard exits.
- Bang-bash mode: `!` in empty input triggers direct bash execution (bypasses Claude). `BangBashModeManager` manages input mode; `BangBashService` runs commands via `child_process.exec` (30s timeout, 1MB buffer). Output displays in `StatusPanel` command panel. ESC exits mode; Enter submits.
- Fork conversation: `Tab.handleForkRequest()` validates eligibility (not streaming, both user and preceding assistant messages have SDK UUIDs), deep clones messages up to the fork point, then delegates to `TabManager`. `/fork` command triggers `Tab.handleForkAll()`, which forks the entire conversation (all messages, resuming at the last assistant UUID). Both handlers share `resolveForkSource()` which delegates to `ChatRuntime.resolveSessionIdForFork()` for session ID resolution. `TabManager` shows `ForkTargetModal` (new tab vs current tab), creates the fork conversation with fork metadata, and propagates title/currentNote. `ConversationController.switchTo()` hands the conversation to `ChatRuntime.syncConversationState()`, which lets the Claude implementation restore fork state before the next query. Fork titles are deduplicated across existing tabs.
