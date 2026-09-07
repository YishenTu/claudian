# Detail constraints

- Sessions must not import the Obsidian view router. Preserve a plugin-lifetime coordinator for serialized leaf transitions; per-click coordinators allow overlapping view-state writes.
- Review leaves are session-only: remove restored reviews at startup and detach before unload layout persistence. Persist identifiers/selection only, never credentials or content.
- Exact review handoff does not authorize later Accept. Revalidate fresh coordination/role and the reviewed OIDs/revisions; same-OID comment refresh must preserve the active diff and drafts.
- Comments are immutable Request-level Markdown in Overview, not line/diff threads. Publication review has no comments/Accept; request review has no Confirm and Publish.
- Session replacement ends transient retry intent, but rerender/refresh must not rotate lost-response identity or discard edits. Payload changes rotate the intent; only a result consumed by the current session clears it.
- Each diff renderer retains only the active file. Preserve the editor and selection when identical reviewed evidence moves between wrappers; close/conflict/error releases stale content/theme resources.
- Bound continuous rendering and file reads to the active exact review; do not hydrate every file merely because the user can scroll to it.
- Read-only diffs reuse Obsidian’s external CodeMirror runtime through the merge extension. Keep plain-text rendering and all merge/revert controls disabled; review never edits the evidence. Dependency changes require the bundle envelope, real-DOM review tests, and a real plugin-context check against the host runtime.
- Ticket refresh preserves editor mode/focus, unsaved values, original edit revision, and retry intent while permission state converges. Cached views are visibly read-only.
- Relations derive solely from description text via the shared parser. Autocomplete inserts canonical visible text; no independent selection state. Restore private drafts and expose divergence rather than replacing them.
- Conflict views show immutable full-file personal/accepted evidence. No side-picking, resolution editor, finalization, Git-stage UI, or agent invocation; resolution happens in real Project files followed by Publish.
