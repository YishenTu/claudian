# Chat Feature

`src/features/chat/` owns the main sidebar chat interface. It assembles tabs, controllers, renderers, and provider-backed services around provider-neutral execution contracts.

## Boundaries

- Controllers request conversation and execution changes through injected callbacks, `FeatureHost`, and `ChatExecutionCoordinator`; cross-tab operations remain `TabManager` authority.
- Renderers and UI components may render state and emit user intent. They must not mutate tab membership, conversation persistence, or provider-session lifecycle directly.
- `InputController` builds canonical execution requests; providers own native prompt encoding.
- App-provided Main Agent dynamic sections are best-effort provider-default system instructions. Resolve them before ordinary or steered execution, never encode them as input blocks, expose them in rendered text, or persist them in Claudian's input ledger, and never let resolution failure block Chat.
- `TabRuntimeInputBindings` is the sole Main Chat owner of composer input and keydown forwarding. Shared dropdown sources contribute matching, loading, and selection semantics but must not install their own input listeners.
- Main Chat obtains Collab composer references only through the optional `FeatureHost.collabComposerReferences` port. Those menus use the Collab Panel's effective selected Project without mutating selection and insert only visible plain text; no hidden entity metadata enters messages or persistence.
- Collab surface availability, composer references, and the Collab dynamic system-prompt section all follow the application-owned live Collab enablement predicate. Disabled views must remove Collab from surface rotation, destroy an instantiated Collab controller, and preserve the active chat tab; plugin-lifetime composer ports reset to a cold unavailable state rather than becoming terminally disposed.
- Single-panel and dual-pane Collab presentation share one lazy `CollabPanel` controller and one rendered DOM tree. `ClaudianView` reparents that surface between the compact nav dropup and persistent sidebar; closing the dropup only deactivates it, while disabling Collab or closing the view destroys it. History and compact Collab dropups are mutually exclusive.
- Sidebar surface swipes use one native horizontal scroll container with mandatory snap points. Chromium owns wheel transactions, momentum, drag position, and gesture completion; do not classify physical swipes from delta strength or idle timers, cancel wheel events, or translate the surface strip. Preload the first horizontal drag target without changing semantic activity. For swipe navigation, commit `activeSidebarSurface`, `inert`, `aria-hidden`, and provider surface activation only from `scrollend` after snap completion. This keeps the wheel target valid through Chromium's transaction when the pointer is stationary. With exactly two enabled surfaces, keep the live active surface at the center snap and use one inert, accessibility-hidden visual replica so the other logical surface occupies both adjacent snaps. The replica owns no controller or semantic state, both copies map to the same logical surface, and replica refresh must happen during alignment rather than wheel or scroll dispatch.
- Resolve provider-owned services through registries:
  - `ProviderRegistry`: execution backends, title generation, instruction refinement, inline edit, task-result interpretation.
  - `ProviderWorkspaceRegistry`: command catalogs, agent mentions, CLI resolution, settings tabs.

## Ownership

| Component | Authority |
| --- | --- |
| `TabManager` | Runtime-tab membership, active-tab selection, create/switch/close operations, and capture/restoration of open tab shells |
| `TabRuntimeFactory` | Atomic per-tab assembly, publication, and rollback. It privately orchestrates complete runtime bundles and returns only assembled runtimes to `TabManager` |
| `TabLifecycle` | Runtime activation/deactivation, provisional retention, shutdown drainage, teardown, and display-title helpers |
| `TabProviderState` | Provider/model/settings resolution, provider UI gating, workspace-service synchronization, and execution initialization |
| `MainChatComposerDropdown` | One dropdown controller and source set for provider slash commands, Vault/external/Agent mentions, and optional Collab Member Changes/Ticket references |
| `LinkedContentController` | One tab's Linked content selection, greeting selector, context-tray projection, first-create submission freeze, immutable lock, and Vault path-event reconciliation |
| `TabSessionEvents` | Provider-session event routing, background-work sequencing, and automatic-turn rendering |
| `TabForking` | Fork-source resolution and immutable fork-context preparation |
| `TabSession` | Authoritative per-tab identity, conversation binding, provider binding, lifecycle value, immutable execution-coordinator reference and disposal, active-turn reference, and background-work sequencing |
| `TabModelSelectionCoordinator` | Per-tab model-selection request ordering, blank-tab provider-transition serialization, and stable-draft rollback |
| `ChatExecutionCoordinator` | One tab's provider-session binding, active execution, interaction fencing, cancellation, and disposal |
| `WarmExecutionPool` | Application-scoped warm execution ownership, the configured concurrent-running-session limit, and least-recently-used cooling of idle owners |
| `ChatState` | Transient per-tab message projection, stream state, queued input, render state, and conversation-operation flags |
| `TabStatePersistenceCoordinator` | Debouncing, snapshotting, ordering, retry retention, and flushing of tab-layout writes |
| `TabBar` | Expanded-title presentation state for the current view |
| `ClaudianView` | View assembly, rendered DOM placement, presentation coordination, layout-mode navigation, startup restore-policy application, and view-scoped tab-state publication |

