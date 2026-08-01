# Core Infrastructure

`src/core/` is provider-neutral infrastructure. Features depend on core contracts; providers implement those contracts behind the registry boundary.

## Ownership

| Module | Owns |
| --- | --- |
| `bootstrap/` | Provider-neutral session metadata storage and shared app-storage contracts |
| `commands/` | Built-in cross-provider commands |
| `mcp/` | Provider-neutral MCP coordination and config parsing |
| `prompt/` | Shared prompt templates |
| `providers/` | Registry, capability, environment, model-routing, and workspace-service contracts |
| `providers/commands/` | Shared command catalog contracts |
| `execution/` | Provider execution, lifecycle, interaction, request, event, and session contracts |
| `security/` | Permission and approval helpers |
| `storage/` | Generic vault/home filesystem adapters |
| `tools/` | Shared tool constants and formatting helpers |
| `types/` | Shared type definitions |

## Dependency Rules

```text
types/ <- all modules
storage/ <- bootstrap/, provider workspace services
execution/ + providers/ <- provider implementations
features/ -> core contracts only
```

Do not import provider implementation files from `core/`. If shared behavior needs provider data, add an explicit contract and have providers implement it.

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
