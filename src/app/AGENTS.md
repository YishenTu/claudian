# Application constraints

- Cached conversations are projections, not independent mutation authority. Route user-facing changes through `ConversationService` and provider snapshot writes through the repository's execution-persistence API; retain binding/generation fences across hydration, deletion, provider handoff, session invalidation, and snapshot writes.
- Historical model locators are recovery-only, never resumable bindings. Recovery is best-effort and must not overwrite a newer selection. Persist availability reconciliation before exposing recovered or fallback models; safe model-less shells may remain readable during deferred adoption.
- Linked content is creation-only conversation identity. Ordinary patches, saves, forks after creation, and deletion cannot replace or clear it. Only explicit Vault-rename reconciliation rewrites it, including folder descendants; deletion preserves identity for Missing content.
- Never await feature callbacks inside a conversation's persistence queue: sessions save and release history through that queue. Deletion cleanup runs after durable removal leaves it, and retries join the cleanup in flight.
- Unscoped metadata remains writable until explicit assignment. Never auto-assign or copy between live authorities.
- Do not add input copies or permanent assignment/deletion sidecars; rare stale sync conflicts are an accepted tradeoff of native-history ownership.
- Settings mutations are serialized. Persistence failure restores memory; failure publishing an already committed change must not roll persistence back.
- Explicit model-picker intent orders future-tab seed commits across the plugin. Revalidate runtime/conversation ownership at the serialized commit, not before an asynchronous provider switch. Automatic fallback/recovery must not seed future tabs.
