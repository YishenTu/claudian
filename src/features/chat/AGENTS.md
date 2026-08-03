# Chat Feature

`src/features/chat/` owns the main sidebar chat interface. It assembles tabs, controllers, renderers, and provider-backed services around provider-neutral execution contracts.

## Dependency Direction

- `ClaudianView` is the view-level composition root. It constructs view services, `TabManager`, `TabBar`, layout DOM, and callbacks.
- `TabManager` and the lifecycle functions in `Tab.ts` construct and wire each tab's state, controllers, renderers, provider services, and UI components.
- Controllers request conversation and execution changes through injected callbacks, `FeatureHost`, and `ChatExecutionCoordinator`; cross-tab operations remain `TabManager` authority.
- Execution orchestration depends on core execution and provider contracts, never concrete provider implementations.
- Renderers and UI components may render state and emit user intent. They must not mutate tab membership, conversation persistence, or provider-session lifecycle directly.
- Provider behavior is resolved through `ProviderRegistry`, `ProviderWorkspaceRegistry`, capabilities, and provider UI config. Do not add provider-ID branches when one of those contracts can express the behavior.

## Provider Boundary

- Feature code depends on execution sessions, `ProviderCapabilities`, provider-neutral `Conversation`, and provider-neutral execution events.
- `InputController` builds canonical execution requests; providers own native prompt encoding.
- Do not read provider-specific fields from `Conversation.providerState` in feature code. Use execution snapshots, provider history services, or typed provider helpers.
- Resolve provider-owned services through registries:
  - `ProviderRegistry`: execution backends, title generation, instruction refinement, inline edit, task-result interpretation.
  - `ProviderWorkspaceRegistry`: command catalogs, agent mentions, MCP managers, CLI resolution, settings tabs.

## Ownership

Use `owns` here to mean the source of truth or exclusive coordinator for a mutation. Non-owners must request changes through the owner's public operations and must not maintain independently mutable copies.

| Component | Owns |
| --- | --- |
| `TabManager` | Open-tab membership, active-tab selection, create/switch/close/restore operations, and the tab/session portion of the persisted layout snapshot |
| `TabSession` | Authoritative per-tab identity, conversation binding, provider binding, lifecycle value, execution-coordinator attachment, active-turn reference, and background-work sequencing |
| `ChatExecutionCoordinator` | One tab's provider-session binding, active execution, interaction fencing, cancellation, and disposal |
| `ChatState` | Transient per-tab message projection, stream state, queued input, render state, and conversation-operation flags |
| `TabStatePersistenceCoordinator` | Debouncing, snapshotting, ordering, retry retention, and flushing of tab-layout writes |
| `TabBar` | Expanded-title presentation state for the current view |
| `ClaudianView` | View assembly, rendered DOM placement, presentation coordination, and assembly of the complete persisted layout snapshot |

`TabSession` stores lifecycle values, while lifecycle operations in `Tab.ts` and `TabManager` perform the transitions. Controllers, renderers, and UI components must request those operations instead of assigning lifecycle state themselves.

`TabStatePersistenceCoordinator` owns write sequencing, not the semantic tab state. It receives complete snapshots assembled by `ClaudianView` from `TabManager` and `TabBar`; it must not infer, add, or remove tabs.

## State Model

Keep these layers independent:

1. **Durable conversation state**
   - Claudian's in-memory conversation projection, metadata, input ledger, and provider resume snapshot are coordinated by the application conversation repository.
   - Provider-native transcripts remain provider-owned replay sources and are read-only.
2. **Persisted tab shell**
   - `AppTabManagerState` stores open tab IDs, conversation bindings, the active tab ID, blank-tab draft models, and supported presentation metadata.
   - It survives plugin reload, but must not contain DOM, controllers, hydrated messages, pending turns, execution sessions, or provider-native state.
3. **Runtime tab state**
   - `TabSession`, `ChatState`, controllers, renderers, and DOM exist only for the current view runtime.
   - Hydration state is independent from both active-tab selection and provider execution state.
4. **Provider execution state**
   - `ChatExecutionCoordinator` owns the live per-tab execution binding.
   - Core lifecycle leases fence provider-wide transitions; they are not tab state and do not imply an LRU or global execution pool.

## Tab Lifecycle

Valid lifecycle values are:

```text
blank | bound_cold | bound_active | closing
```

- A new unbound tab starts `blank`; a restored or selected conversation without a runtime starts `bound_cold`.
- Preparing a provider session for a bound conversation changes `bound_cold` to `bound_active`.
- Rebinding or clearing the conversation releases the old binding and returns the tab to `bound_cold` or `blank`.
- Closing changes any live tab to `closing`, prevents new hydration work, saves when required, disposes execution resources, and removes the tab from `TabManager`.
- `TabHydrationState` (`idle | loading | ready | failed`) is orthogonal to this lifecycle. Do not infer execution state from hydration, visibility, or active selection.

## State Flow

```text
User input
  -> InputController
  -> ensure coordinator for active provider
  -> build canonical execution request
  -> execute provider session
  -> StreamController
  -> renderers + transient ChatState projection
  -> application conversation persistence
```

Tab activation and conversation hydration do not themselves authorize creation of a provider execution session. Warmup must be explicit and provider-owned through `ProviderTabWarmupPolicy`. Command-only discovery must stay isolated and must not create a real chat session for a history-backed conversation; execution warmup is allowed only when the registered policy explicitly returns `execution`.

## Invariants

- Every create and fork path must enforce the configured tab limit and the `MIN_TABS`/`MAX_TABS` bounds.
- Restoring tab layout must not create provider executions for every restored tab. Background restored tabs remain shells until targeted work requires more.
- Switching the active tab must not cancel, dispose, or transfer another tab's active execution.
- Closing a tab disposes its runtime resources but never deletes its conversation or provider-native transcript.
- Deleting a conversation is a separate application operation and must not be inferred from tab closure or layout changes.
- Persisted tab state must exclude hydrated messages, DOM, controllers, pending work, and execution-session objects.
- Layout and presentation changes must not alter conversation binding or execution lifecycle.
- A stale provider generation, session binding, or stream generation must not update the current tab.
- Provider command and metadata warmup must respect provider resource generations and must not reuse stale results.

## Gotchas

- `ClaudianView.onClose()` must abort active tabs and dispose execution coordinators.
- `ChatState` is a transient per-tab projection, not the durable conversation source of truth. `TabManager` coordinates tab-level operations such as forks and provider-aware command catalogs.
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
