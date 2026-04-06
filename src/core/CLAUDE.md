# Core Infrastructure

Core modules stay provider-neutral. Features depend on `core/`; providers implement the boundary behind it.

## Runtime Status

- `core/runtime/` and `core/providers/` define the chat-facing seam. `ChatRuntime` is the neutral runtime interface. `src/providers/claude/runtime/` and `src/providers/codex/runtime/` provide the concrete implementations.
- `ProviderRegistry` owns runtime and auxiliary-service factories. `ProviderWorkspaceRegistry` owns provider workspace services such as command catalogs, agent mentions, CLI resolution, MCP managers, and provider settings tabs.
- Claude-specific agents, plugins, MCP, runtime command discovery, and storage live under `src/providers/claude/`.
- Codex-specific skills, subagents, JSONL history hydration, session tailing, and workspace services live under `src/providers/codex/`.

## Modules

| Module | Purpose | Key Files |
|--------|---------|-----------|
| `bootstrap/` | Provider-neutral session metadata storage and shared app-storage contracts | `SessionStorage`, `storage.ts` |
| `commands/` | Built-in cross-provider commands | `builtInCommands` |
| `mcp/` | Provider-neutral MCP coordination and config parsing | `McpConfigParser`, `McpServerManager`, `McpTester`, `McpStorageAdapter` |
| `prompt/` | Shared prompt templates | `mainAgent`, `inlineEdit`, `titleGeneration`, `instructionRefine` |
| `providers/` | Registry, capability, environment, and workspace-service contracts | `ProviderRegistry`, `ProviderWorkspaceRegistry`, `ProviderSettingsCoordinator`, `providerEnvironment`, `providerConfig`, `modelRouting`, `types` |
| `providers/commands/` | Shared command catalog contracts | `ProviderCommandCatalog`, `ProviderCommandEntry`, `hiddenCommands` |
| `runtime/` | Provider-neutral runtime contracts | `ChatRuntime`, `ChatTurnRequest`, `PreparedChatTurn`, `SessionUpdateResult`, approval/query types |
| `security/` | Permission and approval helpers | `ApprovalManager` |
| `storage/` | Generic filesystem adapters | `VaultFileAdapter`, `HomeFileAdapter` |
| `tools/` | Shared tool constants and formatting helpers | `toolNames`, `toolIcons`, `toolInput`, `todo` |
| `types/` | Shared type definitions | `settings`, `mcp`, `chat`, `tools`, `diff`, `agent`, `plugins` |

## Dependency Rules

```text
types/ <- all modules
storage/ <- bootstrap/, provider workspace services
runtime/ + providers/ <- provider implementations
features/ -> core contracts only
```

## Key Patterns

### ChatRuntime

```typescript
const runtime = ProviderRegistry.createChatRuntime({ plugin, providerId });
const preparedTurn = runtime.prepareTurn(request);

for await (const chunk of runtime.query(preparedTurn, history)) {
  // Feature layer consumes provider-neutral StreamChunk values.
}
```

### Provider Factories

```typescript
const titleService = ProviderRegistry.createTitleGenerationService(plugin, providerId);
const refineService = ProviderRegistry.createInstructionRefineService(plugin, providerId);
const inlineEditService = ProviderRegistry.createInlineEditService(plugin, providerId);
```

### Workspace Services

```typescript
const catalog = ProviderWorkspaceRegistry.getCommandCatalog(providerId);
const agentMentions = ProviderWorkspaceRegistry.getAgentMentionProvider(providerId);
const cliResolver = ProviderWorkspaceRegistry.getCliResolver(providerId);
```

### Storage

- `core/storage/` provides generic vault/home adapters only
- Provider-owned workspace storage lives under `src/providers/claude/storage/` and `src/providers/codex/storage/`
- Provider-owned transcript hydration and deletion live under provider `history/` services

## Gotchas

- `ChatRuntime.cleanup()` must run when a tab is disposed
- `Conversation.providerState` is intentionally opaque in feature code; provider-specific fields belong behind typed provider helpers
- Plan mode is capability-driven
  - Claude enters and exits plan mode through provider/runtime events
  - Codex sends `collaborationMode` on `turn/start` and uses post-stream plan approval metadata
- Command discovery differs by provider
  - Claude merges runtime-discovered commands with vault commands and skills
  - Codex skill discovery comes from `CodexSkillCatalog` and does not depend on runtime command discovery
