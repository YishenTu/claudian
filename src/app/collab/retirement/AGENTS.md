# Retirement constraints

- The tombstone is irreversible. Later failures activate terminal recovery; client delivery and local cleanup cannot delay authority teardown or reopen active admission.
- All terminal observations converge through one durable Retired handler. An Active index entry beside a retirement record means interrupted convergence, not permission to restart.
- Retired display/retry/Keep/Delete must work without Native Git or successful network acknowledgement. Verify local Git identity with bounded non-symlink config reads instead of launching Git.
- Retain the terminal responder for its entire recovery window, including after final acknowledgement, because responses can be lost. Expiry never removes local visible files or Retired projection.
- Hand pending acknowledgement to the independently discoverable queue before deleting Project-private state. Its fallback payload must not recreate an active local projection.
- Cloud Retire owns its frozen intent until durable terminal handoff; it never borrows LAN intent. Submitted replay precedes active-snapshot lookup.
- Exact terminal Retirement may absorb pending Leave or responsibility ownership. Once Retired is durable, obsolete receipts cannot remain competing nonterminal owners; recovery removes them without reacquiring/draining itself.
