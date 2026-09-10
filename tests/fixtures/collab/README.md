# Authority V12 handoff fixture

`authority-v12-inert.sqlite.gz` is a captured SQLite image produced by the V12 implementation before the V13 migration was introduced. It contains synthetic source/target Members, a staged physical Host handoff, and 1,001 redacted invalidation events. All credentials, fingerprints, signatures, and content are test values.

The fixture verifies physical-image admission, migration, activation/replay, sequence preservation, and compaction without constructing the legacy schema from the current implementation. The fixture uses the fixed identities and timestamps in `HostTransferAuthoritySnapshot.test.ts`.
