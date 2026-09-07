# Collab Sidebar

## Ownership and Lifetime

- `CollabPanel` is the selected-Project shell. It owns Project selection and propagates active/inactive state to the Personal, Team, and Ticket panels; it does not own their data projections or durable operations.
- A sidebar controller owns only its DOM, subscription, and asynchronous presentation lifecycle. Hiding it preserves the rendered tree and subscriptions while aborting presentation reads. Unchanged reactivation performs no Collab read; hidden invalidations coalesce into one resume refresh. Destroy suppresses stale completions and releases subscriptions.
- Lazy preload and foundation initialization are not presentation reads. Once admitted they continue across visibility changes, remain non-active until selection commits, and are retained unless the controller is destroyed.
- Personal, Team, and Ticket controllers keep independent read/cancellation lanes. Do not combine them into a shared refresh task or use their task scopes for mutations.

## Project Shell

- With no Project, onboarding presents Create and Join side by side and has no duplicate Add action. With a selected Project, the header order is Project selector, Add menu, then Project management; the Add menu owns Create and Join. Creating a Project must not change selection before success.
- A Retired Project remains visible in the sidebar without opening a modal. Its summary, retry, Keep, and Delete actions use only the local lifecycle projection; Native Git availability and network inspection must not replace it. Cleanup failure remains Retired with retry. Keep/Delete never waits for automatic acknowledgement or claims Git-only history is recoverable.

## My Changes

- `changes/PersonalChangesPanel.ts` is the role-neutral personal-change projection. It shows only unpublished or recovery-required personal work; its title and files navigate to the exact working-tree review, while retained recovery states navigate to their exact detail.
- My changes never invokes Publish, exposes Get latest, reconstructs contribution safety from raw Git divergence, or stages, commits, fetches, reconciles, or opens a credential boundary. Durable Git, publication, and request state come only from the injected port.
- The personal file list is the injected virtual-squash working result and may include later local commits without rewriting them. Final-state review is based on accepted-base advancement, not same-file overlap. Do not replace the personal list with request or publication files.

## Team Changes

- `changes/TeamChangesPanel.ts` is the single open-request list for every role, including the current Member's request. Each row expands in place and owns exact review preparation plus changed-file selection. Request inspection is role-neutral; only the detail review decides whether Accept is available.
- The sidebar-selected request file is the detail view's current-file target or continuous-review scroll target. Do not add another changed-file navigator in detail.
- `changes/TeamReviewLoader.ts` serializes native review preparation. Its cache identity includes Project/request OIDs, request metadata, and current Member identity and role; comments and Manager transfer can invalidate a review without advancing a ref.

## Tickets

- `tickets/TicketListPanel.ts` contains only the Open/Closed filter, Add action, paginated rows, and detail navigation. It must not host Ticket forms, bodies, comments, relations, or status mutations.
- Cached or stale Ticket rows are labeled read-only and disable Add. A failed online read may use a fresh coordination snapshot to distinguish a known empty open list from a load failure.

## Verification

- Cover lazy construction, non-activating preload, hidden invalidation coalescing, unchanged reactivation, Project switching, stale-completion suppression, per-panel cancellation, subscription disposal, Team review serialization, and Ticket pagination/read-only behavior through fake ports.
