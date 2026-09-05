# Authority persistence constraints

- A matching request-ensure replay rechecks membership but returns before Git validation. Reusing a key with different Project/head/expected-main facts must fail.
- Expired pending membership permits deleting its prepared personal ref only if it still equals canonical main; divergence or concurrent change must be retained.
- Mutation observers/resource revocation run only after the SQLite image is durably promoted. Events are redacted invalidations, never authority state.
- Member termination removes structured relations/mentions and credentials atomically without rewriting user Markdown. Keep at least one active Manager.
- Request comments remain immutable and Request-level, never line/diff/snapshot-anchored; terminal Requests are readable but cannot receive comments. Tickets have no assignment state.
- Structured mentions require exact unambiguous active-Member names. Code/escapes/ambiguous names remain plain text; mentions remain private authority state until an explicit query contract exists.