`TabSession` stores lifecycle values, while lifecycle operations in `TabLifecycle` and `TabManager` perform the transitions. Controllers, renderers, and UI components must request those operations instead of assigning lifecycle state themselves.

`TabStatePersistenceCoordinator` owns write sequencing, not semantic tab state. It receives open-tab snapshots captured by `TabManager` plus view presentation metadata assembled by `ClaudianView`; it must not infer, add, or remove runtime tabs.

## State Model

Keep these layers independent:

1. **Durable conversation state**
   - Claudian's in-memory conversation projection, metadata, input ledger, and provider resume snapshot are coordinated by the application conversation repository.
   - Provider-native transcripts remain provider-owned replay sources and are read-only.
2. **Persisted tab shell**
   - Each Claudian view persists every open tab shell, tab order, actual active tab, conversation bindings, unbound-tab model seeds, and expanded-title tab IDs in Obsidian view state. Runtime lifecycle values are not part of the snapshot.
   - Startup restoration is a boolean preference that defaults on. When enabled, single-pane mode restores every open shell while dual-pane mode restores only the last active shell; when disabled, either layout starts fresh.
   - Unsent composer content, DOM, controllers, hydrated messages, pending turns, execution sessions, and provider-native state are never persisted.
   - Every restored tab enters as `cold`. Restore admits inactive tabs first and performs one final activation so restoration cannot warm background tabs accidentally.
   - The former plugin-global tab snapshot is a migration source for one primary view only, never concurrent live authority.
   - `ClaudianView.onOpen()` may assemble the runtime shell, but initial tab restoration waits for Obsidian's `setState()` delivery. A same-instance reopen instead restores the finalized shutdown snapshot so an older delivered layout cannot replace it.
   - Versioned view-state decoding is fail-closed: one malformed tab, duplicate ID, invalid active target, or invalid expanded-title target rejects the entire view snapshot. Permissive normalization is reserved for the legacy plugin-global migration source.
3. **Runtime tab state**
   - `TabSession`, `ChatState`, controllers, renderers, and DOM exist only for the current view runtime. An unbound tab snapshots its own provider/model draft when created.
   - Each tab owns exactly one `LinkedContentController`. An unbound auto draft may follow its active eligible Markdown Note; explicit selection is sticky, and a durable Conversation always projects a locked file, folder, missing, or unlinked identity. The Vault root is not a valid Linked content target.
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
- Entering dual mode preserves the retained working set unchanged. On reload, the initial responsive layout determines whether all open shells or only the last active shell are restored.
- Closing changes any live tab to `closing`, prevents new hydration work, saves when required, disposes execution resources, and removes the tab from `TabManager`.
- `TabHydrationState` (`idle | loading | ready | failed`) is orthogonal to this lifecycle. Do not infer execution state from hydration, visibility, or active selection.

Tab activation and conversation hydration do not themselves authorize creation of a provider execution session. A selected history session stays provisional or cold until interaction requires execution. `ProviderTabWarmupPolicy` may request isolated command discovery; the reserved `execution` mode is currently a no-op and must not create a chat session. Command-only discovery must stay isolated and must not create a real chat session for a history-backed conversation.

## Layout Modes

- Single-panel mode keeps the tab bar and tab-aware history navigation. New Conversation and `/clear` replace the active tab's conversation, and fork prompts for the target tab.
- Dual-pane mode hides the tab bar, exposes the persistent session manager, treats history navigation as provisional preview selection, and always forks into a new retained runtime tab.
- Layout changes navigation only. They must not rewrite conversation grouping, provider state, or durable session metadata.

