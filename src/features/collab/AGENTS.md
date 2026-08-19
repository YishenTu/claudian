# Collab Feature

`src/features/collab/` owns Collab presentation state and user intent over provider-neutral contracts. It must not import application repositories, Native Git adapters, authority storage, LAN implementations, or provider implementations.

## Architecture

- Panels, detail sessions, and modals emit operations through `CollabFeaturePort` or narrower injected contracts. They never run Git commands or mutate Project records directly.
- Feature-local dependencies flow in this direction:

  ```text
  composition -> sidebar + detail + modals + handoff + navigation
  sidebar -> sidebar children + modals + shared + handoff + core
  detail -> detail children + shared + handoff + core
  modals -> modal children + shared + core
  navigation -> injected feature/workspace contracts
  shared -> Obsidian + core + shared UI/i18n
  handoff -> core
  ```

  `shared` and `handoff` must not import a presentation surface; `modals` must not import `sidebar` or `detail`.
- Disposable presentation reads use one latest-task scope per logical lane. A replacement invalidates only the older read in that lane. Publish, Accept, Ticket/comment mutation, conflict resolution, and other durable operations retain their application-owned admission and idempotency intent; never place them behind a presentation latest-task scope.
- `handoff/CollabPreparedReviewCache.ts` is the bounded, plugin-lifetime, metadata-only bridge from sidebar review preparation to detail presentation. It is keyed by persisted identities and exact review OIDs and may retain coordination metadata, but never file blobs or credentials. Missing or non-matching entries must be re-derived through the injected port.

## Cross-Surface Invariants

- Before the current Member has an open request, a durable personal conflict is opened from My changes. Once an open request exists, that request is the only conflict entry point, including a conflict detected after its base advances; the detail surface identifies which location owns the conflict. Conflict presentation is read-only. The Member or Agent resolves it by editing the real Project files and publishing again; that Publish prepares a normal publication review and updates the same request. A resolved publication review remains attached to the same request and must not reappear as a My changes publication action.
- Stale-base and conflict-resolved candidates transition to a separate exact publication review before confirmation; publication-review files never enter the My changes projection.
- Opening the editable Project file belongs only to a My changes working-tree review. Request, publication, and conflict reviews display exact reviewed content and must not expose that action. Publishing from a working-tree review retains any exact prepared publication review for the sidebar and closes the working-tree leaf; navigation to the retained review is explicit.
- The Ticket surface is split by lifetime: the sidebar owns filtering, pagination, and navigation; detail owns create/read/edit, comments, accepted relations, and close/reopen. Authority-backed mutations remain online-only.
- Project management is opened only from the sidebar Project-header action. Membership, invitation, Leave, Retire, and LAN Host controls remain in the Project-management modal and must not be duplicated in the sidebar.
- `navigation/ResponsiveCollabRouter.ts` selects and reveals a compatible Claudian surface, falling back to a prepared main-tab view. It must not mutate chat or Collab application state.
- User-facing copy describes Projects, changes, Publish, review, and recovery. Git refs, staging, branches, receive-pack, and database phases are advanced diagnostics only.
- A missing working copy or interrupted setup keeps the Project visible and repairable. Presentation code never treats absence as permission to delete local records or Host authority.

## Verification

- Cross-surface tests must cover exact prepared-review transfer, personal-to- request conflict ownership, publication-review retention, and Ticket navigation without moving durable operation intent into presentation state.
- Composition tests must prove plugin `onload` does not await Collab work and that layout-ready Host restoration remains background-only. Projects without saved auto-start intent must leave Git, SQL, and network foundations untouched.
