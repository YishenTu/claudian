# Core Infrastructure

`src/core/` is provider-neutral infrastructure. Features depend on core contracts; providers implement those contracts behind the registry boundary.

## Dependency Rules

- `bootstrap/` defines provider-neutral persistence contracts and normalization, including recovery-only native locators. It must not interpret provider-native session formats or make those locators resumable.
- `execution/` defines leases, sessions, requests, events, interactions, and lifecycle coordination. It must not construct concrete providers.
- `providers/` defines registries, capabilities, routing, workspace-service contracts, and provider-state boundaries. Registrations supply the concrete implementations.
- `process/` and `rpc/` provide mechanics only. Provider launch arguments, protocol extensions, retry policy, and message semantics stay provider-owned.
- `auxiliary/` may orchestrate provider-neutral executions through core contracts but must not special-case a concrete provider.

Core must consume provider data through explicit contracts. Do not branch on provider IDs when a capability can express the distinction or promote provider-native state into a shared type.

## State Ownership

- `ProviderExecutionLifecycleRegistry` is the source of truth for provider generations, transition fencing, and live session leases. It does not own per-tab turn state or impose a global execution-capacity policy.
- Provider execution sessions own native runtime interaction behind the `ProviderExecutionSession` contract.
- The provider-default main-agent system prompt is one shared Claudian prompt across all providers for the same settings and dynamic sections. Provider adapters may differ in transport and replacement lifecycle, but must not select a provider-specific prompt profile or omit shared sections.
- Provider-default dynamic system-prompt sections are ephemeral execution configuration. Providers include them in effective prompt identity, but Chat must not encode them as user input or persist them in the accepted-input ledger.
- Inline Edit uses one provider-neutral explicit system prompt across all providers. Its runtime context receives the host-provided current date and Vault absolute path; keep tool guidance capability-based, and do not append Main Chat dynamic sections or Custom Instructions.
- `ProviderExecutionRequest.context.linkedContent` is the canonical provider-neutral Linked content reference. New writes use one normalized path-only shape for Notes, folders, or missing content; the Vault root is not a valid target. Compatibility decoders may accept legacy current/linked-Note forms, but providers and features must not emit them. A directory reference is context metadata, not a CWD or recursive-ingestion request.
- Bootstrap persistence stores Claudian metadata and input ledgers. Provider transcript files remain provider-owned and read-only.
- Registries own registration and lookup; they do not absorb the lifecycle or storage responsibilities of the registered service.
- The decision-complete shared Collab wire contract is owned solely by the standalone `@claudian-collab/protocol` package and consumed as an exact registry dependency. `src/core/collab/` retains client-only feature/composer ports, Project selection, local review/conflict/operation projections, and the common discriminated LAN/Cloud Project model. Core must not re-export package symbols, maintain a parallel operation inventory, or copy shared codecs, routes, capabilities, events, limits, errors, or versions. LAN HTTP/event bindings remain application-owned; Cloud binding contracts remain package-owned.
- `CollabFeaturePort` exposes complete presentation-facing review and Ticket detail reads. `CollabBoundedQueryPort` is the separate first-page and continuation-page capability for bounded Runtime consumers; do not add cursor-bearing aliases to the generic feature facade or cache incomplete detail as if it were complete.
- `CollabConflictSession` is a read-only immutable conflict descriptor, optionally paired with a prepared publication review. Per-file resolution decisions are not a core state machine: Contributors and Agents edit the real Project, and Publish validates that committed result.

## Routing Rules

- Title generation routes by the global `titleGenerationModel`, independently of the active chat provider. Core owns its shared prompt, parsing, cancellation, and callback flow over ephemeral execution sessions.
- For instruction refinement and inline edit, core owns multi-turn orchestration and response parsing; provider backends own native continuation, tools, and lifecycle behavior.
- Resolve provider workspace services through `ProviderWorkspaceRegistry`, not concrete providers.
- Chat model resolution distinguishes historical provider ownership from current enabled-option availability. Global future-tab fallback and conversation fallback may use only current provider options and a validated provider-owned default; opaque historical ownership alone is not availability.
- For an unavailable durable conversation selection, `ConversationModelResolution.model` remains the readable stored value and `modelToPersist` carries the desired fallback. Readers must not project `modelToPersist`; the application repository publishes it only after persistence succeeds.
- Provider alias canonicalization used during availability checks must not choose a fallback model. Fallback policy remains a separate ordered/default resolution step.
- Provider fallback order is the registry's explicit blank-tab display order. Do not derive fallback from display-name sorting, registration insertion order, or the current settings projection.

## Gotchas

- Missing historical model selections are recovered through `ProviderConversationHistoryService`; core defines the contract, providers interpret native history, and the application repository coordinates persistence and race fencing.
- Command discovery is provider-owned; do not normalize provider-specific discovery sources in feature code.
- Provider command caches and live snapshots are resource-generation fenced; cache identities contain only provider-owned non-secret fingerprints and monotonic generations.
