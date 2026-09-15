# Application constraints

- Cached conversations are projections, not independent mutation authority. Route changes through the repository's application APIs; retain binding/generation fences across hydration, deletion, accepted-input staging, and snapshot writes.
- Historical model locators are recovery-only, never resumable bindings. Recovery is best-effort and must not overwrite a newer selection. Persist availability reconciliation before exposing recovered or fallback models; safe model-less shells may remain readable during deferred adoption.
- Linked content is creation-only conversation identity. Ordinary patches, saves, forks after creation, and deletion cannot replace or clear it. Only explicit Vault-rename reconciliation rewrites it, including folder descendants; deletion preserves identity for Missing content.
- Archive clears pin state and is independent of closing a tab.
- Settings mutations are serialized. Persistence failure restores memory; failure publishing an already committed change must not roll persistence back.
- Explicit model-picker intent orders future-tab seed commits across the plugin. Revalidate runtime/conversation ownership at the serialized commit, not before an asynchronous provider switch. Automatic fallback/recovery must not seed future tabs.

## Legacy tab migration

- The plugin-global snapshot is a one-time source, never a second live authority. Only the migration coordinator may claim or retire it.
- Decisions use view state actually delivered by Obsidian, including deferred leaves. A synthesized `getState()` is not proof of restoration. Any delivered view-scoped snapshot permanently disqualifies legacy fallback, even if that leaf later disappears.
- Adopt metadata for all shells selected by the restore policy before restoring them; deferred history scanning owns other sessions. Migration writes preserve unrelated plugin data.

## Collab enablement

- Disabled startup/live-disable must not construct Collab, start Agent Runtime, probe Git/SQL/network, restore Host, or write Collab state. Disable closes admission, hides presentation, and drains admitted work before tearing down dependencies; durable Project/credential/auto-start state survives.
- Plugin load never waits for Collab foundations. Layout-ready recovery is background, failure-isolated by Project and stage, and retries incomplete durable work with bounded backoff. With no recovery or Host auto-start work, ordinary startup performs no Collab foundation I/O.
- Start Agent Runtime asynchronously; close/abort its listener before Collab teardown, but retain mutation dependencies until admitted writes settle. Partial Collab capability bags are not an enabled product mode.
