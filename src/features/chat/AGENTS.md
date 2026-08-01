# Chat Feature

`src/features/chat/` owns the main sidebar chat interface. It assembles tabs, controllers, renderers, and provider-backed services around provider-neutral execution contracts.

## Provider Boundary

- Feature code depends on execution sessions, `ProviderCapabilities`, provider-neutral `Conversation`, and provider-neutral execution events.
- `InputController` builds canonical execution requests; providers own native prompt encoding.
- Do not read provider-specific fields from `Conversation.providerState` in feature code. Use execution snapshots, provider history services, or typed provider helpers.
- Resolve provider-owned services through registries:
  - `ProviderRegistry`: execution backends, title generation, instruction refinement, inline edit, task-result interpretation.
  - `ProviderWorkspaceRegistry`: command catalogs, agent mentions, MCP managers, CLI resolution, settings tabs.

## State Flow

```text
User input
  -> InputController
  -> ensure coordinator for active provider
  -> build canonical execution request
  -> execute provider session
  -> StreamController
  -> renderers + ChatState persistence
```

Tabs stay cold until the first send. Keep metadata warmup explicit and provider-owned so command discovery does not accidentally create real execution sessions for history-backed conversations.

## Main Parts

| Area | Owns |
| --- | --- |
| `ClaudianView` | Lifecycle, assembly, active-tab orchestration |
| `ChatState` | Per-tab state and persistence inputs |
| Controllers | Conversation, stream, input, selection, browser/canvas selection, navigation |
| Renderers | Messages, tools, thinking, diffs, todos, subagents, plan approval, ask-user UI |
| Tabs | Tab manager, tab bar, tab state |
| UI components | Input toolbar, context managers, status panel, navigation sidebar, mode managers |

## Gotchas

- `ClaudianView.onClose()` must abort active tabs and dispose execution coordinators.
- `ChatState` is per-tab. `TabManager` coordinates tab-level operations such as forks and provider-aware command catalogs.
- Title generation runs concurrently per conversation and routes by the global title-generation model, not the active chat tab provider.
- `/compact` is provider-specific:
  - Claude skips context injection so the provider handles the built-in command.
  - Codex routes compact turns to `thread/compact/start` and persists `context_compacted`.
  - Pi sends a `compact` RPC request.
- Plan mode is provider-specific:
  - Claude uses provider/runtime events for enter and exit.
  - Codex uses `collaborationMode` plus post-stream metadata.
  - OpenCode maps managed modes to shared permission modes.
- Bang-bash mode bypasses provider execution and runs a local shell command directly. It is available only when the enabled provider exposes it in `ProviderChatUIConfig`.
- Forking is provider-owned under the hood. Use execution and provider history contracts instead of reconstructing provider session IDs in feature code.
