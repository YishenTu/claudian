# Agent Runtime constraints

- Discovery/health and listener startup must stay independent from lazy Collab initialization. Only an actual Collab operation may resolve its application port; the advertised endpoint is the actual binding, not persisted configuration.
- Operation names, parameter/result meaning, and retry semantics are a versioned compatibility surface. Package/registry additions do not implicitly authorize new Agent operations.
- Lifecycle is projection-only at this boundary. Do not expose lifecycle mutations, caller-supplied identities, internal operation IDs, private hashes/snapshots, credentials, binary previews, or generic filesystem/Git/database calls.
- Agent file reads must select an exact path from a freshly derived application manifest. Raw ref differences or a caller's retained internal file object are not a manifest.
- Keep bounded online paging separate from complete presentation reads/offline cache. Do not assemble unbounded collections for convenience.
- Deadline/disconnect may end the response before an admitted write settles. Fence late output while retaining application dependencies until that write settles; bounded listener shutdown must not dispose live mutation owners.
