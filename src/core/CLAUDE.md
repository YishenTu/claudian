# Core Infrastructure

Core modules have **no feature dependencies**. Features depend on core, never the reverse.

## Runtime Status

- Current state: `core/` contains provider-neutral contracts and shared prompt templates. Provider-specific runtimes and prompts live under `src/providers/{id}/`.
- `core/runtime/` and `core/providers/` define the chat-facing seam. `ChatRuntime` is the neutral interface; `ClaudeChatRuntime` in `src/providers/claude/runtime/` and `CodexChatRuntime` in `src/providers/codex/runtime/` are the provider implementations.
- Claude-specific agents, plugins, SDK helpers, and workspace storage live under `src/providers/claude/`. Codex-specific skills, subagents, normalization, and workspace storage live under `src/providers/codex/`.

## Modules

| Module | Purpose | Key Files |
|--------|---------|-----------|
| `bootstrap/` | Shared app defaults and storage | `DEFAULT_CLAUDIAN_SETTINGS`, `SharedAppStorage` |
| `commands/` | Built-in command actions | `builtInCommands` |
| `mcp/` | Model Context Protocol | `McpServerManager`, `McpTester`, `McpStorageAdapter` |
| `prompt/` | Shared prompt templates | `mainAgent`, `inlineEdit`, `titleGeneration`, `instructionRefine` |
| `providers/` | Provider registry and provider-owned boundary services | `ProviderRegistry`, `ProviderSettingsCoordinator`, `ProviderWorkspaceRegistry`, `ProviderCapabilities`, `ProviderId`, `modelRouting`, history/task/CLI service contracts |
| `providers/commands/` | Shared command catalog contracts | `ProviderCommandCatalog`, `ProviderCommandEntry`, `hiddenCommands` |
| `runtime/` | Provider-neutral runtime contracts | `ChatRuntime`, `ChatTurnRequest`, `PreparedChatTurn`, `SessionUpdateResult`, approval/query types |
| `security/` | Access control | `ApprovalManager` (permission utilities), `BashPathValidator` |
| `storage/` | Generic persistence primitives | `VaultFileAdapter`, `HomeFileAdapter` |
| `tools/` | Tool utilities | `toolNames` (incl. plan mode + runtime lifecycle tools), `toolIcons`, `toolInput`, `todo` |
| `types/` | Type definitions | `settings`, `mcp`, `chat`, `tools`, `diff`, `agent`, `plugins` |

## Refactor Guardrails

- Do not add new feature-layer imports of Claude SDK types, Claude history helpers, or Claude task-result parsers.
- New provider-neutral contracts should land in `src/core/runtime/` or `src/core/providers/`, not in feature modules.
- Keep generic security and storage primitives in `core/`; move provider-owned hooks, prompt templates, SDK parsing, session archives, and mapping logic behind the provider boundary.
- Auxiliary services (title generation, instruction refinement, inline edit) are created via `ProviderRegistry` factory methods, not instantiated directly in features.

## Dependency Rules

```
types/ ← (all modules can import)
storage/ ← security/, mcp/
providers/ ← runtime feature/adaptor selection
```

## Key Patterns

### ChatRuntime
```typescript
// One runtime per tab (lazy init on first query)
const runtime = ProviderRegistry.createChatRuntime({ plugin, mcpManager });
const turn = runtime.prepareTurn(request); // Encode context
for await (const chunk of runtime.query(turn, history)) { ... }
runtime.cancel(); // Cancel streaming
```

### Provider Factories
```typescript
// Aux services created via registry (not direct instantiation)
const titleService = ProviderRegistry.createTitleGenerationService(plugin);
const refineService = ProviderRegistry.createInstructionRefineService(plugin);
const inlineEditService = ProviderRegistry.createInlineEditService(plugin);
```

### Storage
```typescript
// Generic vault adapter in core
const adapter = storage.getAdapter();

// Provider-owned workspace/session storage lives under src/providers/claude/storage/
```

### Security
- `BashPathValidator`: Vault-only by default, symlink-safe via `realpath`
- `ApprovalManager`: Permission utility functions (`buildPermissionUpdates`, `matchesRulePattern`, etc.)

## Gotchas

- `ChatRuntime.cleanup()` must be called on tab close
- Storage paths are encoded: non-alphanumeric → `-`
- Plan mode uses dedicated callbacks (`exitPlanModeCallback`, `permissionModeSyncCallback`) that bypass normal approval flow in `canUseTool`. `EnterPlanMode` is auto-approved by the SDK; the stream event is detected to sync UI state.
- Session bookkeeping lives in `Conversation.providerState` (opaque bag). `ChatRuntime.buildSessionUpdates()` manages it — features should not read or write provider-specific fields directly. Claude-specific state (`providerSessionId`, `forkSource`, `previousProviderSessionIds`) is typed as `ClaudeProviderState` behind the provider boundary.
