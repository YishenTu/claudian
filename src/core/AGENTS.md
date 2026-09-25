# Core constraints

- Provider lifecycle leases fence provider-wide transitions; they must not acquire tab turn state or execution-capacity policy. Registries must not absorb registered-service lifecycle/storage.
- All providers receive the same default Main Agent prompt for the same settings/dynamic sections. Adapters may change transport/replacement mechanics, not omit sections or select provider-specific prompt profiles.
- Dynamic sections are ephemeral execution configuration and affect effective prompt identity; they never become user input.
- Inline Edit has a separate shared explicit prompt with host-provided date/Vault path. Do not append Main Chat dynamic sections or Custom Instructions; keep tool guidance capability-based.
- New Linked content references use normalized path-only shape, excluding the Vault root. Legacy Note forms are decode-only. A directory reference changes neither CWD nor recursive ingestion.

## Provider policy

- Explicit execution model/reasoning choices are authoritative: adapters may translate or validate them, but cannot silently substitute saved/default effort. Null reasoning means no explicit override; omitted reasoning permits auxiliary defaults. High is the default effort; preserve explicit supported choices and never silently choose another effort as a default.
- Do not assume provider parity. Check the owning capabilities, registration, and UI config before sharing behavior; use `ProviderRegistry` and `ProviderWorkspaceRegistry`.
- App/features may store opaque provider state but may not interpret native session/checkpoint fields. Providers normalize native payloads at the core boundary.
- Live output and history replay remain separate. Application metadata changes never edit or delete native history files; explicit native session operations belong to providers.
- Persisted provider settings require runtime decoding; invalid permission/tool/sandbox modes fail closed. Writers merge provider-owned configuration.
- Runtime-discovered commands are read-only. Auxiliary queries own processes/sessions independently from chat.
- The shared model catalog owns selection policy; providers retain discovery, native metadata, and persistence. Only selected models persist. Startup fills missing selected-model reasoning metadata through provider-native discovery; no hardcoded model effort migrations. Unavailable selections stay visible as unavailable rather than silently defaulting.
- Explicit selected-model order is durable user preference, including a full-list order; do not collapse it to legacy null/native-default ordering. Every provider's chat options reverse that order only to compensate for the upward-opening toolbar; settings and default resolution must not reverse it.

## Persistence and model resolution

- Device metadata and host-scoped provider settings use one durable filesystem-safe installation key. Do not derive another identity or initialize the namespace before the seed is durable.
- Unscoped metadata remains writable until explicit assignment. Never auto-assign or copy between live authorities. Very old Claude metadata migrates into unscoped state.
- Do not add input copies or permanent assignment/deletion sidecars; rare stale sync conflicts are an accepted tradeoff of native-history ownership.
- Historical provider ownership does not imply enabled-model availability. Readers expose the stored model until the repository durably adopts `modelToPersist`.
- Alias canonicalization cannot choose a fallback. Fallback uses explicit registry blank-tab display order, not registration order, alphabetic order, or current settings projection.
- Title generation uses the global title-model selection independently from chat. Auxiliary continuation remains provider-owned even when core owns orchestration/parsing.
