# Chat Feature

Main sidebar chat interface. `ClaudianView` is a thin shell; logic lives in controllers and services.

## Architecture

```
ClaudianView (lifecycle + assembly)
├── ChatState (centralized state)
├── Controllers
│   ├── ConversationController  # History, session switching
│   ├── StreamController        # Streaming, auto-scroll, abort
│   ├── InputController         # Text input, file context, images
│   ├── SelectionController     # Editor selection awareness
│   └── NavigationController    # Keyboard navigation (vim-style)
├── Services
│   ├── TitleGenerationService  # Auto-generate conversation titles
│   ├── SubagentManager          # Unified sync/async subagent lifecycle
│   ├── InstructionRefineService # "#" instruction mode
│   └── BangBashService          # Direct bash execution ("!" mode)
├── Rendering
│   ├── MessageRenderer         # Main rendering orchestrator
│   ├── ToolCallRenderer        # Tool use blocks
│   ├── ThinkingBlockRenderer   # Extended thinking
│   ├── WriteEditRenderer       # File write/edit with diff
│   ├── DiffRenderer            # Inline diff display
│   ├── TodoListRenderer        # Todo panel
│   ├── SubagentRenderer        # Subagent status panel
│   ├── InlineExitPlanMode      # Plan mode approval card
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
    ├── StatusPanel             # Todo/subagent/command output panels container
    ├── InstructionModeManager  # "#" mode UI
    └── BangBashModeManager     # "!" bash mode UI
```

## State Flow

```
User Input → InputController → ClaudianService.query()
                                      ↓
                              StreamController (handle messages)
                                      ↓
                              MessageRenderer (update DOM)
                                      ↓
                              ChatState (persist)
```

## Controllers

| Controller | Responsibility |
|------------|----------------|
| `ConversationController` | Load/save sessions, history panel, session switching, fork session setup |
| `StreamController` | Process SDK messages, auto-scroll, streaming UI state |
| `InputController` | Input textarea, file/image attachments, slash commands |
| `SelectionController` | Poll editor selection (250ms), CM6 decoration |
| `NavigationController` | Vim-style keyboard navigation (j/k scroll, i focus) |

## Rendering Pipeline

| Renderer | Handles |
|----------|---------|
| `MessageRenderer` | Orchestrates all rendering, manages message containers, fork button on user messages |
| `ToolCallRenderer` | Tool use blocks with status, input display |
| `ThinkingBlockRenderer` | Extended thinking with collapse/expand |
| `WriteEditRenderer` | File operations with before/after diff |
| `DiffRenderer` | Hunked inline diffs (del/ins highlighting) |
| `InlineExitPlanMode` | Plan mode approval card (approve/feedback/new session) |
| `InlineAskUserQuestion` | AskUserQuestion inline card |
| `TodoListRenderer` | Todo items with status icons |
| `SubagentRenderer` | Background agent progress |

## Key Patterns

### Lazy Tab Initialization
```typescript
// ClaudianService created on first query, not on tab create
tab.ensureService();  // Creates service if needed
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
- `/compact` has a special code path: `InputController` skips context XML appending so the SDK recognizes the built-in command; `StreamController` handles the `compact_boundary` chunk as a standalone separator; `sdkSession.ts` prevents merge with adjacent assistant messages; ESC during compact produces an SDK stderr (`Compaction canceled`) that `sdkSession.ts` maps to `isInterrupt` for persistent rendering
- Plan mode: `EnterPlanMode` is auto-approved by the SDK (detected in stream to sync UI); `ExitPlanMode` uses a dedicated callback in `canUseTool` that bypasses normal approval flow. Shift+Tab toggles plan mode and saves/restores the previous permission mode. "Approve (new session)" stops the current session and auto-sends plan content as the first message in a fresh session.
- Bang-bash mode: `!` in empty input triggers direct bash execution (bypasses Claude). `BangBashModeManager` manages input mode; `BangBashService` runs commands via `child_process.exec` (30s timeout, 1MB buffer). Output displays in `StatusPanel` command panel. ESC exits mode; Enter submits.
- Fork conversation: `Tab.handleForkRequest()` validates eligibility (not streaming, both user and preceding assistant messages have SDK UUIDs), deep clones messages up to the fork point, then delegates to `TabManager`. `/fork` command triggers `Tab.handleForkAll()`, which forks the entire conversation (all messages, resuming at the last assistant UUID). Both handlers share `resolveForkSource()` for session ID resolution and conversation metadata lookup. `TabManager` shows `ForkTargetModal` (new tab vs current tab), creates the fork conversation with `forkSource: { sessionId, resumeAt }` metadata, sets `sdkMessagesLoaded` to prevent duplicate message loading, and propagates title/currentNote. `ConversationController.switchTo()` detects fork metadata and sets `pendingForkSession`/`pendingResumeAt` on `ClaudianService` so the SDK resumes at the correct point. Fork titles are deduplicated across existing tabs.
