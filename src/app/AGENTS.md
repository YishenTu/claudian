# Application Services

`src/app/` owns application-scoped state services and adapters used by the composition root. Features and providers access these capabilities through stable host and core contracts rather than importing the concrete plugin class.

## Dependency Direction

- `src/main.ts` is the concrete composition root. It constructs app services and wires core registries, providers, and features.
- App repositories, storage, and settings services depend on core contracts. They must not import chat views, feature controllers, renderers, or provider-native protocol implementations.
- `FeatureHost` is the feature-facing application boundary; user-facing features must not import `ClaudianPlugin` from `src/main.ts`.
- `ProviderHost` is the provider-facing application boundary; provider runtime code must not reach through it to chat views or feature controllers.
- Concrete provider imports are allowed only in composition and provider-default assembly. Do not introduce them into conversation, storage, or settings transaction logic.
- Existing Claude compatibility imports of app settings or storage are migration seams. Do not use them as precedent; move a shared contract into `core/` before creating another provider-to-app dependency.

## Ownership

| Component | Authority |
| --- | --- |
| `ConversationRepository` | The canonical in-memory Claudian conversation collection, hydration status, pin/archive and note-link metadata, deletion transactions, per-conversation persistence queues, input-ledger coordination, historical model recovery, and execution-snapshot binding |
| `SharedStorageService` | Plugin-data and vault persistence I/O plus construction of shared persistence adapters |
| `SettingsCoordinator` | Serialization of settings mutations, rollback before failed persistence, and post-commit publication ordering |
| `PinnedLinkedNotePathCoordinator` | Pinned linked-note path mutation, folder-descendant rewrite, deduplication, and deletion cleanup through ordered settings transactions |
| `ClaudianProviderHost` | Typed delegation to application capabilities; it owns no duplicate settings, storage, view, or execution state |

Storage adapters own I/O mechanics, not domain decisions. Callers decide what state is valid; adapters merge and persist it without inventing conversation, tab, provider, or settings semantics.

## State and Persistence Boundaries

- `ConversationRepository` is the source of truth for Claudian's current in-memory conversation projection. Feature code must request conversation mutations through `FeatureHost` instead of mutating cached conversations independently.
- Claudian metadata and accepted-input ledgers are durable Claudian state.
- Provider session IDs, resume checkpoints, and opaque `providerState` may be interpreted only by provider snapshots or typed provider history/state helpers. Generic app code may store those opaque values but must not infer or rewrite their fields.
- `AppTabManagerState` is a separate current-tab snapshot. New writes retain only the active tab identity and conversation binding; legacy multi-tab snapshots are restored as the active entry only. It must not duplicate conversation messages, provider state, draft content, or runtime objects.
- `Conversation.modelRecoverySource` is a read-only native locator used only to recover missing historical model metadata. It must never be treated as a resumable provider binding, and a successful recovery or fresh provider session retires it.
- `Conversation.currentNote` is a vault-relative full path. Vault rename events must rewrite matching note paths, including descendants for folder renames, through `ConversationRepository` rather than presentation code.
- `SharedStorageService.setTabManagerState()` must preserve unrelated plugin data when updating the tab-layout snapshot.
- Settings changes must go through `SettingsCoordinator` or the application mutation APIs so persistence, rollback, provider reconciliation, and publication remain ordered.

## Invariants

- Failed settings persistence restores the pre-mutation in-memory settings snapshot.
- A post-commit publication failure is reported as committed state; it must not roll back data that was already persisted.
- Conversation persistence for one conversation remains ordered, and stale execution snapshots must not overwrite newer provider state.
- Deletion, hydration, and execution-snapshot writes must preserve their existing generation and binding fences.
- Archiving clears pin state, cannot be inferred from tab closure, and never mutates provider-native history.
- Historical model recovery is best-effort, concurrency-bounded, provider-owned, and must not overwrite a model selected or recovered by a newer operation.
