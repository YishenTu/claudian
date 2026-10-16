# Core constraints

- Provider lifecycle leases fence provider-wide transitions; they must not acquire tab turn state. Registries must not absorb registered-service lifecycle/storage.
- All providers receive the same default Main Agent prompt for the same settings. Adapters may change transport/replacement mechanics, not omit sections or select provider-specific prompt profiles.
- Inline Edit has a separate shared explicit prompt with host-provided date/Vault path. Do not append Custom Instructions; keep tool guidance capability-based.
- New Linked content references use normalized path-only shape, excluding the Vault root. Legacy Note forms are decode-only. A directory reference changes neither CWD nor recursive ingestion.

## Provider policy

- Explicit execution model/reasoning choices are authoritative: adapters may translate or validate them, but cannot silently substitute saved/default effort. Null reasoning means no explicit override; omitted reasoning permits auxiliary defaults. High is the default effort; preserve explicit supported choices and never silently choose another effort as a default.
- Do not assume provider parity. Check the owning capabilities, registration, and UI config before sharing behavior; use `ProviderRegistry` and `ProviderWorkspaceRegistry`.
- App/features may store opaque provider state but may not interpret native session/checkpoint fields. Providers normalize native payloads at the core boundary.
- Conversation metadata and opaque provider state never persist inline binary/base64 payloads (including `ToolResultDetails.resultImages` data); native transcripts keep the bytes.
- Live output and history replay remain separate. Application metadata changes never edit or delete native history files; explicit native session operations belong to providers.
- Persisted provider settings require runtime decoding; invalid permission/tool/sandbox modes fail closed. Writers merge provider-owned configuration.
- Session tools have one neutral contract: providers expose them only to sessions configured with a session-tool port and call them through `invokeSessionTool`, which denies every policy except `provider-default`/`unrestricted`. Claudian auto-approves them: any native approval request for them is allowed without prompting the user. The loopback endpoint binds 127.0.0.1, rejects browser `Origin`s and foreign `Host`s, and carries caller identity only in unguessable, revocable route ids.
- Runtime-discovered commands are read-only. Auxiliary queries own their sessions, cancellation, and interactions independently from chat; a provider may share its own process across consumers.
- The shared model catalog owns selection policy; providers retain discovery, native metadata, and persistence. Only selected models persist. Startup fills missing selected-model reasoning metadata through provider-native discovery; no hardcoded model effort migrations. Unavailable selections stay visible as unavailable rather than silently defaulting.
- Explicit selected-model order is durable user preference, including a full-list order; do not collapse it to legacy null/native-default ordering. Chat options, the toolbar, settings, and default resolution preserve that order; the first saved model appears at the top of the dropdown.

## Persistence and model resolution

- Device metadata and host-scoped provider settings use one durable filesystem-safe installation key. Do not derive another identity or initialize the namespace before the seed is durable.
- Runtime-input invalidation clears resumable native bindings only; history locators survive as recovery-only state. Reads still trust only the current store roots, so a locator in a moved store stays unreadable (accepted limit). Changes that leave the native session store, endpoint, and account unchanged report `reload` and keep bindings. Retired bindings stay history-only. The only exception is a temporary migration (Claude/Pi, remove after 2027-01-16): an unmarked retirement left by an earlier version is restored once when its latest session provably belongs to the conversation in the current store.
- Historical provider ownership does not imply enabled-model availability. Readers expose the stored model until the repository durably adopts `modelToPersist`.
- Alias canonicalization cannot choose a fallback. Fallback uses explicit registry blank-tab display order, not registration order, alphabetic order, or current settings projection.
- Title generation uses the global title-model selection independently from chat. Auxiliary continuation remains provider-owned even when core owns orchestration/parsing.
