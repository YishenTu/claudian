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
| `ConversationRepository` | The canonical in-memory Claudian conversation collection, hydration status, deletion transactions, per-conversation persistence queues, input-ledger coordination, and execution-snapshot binding |
| `SharedStorageService` | Plugin-data and vault persistence I/O plus construction of shared persistence adapters |
| `SettingsCoordinator` | Serialization of settings mutations, rollback before failed persistence, and post-commit publication ordering |
| `ClaudianProviderHost` | Typed delegation to application capabilities; it owns no duplicate settings, storage, view, or execution state |

Storage adapters own I/O mechanics, not domain decisions. Callers decide what state is valid; adapters merge and persist it without inventing conversation, tab, provider, or settings semantics.

## State and Persistence Boundaries

- `ConversationRepository` is the source of truth for Claudian's current in-memory conversation projection. Feature code must request conversation mutations through `FeatureHost` instead of mutating cached conversations independently.
- Claudian metadata and accepted-input ledgers are durable Claudian state. Provider-native transcripts and history databases are provider-owned, read-only replay sources.
- Provider session IDs, resume checkpoints, and opaque `providerState` may be interpreted only by provider snapshots or typed provider history/state helpers. Generic app code may store those opaque values but must not infer or rewrite their fields.
- `AppTabManagerState` is a separate tab-layout snapshot. It may reference conversation IDs but must not duplicate conversation messages, provider state, or runtime objects.
- `SharedStorageService.setTabManagerState()` must preserve unrelated plugin data when updating the tab-layout snapshot.
- Settings changes must go through `SettingsCoordinator` or the application mutation APIs so persistence, rollback, provider reconciliation, and publication remain ordered.

## Invariants

- Closing or removing a tab never deletes a conversation.
- Deleting a Claudian conversation never mutates or deletes provider-native session data.
- Failed settings persistence restores the pre-mutation in-memory settings snapshot.
- A post-commit publication failure is reported as committed state; it must not roll back data that was already persisted.
- Conversation persistence for one conversation remains ordered, and stale execution snapshots must not overwrite newer provider state.
- Deletion, hydration, and execution-snapshot writes must preserve their existing generation and binding fences.
