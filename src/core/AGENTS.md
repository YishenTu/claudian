# Core Infrastructure

`src/core/` is provider-neutral infrastructure. Features depend on core contracts; providers implement those contracts behind the registry boundary.

## Ownership

| Module | Owns |
| --- | --- |
| `auxiliary/` | Provider-neutral title generation, instruction refinement, inline edit, and auxiliary-session orchestration |
| `bootstrap/` | Provider-neutral session metadata storage and shared app-storage contracts |
| `commands/` | Built-in cross-provider commands |
| `execution/` | Provider execution, lifecycle, interaction, request, event, and session contracts |
| `mcp/` | Provider-neutral MCP coordination and config parsing |
| `performance/` | Startup performance instrumentation |
| `process/` | Managed subprocess lifecycle primitives |
| `prompt/` | Shared prompt templates |
| `providers/` | Registry, capability, environment, model-routing, and workspace-service contracts |
| `providers/commands/` | Shared command catalog contracts |
| `rpc/` | Provider-neutral JSON-RPC transport primitives |
| `security/` | Permission and approval helpers |
| `skills/` | Shared skill model, codec, validation, and repository contracts |
| `storage/` | Generic vault/home filesystem adapters |
| `tools/` | Shared tool constants and formatting helpers |
| `types/` | Shared type definitions |

## Dependency Rules

In the rules below, `A -> B` means `A` may import or call `B`.

- Features and provider implementations may depend on public core contracts.
- Core modules may depend on shared core types and lower-level adapters, but must not depend on app composition, features, or provider implementations.
- `bootstrap/` defines provider-neutral persistence contracts and normalization. It must not interpret provider-native session formats.
- `execution/` defines leases, sessions, requests, events, interactions, and lifecycle coordination. It must not construct concrete providers.
- `providers/` defines registries, capabilities, routing, workspace-service contracts, and provider-state boundaries. Registrations supply the concrete implementations.
- `process/` and `rpc/` provide mechanics only. Provider launch arguments, protocol extensions, retry policy, and message semantics stay provider-owned.
- `auxiliary/` may orchestrate provider-neutral executions through core contracts but must not special-case a concrete provider.

If shared behavior needs provider data, add an explicit contract and have providers implement it. Do not import a provider implementation into `core/`, use provider-ID conditionals where a capability can express the distinction, or move provider-native state into a shared type.

## State Ownership

- `ProviderExecutionLifecycleRegistry` is the source of truth for provider generations, transition fencing, and live session leases. It does not own per-tab turn state or impose a global execution-capacity policy.
- Provider execution sessions own native runtime interaction behind the `ProviderExecutionSession` contract.
- Bootstrap persistence stores Claudian metadata and input ledgers. Provider transcript files remain provider-owned and read-only.
- Registries own registration and lookup; they do not absorb the lifecycle or storage responsibilities of the registered service.

## Key Contracts

```typescript
const backend = ProviderRegistry.createExecutionBackend(plugin, providerId);
const session = backend.createSession(sessionConfig);
const run = session.execute(request);

for await (const event of run.events) {
  // Feature layer consumes provider-neutral execution events.
}
```

Title generation is provider-routed by the global `titleGenerationModel` setting and is independent from the active chat tab provider. Core owns the shared prompt, parsing, cancellation, and callback workflow over ephemeral execution sessions.

Instruction refinement and inline edit follow the same boundary for multi-turn work: core owns conversation orchestration and response parsing, while provider backends preserve native session continuation, tools, and lifecycle behavior.

Workspace services are resolved through `ProviderWorkspaceRegistry`:

```typescript
const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
const agentMentions = ProviderWorkspaceRegistry.getAgentMentionProvider(providerId);
const cliResolver = ProviderWorkspaceRegistry.getCliResolver(providerId);
```

## Gotchas

- Execution leases and sessions must be cancelled and disposed when their owner closes.
- `Conversation.providerState` is opaque to feature code. Provider-specific fields belong behind typed provider helpers.
- Plan mode is capability-driven. Do not hardcode provider IDs in feature logic unless the provider contract cannot express the distinction.
- Command discovery differs by provider:
  - Claude merges provider-discovered commands with vault commands and skills.
  - Codex skills come from app-server `skills/list` through `CodexSkillCatalog`.
  - OpenCode and Pi expose command metadata through provider-owned probes.
- Provider command caches and live snapshots are resource-generation fenced; cache identities contain only provider-owned non-secret fingerprints and monotonic generations.
