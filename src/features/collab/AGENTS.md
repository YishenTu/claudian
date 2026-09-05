# Collab presentation constraints

- Shared/handoff modules must not depend on presentation surfaces; modals must not import sidebar/detail. Cross-surface navigation may reveal UI but cannot mutate chat or Collab application state.
- Latest-task cancellation is for reads only. Application owners retain mutation admission/durable recovery; detail-session Ticket/comment retry identities are transient UI state, not lifecycle journals.
- Prepared-review handoff caches metadata bound to exact identity/OIDs, never blobs or credentials. A missing/stale handoff must re-derive review through the application port.
- An open request becomes the sole entry point for its personal conflict/recovered publication review. Do not duplicate that action under My changes or replace My changes files with candidate-review files.
- Only working-tree review may open editable Project files. Request/publication/conflict views show exact reviewed evidence; publishing closes the working review and retains any candidate for explicit navigation.
- Project management actions belong only in its modal. Commit selection changes by closing the previous management surface before notifying later subscribers; late completions stay bound to the old identity.
- Missing working copies and interrupted setup remain repairable projections, never permission for presentation to delete records or authority.
- Keep routine copy about Projects/changes/Publish/recovery; internal Git/database phases are diagnostics only.
