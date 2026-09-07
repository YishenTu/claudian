# Collab Detail Surface

## State and Session Ownership

- `CollabDetailContracts.ts` is the session-facing state, port, and factory authority. Sessions import it directly and must not import `CollabDetailView.ts`.
- `CollabDetailView.ts` is the sole Obsidian leaf/state router. It persists only validated Project/request, publication-operation, personal-review, Ticket, or conflict identifiers plus selected path and exact OIDs where applicable; credentials and blob contents never enter view state.
- Exactly one independently destroyed detail session owns the active request, publication, personal, Ticket, or conflict presentation. Replacing view state destroys the previous session without transferring mutation intent between sessions. Sessions refresh from feature invalidations and release their subscriptions on destroy.
- `CollabDetailViewCoordinator` is shared for the plugin lifetime and serializes workspace-leaf transitions with latest-intent coalescing. Do not construct it per click or overlap `setViewState` calls.
- Review leaves are session-only: startup removes restored review leaves, unload detaches them before layout persistence, and successful Accept, Publish, or Confirm and Publish closes the active review leaf.

## Review Presentation

- Request review opens on an Overview tab with the complete description, immutable Request-level Markdown comments in chronological order, and one composer. Changes lazily owns file reads and diffs; it has no comment gutter, annotations, anchors, ranges, threads, resolved/read state, notification dismissal, ordinary Close, or Reject. Failed comment retry preserves the draft and its idempotent intent.
- Publication reviews never expose comments or Accept. Request reviews never expose Confirm and Publish.
- An open request refreshes coordination after every feature invalidation and never trusts a retained handoff snapshot for Accept. Re-prepare when the request projection or accepted main OID changes; merge monotonic comments and newer metadata while retaining in-progress drafts and retry intents. Same-OID comment refreshes update Overview without rebuilding the active diff. Invalidations during Accept coalesce into one post-Accept refresh if the request remains open.
- Accept is visible only when the displayed snapshot names the current Member as Manager and the Project pointer agrees. It is enabled only for online, non-stale, synchronized state, then performs a fresh authority preflight and submits the exact reviewed main/head, request revision, and resolving-Ticket revisions. UI state and WebSocket events are not the correctness boundary.

## Diff and Renderer Lifetime

- The detail view owns one reusable `review/ReviewDiffSession.ts`. Only the active request/publication/personal review session may borrow it for Pierre lifetime, selected-file reads, progressive rendering, and binary URLs.
- Review-to-review changes within one exact review retain the prepared review and replace only selected-file presentation. Across identities, reuse one Pierre Diffs instance while replacing per-state requests and object URLs. If the wrapper changes, render through Pierre's public API so cached identical files reattach. Clear the instance on conflict, opaque, empty, error, or closed presentation, and release its theme observer on leaf close.
- Review scope and layout are independent in-memory options; `All files` plus `Unified` is the default. Continuous mode renders the sidebar-selected file immediately, admits at most one background file read/render, bounds completed file content to the active exact review, and creates per-file renderers only near the viewport. Both layouts wrap long lines.
- Personal-change reads revalidate published base, personal `HEAD`, local snapshot identity, and captured content hash before returning base/working content.
- Collab diffs are intentionally text-only. `review/CollabDiffRenderer.ts` must pass `lang: text`; `review/CollabShikiAdapter.ts` implements only Pierre's verified plain-text Shiki surface and must not retain a syntax-highlighting runtime, while `review/CollabPierreThemes.ts` registers only `pierre-dark` and `pierre-light`. The guarded build replacement owns Pierre's exact Shiki, transformer, theme-catalog, optional Wasm, filename-language, CSS, and SVG imports. Keep `@pierre/diffs` pinned to the verified dependency contract. A Pierre upgrade must first update the contract, dependency-envelope, and real-DOM text-render tests.

## Tickets and Relations

- Ticket detail owns create, read, edit, comments, accepted relations, and close/reopen. Bodies and comments render through Obsidian Markdown, never raw HTML. Cached reads are visibly read-only and expose no mutation controls.
- Background feature invalidations refresh the same Project/Ticket identity in place. Preserve unsaved create, edit, and comment values, editor mode and focus, the original edit revision, and exact mutation intent while authority and permission state converge; only identity replacement or session destruction discards that transient state.
- Exact-payload Ticket/comment mutation intents belong to the active detail session. Panel replacement must not rotate a lost-response retry; editing the payload rotates the intent, and only a result consumed by the current UI clears it.
- The complete request description is the only editable relation source. A boundary-delimited bare `#N` means `references`; canonical same-line closing syntax such as `Resolves #N` means `resolves`. The shared Markdown syntax-tree scanner examines visible prose only, excluding code, HTML, entities, link destinations, definitions, and escapes. Adjacent hash tokens and newline- separated keywords are not closing relations. Autocomplete and Resolve insert canonical text only; relation previews derive from that text or the Host projection. No selector, cache, view state, or mutation payload owns an independent relation set. Working and publication reviews restore the private description draft; divergent owner drafts are labeled unsynchronized rather than silently replaced.

## Conflict Presentation

- `conflict/CollabConflictResolutionPanel.ts` presents provider-neutral conflict sessions as immutable evidence. It identifies My changes versus Request ownership and exposes no side choice, draft editor, finalization, Git index stage/ref/marker, or Agent invocation.
- Conflict UI is a continuous single-column review without a file navigator. Each text file owns one full personal-versus-accepted Pierre side-by-side renderer. Opaque and blocking conflicts expose metadata only. The guidance is always to edit real Project files and Publish again.
- Conflict reads remain bound to the original base, personal, and accepted OIDs while working files change. The next Publish captures the exact local result, uses private scratch staging to prepare a normal publication review, and keeps an existing Request identity. Presentation never owns resolution progress.

## Verification

- Cover validated state restoration, active-session replacement, leaf-close behavior, prepared-handoff revalidation, draft/idempotency retention, Accept preflight, Pierre reuse/cleanup, bounded continuous rendering, Ticket read-only state, and conflict stale-finalization through the public view or owning session.
