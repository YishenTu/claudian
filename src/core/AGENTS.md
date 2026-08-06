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
- Bootstrap persistence stores Claudian metadata and input ledgers. Provider transcript files remain provider-owned and read-only.
- Registries own registration and lookup; they do not absorb the lifecycle or storage responsibilities of the registered service.

## Routing Rules

- Title generation routes by the global `titleGenerationModel`, independently of the active chat provider. Core owns its shared prompt, parsing, cancellation, and callback flow over ephemeral execution sessions.
- For instruction refinement and inline edit, core owns multi-turn orchestration and response parsing; provider backends own native continuation, tools, and lifecycle behavior.
- Resolve provider workspace services through `ProviderWorkspaceRegistry`, not concrete providers.

## Gotchas

- Missing historical model selections are recovered through `ProviderConversationHistoryService`; core defines the contract, providers interpret native history, and the application repository coordinates persistence and race fencing.
- Command discovery is provider-owned; do not normalize provider-specific discovery sources in feature code.
- Provider command caches and live snapshots are resource-generation fenced; cache identities contain only provider-owned non-secret fingerprints and monotonic generations.
