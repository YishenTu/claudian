# Collab constraints

## Installation and trust

- Host Member identity is not local Host authority. A synchronized installation with a foreign marker remains a client. Local authority access, TLS, locks, recovery, and deletion require installation admission; marker inspection itself is read-only.
- Legacy global CA files are claim-time migration input, never runtime ownership evidence. Marker failures block Host control but must not break unrelated Projects or ordinary client routing.
- Installation ownership applies to physical effects, not ordinary synchronized client state. The different-device Cloud-to-LAN Manager and its exact claimant successor are the nonphysical exception; synchronization must not transfer that cleanup authority.
- Persist owner-bound target intent before TLS/listener/staging effects. Cloud-to-LAN canonical authority stays markerless until relinquishment proof; never bind an incomplete import.
- Published/removed/rebound Host routes invalidate retained local clients after visibility changes. All origin/membership writers share one per-Project transition lane and revalidate membership inside it; parallel LAN/Cloud queues would permit conflicting writes.
- Reconnect proves one uniquely trusted same-Project endpoint before credentials. Discovery is not trust; ambiguous candidates, proof forks, or mixed success/authority rejection block. Persist endpoint/origin rotation before resetting clients, then retry only the same idempotent operation.
- Invitation/Member secrets never enter URLs, process arguments, logs, events, or diagnostics.

## Durable operations

- Cloud has no supported legacy binding population. Do not add speculative Cloud migrations or persist development actor assertions. Real LAN migrations remain supported.
- Setup/recovery documents are independently discoverable before the Project index. Missing/corrupt indexes never authorize overwriting unrecoverable retirement identity or abandoning pending work.
- Capture the Projects root before possible Create/Join effects; settings changes cannot redirect pending/completed Projects. A generated-looking directory name never proves ownership for deletion. Preserve unmarked collisions and require both root and operation ownership.
- Before authority commit, setup rollback removes provisional authority before staging/discovery records so failed cleanup stays recoverable. After commit, preserve authority and recover forward.
- Validate repository identity, branch, checkout, portable tree, and integrity before atomic placement under the captured root. Cancellation or later remote failure never deletes an already placed working copy. Preserve validated legacy Join staging provenance without weakening current ownership checks.
- LAN Join and Cloud entry reuse working-copy mechanics without sharing admission/credentials. Membership, publication state, and index must agree before ordinary sessions; entry recovery cannot reset surviving publication work.
- Completed rejection is not proof that a mutation did not commit. Owners freeze ambiguous requests and use operation-specific authenticated evidence before allowing replacement intent.
- Relocation must not carry endpoint-bound Cloud management intent across bindings. Drain the selected Project, then check for that intent before journaling movement; recovery replays the exact captured bindings.

## Session and lifecycle interaction

- Keep ordinary-operation admission separate from irreversible lifecycle arbitration. Every public operation declares admission explicitly; operation-ID-only conflict reads are global, while Project-ID operations require active admission except explicit local Retired actions.
- A session-owned snapshot/event/inspection must never await lifecycle work that closes or drains that same session. Schedule it outside the read and revalidate generation. Shutdown still owns both admitted operations and scheduled transitions.
- Projection reset detaches stale results but does not abandon their settlement. Leave drains before cleanup; terminal Retirement must separate close from drain to avoid reentrant deadlock.
- Persist membership changes before invalidating its authority session. Cache, Member role/cursor, and responsibility receipt publish in that order; reject lower-sequence or wrong-Member snapshots before any of those writes.
- Queries must not publish feature state: subscribers can issue queries and create refresh loops. Register accepted-state maintenance before announcing selection/readiness, without making the ready shell await maintenance.
- Inspection and accepted-state synchronization share a per-Project read/write fence. Aborting work cannot release the fence before underlying settlement; never combine Git and publication snapshots from opposite sides of synchronization.
- Offline cache is a stale read projection only. Authorization/integrity failures cannot fall back to it. Cache complete finite details, never partial pages or mutation intent; Runtime paging remains online-only.

## Membership and publication policy

- Manager and Host responsibilities are independent. There is no primary Manager; demotion/removal preserves at least one. Manager succession acknowledgement is protocol synchronization, not another user confirmation. Physical Host handoff still requires explicit target consent.
- Project lifecycle, membership, and authority-transfer journals have distinct owners. Changes crossing these boundaries must consult their scoped guides; do not infer cancellation or completion from another owner's files.
- Publish confirmation is durable and bound to exact candidate/current-main OIDs. Never infer consent from a UI flag, force-push, silently reset a personal ref, or ensure a request before its confirmed head reaches the authority.
- Description drafts survive offline/recovery failures until exact head/description acknowledgement. Ticket relations derive from description text, never a parallel selection store.
- My changes reviews unpublished working results against the authoritatively published request head, falling back to the personal remote-tracking head and then HEAD. It must not become candidate-confirmation review or mutate refs/index.
- Background synchronization may fetch with a contribution present, but visible writes require proven contribution-free fast-forward. Never silently merge an open request's clean divergence; Manager Accept owns that case. Conflict analysis may persist private recovery but cannot alter visible files, personal remote refs, or requests.
- Git writes and credential exposure revalidate identity, trust/origin, control reachability, worktree/index/refs, publication state, and locks at their boundary. Detecting an editor or agent process is not a substitute.
- Suppress hooks only on the specific Claudian-owned local integration/conflict commands; Host receive-pack depends on its protected hook.
- Conflicts are immutable evidence. Users/agents edit real files and Publish prepares the exact candidate; private scratch stages and markers never become visible work or a second UI resolution state machine.
- Review reads use captured identities/OIDs and selected paths; working-file rereads verify captured content hashes, not just size/timestamps. Raster previews require matching signatures as well as extensions.
