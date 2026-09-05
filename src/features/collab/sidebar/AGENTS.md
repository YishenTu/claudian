# Sidebar constraints

- Hiding preserves the controller/tree/subscriptions while cancelling presentation reads. Unchanged reactivation performs no read; hidden invalidations coalesce. Preload/foundation work survives visibility changes without becoming active.
- Personal, Team, and Ticket reads have independent cancellation lanes. Never share their scopes with mutations.
- Creation changes selection only after success. Retired Projects remain directly inspectable/retryable without Git/network, and local cleanup cannot wait for acknowledgement.
- My changes is read-only unpublished work, including local commits. Do not add Publish/Get latest or infer mutation safety from raw divergence; candidate/request files cannot replace its working-result projection.
- The sidebar owns changed-file navigation for request review; detail must not add a competing navigator. Review cache identity includes metadata and Member role, not just OIDs.
- Ticket sidebar remains navigation/filtering/paging only. Stale rows disable creation; forms/comments/status mutations belong in detail.