## Invariants

- Runtime tab creation is unlimited. The configured `maxWarmAgentProcesses` limit applies only to warm execution owners and is normalized to the supported 5-10 range.
- `TabManager` calls `onTabCreated` for every newly created open shell only after structural assembly and required activation commit. Its persistence projection excludes uncommitted membership. Inactive retained and provisional admission use the same post-commit signal for view-state persistence; failed or rolled-back admission must not publish, and an observer failure must not roll committed membership back.
- Active-tab presentation may update before asynchronous hydration, but `TabManager` keeps the previous committed selection in its persistence projection until the switch commits. View-state persistence follows `onActiveTabCommitted`, so direct layout capture and callback-driven persistence cannot durably publish a rolled-back selection.
- Tab IDs are reserved before asynchronous assembly. Structural assembly and required activation are one transaction: failure must remove and destroy the assembled runtime, release its metadata, and restore the previous active owner before post-commit creation observers run.
- A close reservation synchronously pauses the tab session's intent admission, fences duplicate close requests, and remains reversible through fallible replacement admission and, for the active tab, successor activation and active-tab publication. Required runtime state callbacks and command-context invalidation remain accepted until those prerequisites succeed and lifecycle becomes terminal `closing`; failed preflight resumes intent admission, while failed successor switching restores and republishes the predecessor before resuming intent admission.
- Each queued tab-switch request owns its completion and failure. A switch requested by tab admission must await its real activation attempt so callback failure rolls that admission back instead of escaping through an unrelated earlier switch.
- `TabManager.destroy()` is terminal: new or in-flight tab assembly must not enter membership afterward, runtime-retained intents must revalidate their source tab before manager or view work, and overlapping close requests must not repeat persistence, callbacks, or teardown side effects.
- Fork operations capture the source tab and exact conversation binding before their first asynchronous source lookup or target prompt. Revalidate that lease after every await and copy accepted-input state by the captured conversation ID, never the coordinator's current binding.
- View shutdown closes intent admission, invalidates and joins conversation navigation and tab switching, then keeps terminal conversation-binding callbacks open while every admitted tab cancels and drains active/background work. Only that complete quiescence boundary may flush and seal the final tab identity. While restore is pending, its complete plan remains authoritative for layout capture and callback-driven persistence is fenced; shutdown flushes that plan instead of zero or partial inactive membership. A reopen overlapping shutdown reuses the same persistence coordinator, awaits the closing snapshot, and restores that finalized snapshot rather than legacy or older delivered state.
- `AssembledTabRuntime` keeps required structural references stable after publication, including while `closing` and after resource disposal. Operational availability is expressed by lifecycle state and read-only resource state; teardown authority remains internal and must not null required references.
- Construction builders under `tabs/runtime/` are internal to `TabRuntimeFactory` and return complete shell, service, UI, controller/renderer, and input-binding bundles. They may depend on focused tab-domain modules but never import the factory, manager, or view. Every acquired resource must register rollback immediately; rollback and teardown are idempotent, best-effort, and continue after individual cleanup failures.
- Cooling an idle tab must preserve its runtime tab, conversation binding, hydrated UI state, and resumable provider snapshot.
- Returning to single-panel mode must keep dual-pane controls in place until provisional-tab cleanup completes; compact controls must never target a tab already being closed.
- Switching the active tab must not cancel, dispose, or transfer another tab's active execution.
- Closing a tab disposes its runtime resources but never deletes its conversation; conversation deletion is a separate application operation.
- Layout and presentation changes must not alter conversation binding or execution lifecycle.
- Initial responsive layout must be established before constructing or attaching navigation UI, and restoration must publish the completed tab bar only after every selected shell is admitted.
- Linked content is immutable for a durable Conversation. The first canonical user turn freezes the draft path before Conversation creation and uses that same token for creation plus provider context; create failure restores the reconciled draft, while any post-create failure leaves a locked zero-message Conversation whose retry is still ordinal one. Later, queued, steered, hydrated, and `/compact` turns never resend the reference through a mutable sent flag.
- Linked content supplies scoped context, not a workspace transition: selecting a file or folder must not change the agent CWD, external workspace roots, permissions, current Obsidian file, or Collab Project selection. Providers receive only the canonical path and must not recursively ingest a directory without agent-initiated reads.
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
