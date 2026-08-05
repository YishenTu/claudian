# Chat Feature

`src/features/chat/` owns the main sidebar chat interface. It assembles tabs, controllers, renderers, and provider-backed services around provider-neutral execution contracts.

## Boundaries

- Controllers request conversation and execution changes through injected callbacks, `FeatureHost`, and `ChatExecutionCoordinator`; cross-tab operations remain `TabManager` authority.
- Renderers and UI components may render state and emit user intent. They must not mutate tab membership, conversation persistence, or provider-session lifecycle directly.
- `InputController` builds canonical execution requests; providers own native prompt encoding.
- Resolve provider-owned services through registries:
  - `ProviderRegistry`: execution backends, title generation, instruction refinement, inline edit, task-result interpretation.
  - `ProviderWorkspaceRegistry`: command catalogs, agent mentions, MCP managers, CLI resolution, settings tabs.

## Ownership

| Component | Authority |
| --- | --- |
| `TabManager` | Runtime-tab membership, active-tab selection, and create/switch/close operations |
| `TabSession` | Authoritative per-tab identity, conversation binding, provider binding, lifecycle value, execution-coordinator attachment, active-turn reference, and background-work sequencing |
| `ChatExecutionCoordinator` | One tab's provider-session binding, active execution, interaction fencing, cancellation, and disposal |
| `WarmExecutionPool` | Application-scoped warm execution ownership, the configured concurrent-running-session limit, and least-recently-used cooling of idle owners |
| `ChatState` | Transient per-tab message projection, stream state, queued input, render state, and conversation-operation flags |
| `TabStatePersistenceCoordinator` | Debouncing, snapshotting, ordering, retry retention, and flushing of tab-layout writes |
| `TabBar` | Expanded-title presentation state for the current view |
| `ClaudianView` | View assembly, rendered DOM placement, presentation coordination, layout-mode navigation, and assembly of the persisted current-tab snapshot |

`TabSession` stores lifecycle values, while lifecycle operations in `Tab.ts` and `TabManager` perform the transitions. Controllers, renderers, and UI components must request those operations instead of assigning lifecycle state themselves.

`TabStatePersistenceCoordinator` owns write sequencing, not semantic tab state. It receives the active tab identity assembled by `ClaudianView`; it must not infer, add, or remove runtime tabs.

## State Model

Keep these layers independent:

1. **Durable conversation state**
   - Claudian's in-memory conversation projection, metadata, input ledger, and provider resume snapshot are coordinated by the application conversation repository.
   - Provider-native transcripts remain provider-owned replay sources and are read-only.
2. **Persisted tab shell**
   - `AppTabManagerState` currently stores only the active tab ID and its conversation binding. Legacy multi-tab snapshots are restored as the current tab only.
   - Runtime tab membership, blank drafts, and expanded-title presentation are intentionally discarded on plugin reload. The snapshot must not contain DOM, controllers, hydrated messages, pending turns, execution sessions, or provider-native state.
3. **Runtime tab state**
   - `TabSession`, `ChatState`, controllers, renderers, and DOM exist only for the current view runtime.
   - Hydration state is independent from both active-tab selection and provider execution state.
4. **Provider execution state**
   - `ChatExecutionCoordinator` owns the live per-tab execution binding.
   - `WarmExecutionPool` limits warm execution owners without limiting runtime tabs. It may cool only idle owners; active executions and unresolved interactions are protected.
   - Core lifecycle leases fence provider-wide transitions. They are independent from the feature-owned warm execution pool and are not tab state.

## Tab Lifecycle

Valid lifecycle values are:

```text
provisional | cold | warm | closing
```

- A dual-mode history selection may create or reuse one `provisional` preview. Selecting sessions alone must not retain every preview as a runtime tab.
- User interaction, pinning, or another explicit retain operation commits a provisional preview to `cold`.
- A retained or restored tab without provider execution resources is `cold`, including an unbound draft.
- Acquiring and preparing provider execution resources changes a retained tab to `warm`. The warm pool may return an idle tab to `cold` without closing the tab or conversation.
- Returning from dual mode discards provisional previews, except that the active preview is retained when no cold or warm tab exists. Cold and warm tabs remain available to the single-panel tab bar.
- Closing changes any live tab to `closing`, prevents new hydration work, saves when required, disposes execution resources, and removes the tab from `TabManager`.
- `TabHydrationState` (`idle | loading | ready | failed`) is orthogonal to this lifecycle. Do not infer execution state from hydration, visibility, or active selection.

Tab activation and conversation hydration do not themselves authorize creation of a provider execution session. A selected history session stays provisional or cold until interaction requires execution. `ProviderTabWarmupPolicy` may request isolated command discovery; the reserved `execution` mode is currently a no-op and must not create a chat session. Command-only discovery must stay isolated and must not create a real chat session for a history-backed conversation.

## Layout Modes

- Single-panel mode keeps the tab bar and tab-aware history navigation. New Conversation and `/clear` replace the active tab's conversation, and fork prompts for the target tab.
- Dual-pane mode hides the tab bar, exposes the persistent session manager, treats history navigation as provisional preview selection, and always forks into a new retained runtime tab.
- Layout changes navigation only. They must not rewrite conversation grouping, provider state, or durable session metadata.

## Invariants

- Runtime tab creation is unlimited. The configured `maxWarmAgentProcesses` limit applies only to warm execution owners and is normalized to the supported 5-10 range.
- Cooling an idle tab must preserve its runtime tab, conversation binding, hydrated UI state, and resumable provider snapshot.
- Returning to single-panel mode must keep dual-pane controls in place until provisional-tab cleanup completes; compact controls must never target a tab already being closed.
- Switching the active tab must not cancel, dispose, or transfer another tab's active execution.
- Closing a tab disposes its runtime resources but never deletes its conversation; conversation deletion is a separate application operation.
- Layout and presentation changes must not alter conversation binding or execution lifecycle.
- A stale provider generation, session binding, or stream generation must not update the current tab.
- Warm preparation is provisional until the coordinator revalidates its conversation binding and disposal generation after acquisition and snapshot persistence; superseded work must not install, retain, or publish a warm provider session.
- Conversation navigation is latest-wins across provisional and retained targets; provisional cleanup blocks new navigation while it invalidates and drains pending work, and manager teardown fences all later requests.
- Focusable, selectable history rows support Enter and Space activation as well as pointer activation.
- Provider command and metadata warmup must respect provider resource generations and must not reuse stale results.

## Gotchas

- `ClaudianView.onClose()` must abort active tabs and dispose execution coordinators.
- Bang-bash mode bypasses provider execution and runs a local shell command directly. It is available only when the enabled provider exposes it in `ProviderChatUIConfig`.
- Forking is provider-owned under the hood. Use execution and provider history contracts instead of reconstructing provider session IDs in feature code.
