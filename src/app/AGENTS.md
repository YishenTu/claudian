# Application constraints

- Cached conversations are projections, not independent mutation authority. Route changes through the repository's application APIs; retain binding/generation fences across hydration, deletion, provider handoff, and snapshot writes.
- Historical model locators are recovery-only, never resumable bindings. Recovery is best-effort and must not overwrite a newer selection. Persist availability reconciliation before exposing recovered or fallback models; safe model-less shells may remain readable during deferred adoption.
- Linked content is creation-only conversation identity. Ordinary patches, saves, forks after creation, and deletion cannot replace or clear it. Only explicit Vault-rename reconciliation rewrites it, including folder descendants; deletion preserves identity for Missing content.
- Settings mutations are serialized. Persistence failure restores memory; failure publishing an already committed change must not roll persistence back.
- Explicit model-picker intent orders future-tab seed commits across the plugin. Revalidate runtime/conversation ownership at the serialized commit, not before an asynchronous provider switch. Automatic fallback/recovery must not seed future tabs.

## Legacy tab migration

- The plugin-global snapshot is a one-time source, never a second live authority. Only the migration coordinator may claim or retire it.
- Decisions use view state actually delivered by Obsidian, including deferred leaves. A synthesized `getState()` is not proof of restoration. Any delivered view-scoped snapshot permanently disqualifies legacy fallback, even if that leaf later disappears.
- Adopt metadata for all shells selected by the restore policy before restoring them; deferred history scanning owns other sessions. Migration writes preserve unrelated plugin data.
