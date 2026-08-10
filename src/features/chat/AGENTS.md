# Chat Feature

`src/features/chat/` owns the main sidebar chat interface. It assembles tabs, controllers, renderers, and provider-backed services around provider-neutral execution contracts.

## Boundaries

- Controllers request conversation and execution changes through injected callbacks, `FeatureHost`, and `ChatExecutionCoordinator`; cross-tab operations remain `TabManager` authority.
- Renderers and UI components may render state and emit user intent. They must not mutate tab membership, conversation persistence, or provider-session lifecycle directly.
- `InputController` builds canonical execution requests; providers own native prompt encoding.
- Resolve provider-owned services through registries:
  - `ProviderRegistry`: execution backends, title generation, instruction refinement, inline edit, task-result interpretation.
  - `ProviderWorkspaceRegistry`: command catalogs, agent mentions, CLI resolution, settings tabs.

## Ownership

| Component | Authority |
| --- | --- |
| `TabManager` | Runtime-tab membership, active-tab selection, and create/switch/close operations |
| `TabRuntimeFactory` | Atomic per-tab assembly, publication, and rollback. It privately orchestrates complete runtime bundles and returns only assembled runtimes to `TabManager` |
| `TabLifecycle` | Runtime activation/deactivation, provisional retention, shutdown drainage, teardown, and display-title helpers |
| `TabProviderState` | Provider/model/settings resolution, provider UI gating, workspace-service synchronization, and execution initialization |
| `TabSessionEvents` | Provider-session event routing, background-work sequencing, and automatic-turn rendering |
| `TabForking` | Fork-source resolution and immutable fork-context preparation |
| `TabSession` | Authoritative per-tab identity, conversation binding, provider binding, lifecycle value, immutable execution-coordinator reference and disposal, active-turn reference, and background-work sequencing |
| `TabModelSelectionCoordinator` | Per-tab model-selection request ordering, blank-tab provider-transition serialization, and stable-draft rollback |
| `ChatExecutionCoordinator` | One tab's provider-session binding, active execution, interaction fencing, cancellation, and disposal |
| `WarmExecutionPool` | Application-scoped warm execution ownership, the configured concurrent-running-session limit, and least-recently-used cooling of idle owners |
| `ChatState` | Transient per-tab message projection, stream state, queued input, render state, and conversation-operation flags |
| `TabStatePersistenceCoordinator` | Debouncing, snapshotting, ordering, retry retention, and flushing of tab-layout writes |
| `TabBar` | Expanded-title presentation state for the current view |
| `ClaudianView` | View assembly, rendered DOM placement, presentation coordination, layout-mode navigation, and assembly of the persisted current-tab snapshot |

`TabSession` stores lifecycle values, while lifecycle operations in `TabLifecycle` and `TabManager` perform the transitions. Controllers, renderers, and UI components must request those operations instead of assigning lifecycle state themselves.

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
   - `TabSession`, `ChatState`, controllers, renderers, and DOM exist only for the current view runtime. An unbound tab snapshots its own provider/model draft when created.
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
- `TabManager` admits a tab to runtime membership and calls `onTabCreated` only after structural assembly succeeds. Construction readiness means UI, controllers, renderer, coordinator, and input wiring are installed; it does not imply hydration, activation, conversation binding, or warm provider execution.
- Tab IDs are reserved before asynchronous assembly. Admission callbacks and activation are one transaction: failure must remove and destroy the assembled runtime, release its metadata, and restore the previous active owner.
- A close reservation synchronously pauses the tab session's intent admission, fences duplicate close requests, and remains reversible through fallible replacement admission and, for the active tab, successor activation and active-tab publication. Required runtime state callbacks and command-context invalidation remain accepted until those prerequisites succeed and lifecycle becomes terminal `closing`; failed preflight resumes intent admission, while failed successor switching restores and republishes the predecessor before resuming intent admission.
- Each queued tab-switch request owns its completion and failure. A switch requested by tab admission must await its real activation attempt so callback failure rolls that admission back instead of escaping through an unrelated earlier switch.
- `TabManager.destroy()` is terminal: new or in-flight tab assembly must not enter membership afterward, runtime-retained intents must revalidate their source tab before manager or view work, and overlapping close requests must not repeat persistence, callbacks, or teardown side effects.
- Fork operations capture the source tab and exact conversation binding before their first asynchronous source lookup or target prompt. Revalidate that lease after every await and copy accepted-input state by the captured conversation ID, never the coordinator's current binding.
- View shutdown closes intent admission, invalidates and joins conversation navigation and tab switching, then keeps terminal conversation-binding callbacks open while every admitted tab cancels and drains active/background work. Only that complete quiescence boundary may flush and seal the final tab identity. A reopen overlapping it reuses the same persistence coordinator and awaits the closing snapshot before restoration.
- `AssembledTabRuntime` keeps required structural references stable after publication, including while `closing` and after resource disposal. Operational availability is expressed by lifecycle state and read-only resource state; teardown authority remains internal and must not null required references.
- Construction builders under `tabs/runtime/` are internal to `TabRuntimeFactory` and return complete shell, service, UI, controller/renderer, and input-binding bundles. They may depend on focused tab-domain modules but never import the factory, manager, or view. Every acquired resource must register rollback immediately; rollback and teardown are idempotent, best-effort, and continue after individual cleanup failures.
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
- An explicit chat model-picker action updates only the current blank tab or bound conversation and the provider-qualified global seed for future blank tabs. Existing tabs never subscribe to that seed.
- The app-owned chat model-selection coordinator orders global seed commits by picker intent across the plugin, not by asynchronous provider-switch or conversation-write completion; the latest successful selection wins. Each commit must revalidate its caller-provided exact runtime/conversation ownership predicate at the serialized settings mutation point, so stale tabs cannot seed future drafts.
- `TabModelSelectionCoordinator` serializes blank-tab provider changes per tab. Later choices targeting an in-flight provider share its initialization result, and failed overlapping transitions restore the last stable provider/model without seeding future tabs.
- Restoration, hydration, automatic availability fallback, fork inheritance, and auxiliary executions must not update the future-tab model seed.

## Gotchas

- `ClaudianView.onClose()` must abort active tabs and dispose execution coordinators.
- Bang-bash mode bypasses provider execution and runs a local shell command directly. It is available only when the enabled provider exposes it in `ProviderChatUIConfig`.
- Forking is provider-owned under the hood. Use execution and provider history contracts instead of reconstructing provider session IDs in feature code.
