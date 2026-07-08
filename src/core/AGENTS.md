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
| `runtime/` | `ChatRuntime`, turn preparation, streaming, approval, and query contracts |
| `security/` | Permission and approval helpers |
| `storage/` | Generic vault/home filesystem adapters |
| `tools/` | Shared tool constants and formatting helpers |
| `types/` | Shared type definitions |

## Dependency Rules

```text
types/ <- all modules
storage/ <- bootstrap/, provider workspace services
runtime/ + providers/ <- provider implementations
features/ -> core contracts only
```

Do not import provider implementation files from `core/`. If shared behavior needs provider data, add an explicit contract and have providers implement it.

## Key Contracts

```typescript
const runtime = ProviderRegistry.createChatRuntime({ plugin, providerId });
const preparedTurn = runtime.prepareTurn(request);

for await (const chunk of runtime.query(preparedTurn, history)) {
  // Feature layer consumes provider-neutral StreamChunk values.
}
```

Title generation is provider-routed by the global `titleGenerationModel` setting and is independent from the active chat tab provider.

Workspace services are resolved through `ProviderWorkspaceRegistry`:

```typescript
const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
const agentMentions = ProviderWorkspaceRegistry.getAgentMentionProvider(providerId);
const cliResolver = ProviderWorkspaceRegistry.getCliResolver(providerId);
```

## Gotchas

- `ChatRuntime.cleanup()` must run when a tab is disposed.
- `Conversation.providerState` is opaque to feature code. Provider-specific fields belong behind typed provider helpers.
- Plan mode is capability-driven. Do not hardcode provider IDs in feature logic unless the provider contract cannot express the distinction.
- Command discovery differs by provider:
  - Claude merges runtime-discovered commands with vault commands and skills.
  - Codex skills come from `CodexSkillCatalog` and do not depend on runtime command discovery.
  - OpenCode and Pi expose runtime commands through their provider protocols.
