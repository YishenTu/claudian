# Detail constraints

- Sessions must not import the Obsidian view router. Preserve a plugin-lifetime coordinator for serialized leaf transitions; per-click coordinators allow overlapping view-state writes.
- Review leaves are session-only: remove restored reviews at startup and detach before unload layout persistence. Persist identifiers/selection only, never credentials or content.
- Exact review handoff does not authorize later Accept. Revalidate fresh coordination/role and the reviewed OIDs/revisions; same-OID comment refresh must preserve the active diff and drafts.
- Comments render as Request-level Markdown in Overview under the rule in `src/app/collab/authority/AGENTS.md`. Publication review has no comments/Accept; request review has no Confirm and Publish.
- Session replacement ends transient retry intent, but rerender/refresh must not rotate lost-response identity or discard edits. Payload changes rotate the intent; only a result consumed by the current session clears it.
- Diff rendering and file reads retain only the active file. Preserve the editor and selection when identical evidence moves between wrappers; release stale content/theme resources on close, conflict, or error.
- Read-only diffs reuse Obsidian's external CodeMirror runtime through the merge extension. Render plain text and disable merge/revert controls; review never edits the evidence. Dependency changes require the bundle envelope, real-DOM review tests, and a real plugin-context check against the host runtime.
- Ticket refresh preserves editor mode/focus, unsaved values, the original content baseline, and unresolved retry identity while permission state converges. Advance an edit revision only with proof that its baseline content is unchanged or explicit user reconciliation; an unresolved write keeps its exact request revision. Cached views are visibly read-only.
- Relations follow the description-text rule in `src/app/collab/AGENTS.md` through the shared parser. Autocomplete inserts canonical visible text. Restore private drafts and expose divergence rather than replacing them.
- Conflict views show full-file personal/accepted evidence under the rule in `src/core/collab/AGENTS.md`: no side-picking, resolution editor, finalization, Git-stage UI, or agent invocation.
