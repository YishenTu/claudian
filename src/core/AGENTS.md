# Core constraints

- Provider lifecycle leases fence provider-wide transitions; they must not acquire tab turn state or execution-capacity policy. Registries must not absorb registered-service lifecycle/storage.
- All providers receive the same default Main Agent prompt for the same settings/dynamic sections. Adapters may change transport/replacement mechanics, not omit sections or select provider-specific prompt profiles.
- Dynamic sections are ephemeral execution configuration and affect effective prompt identity; they never become user input or accepted-input ledger data.
- Inline Edit has a separate shared explicit prompt with host-provided date/Vault path. Do not append Main Chat dynamic sections or Custom Instructions; keep tool guidance capability-based.
- New Linked content references use normalized path-only shape, excluding the Vault root. Legacy Note forms are decode-only. A directory reference changes neither CWD nor recursive ingestion.

## Persistence and model resolution

- Device metadata and host-scoped provider settings use one durable filesystem-safe installation key. Do not derive another identity or initialize the namespace before the seed is durable.
- Unscoped metadata remains writable until explicit assignment. The durable shared ownership fence is authoritative even if stale source files survive; never auto-assign or copy between live authorities. Deletion markers affect only their own authority. Very old Claude metadata migrates into unscoped state.
- Historical provider ownership does not imply enabled-model availability. Readers expose the stored model until the repository durably adopts `modelToPersist`.
- Alias canonicalization cannot choose a fallback. Fallback uses explicit registry blank-tab display order, not registration order, alphabetic order, or current settings projection.
- Title generation uses the global title-model selection independently from chat. Auxiliary continuation remains provider-owned even when core owns orchestration/parsing.
- Discovery caches contain non-secret fingerprints and generations; stale resource generations must not publish cached commands or metadata.
