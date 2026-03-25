# Core Infrastructure

Core modules have **no feature dependencies**. Features depend on core, never the reverse.

## Runtime Status

- Current state: `core/` contains provider-neutral contracts; Claude-specific runtime has moved to `src/providers/claude/`.
- `core/runtime/` and `core/providers/` define the chat-facing seam. `ChatRuntime` is the neutral interface; `ClaudeChatRuntime` in `src/providers/claude/runtime/` is the Claude implementation.
- Claude-specific agents, plugins, prompts, SDK helpers, and workspace storage live under `src/providers/claude/`.
- Execution reference: [`docs/multi-provider-execution-plan.md`](../../docs/multi-provider-execution-plan.md)

## Modules

| Module | Purpose | Key Files |
|--------|---------|-----------|
| `commands/` | Built-in command actions | `builtInCommands` |
| `images/` | Image caching | SHA-256 dedup, base64 encoding |
| `mcp/` | Model Context Protocol | `McpServerManager`, `McpTester` |
| `providers/` | Provider registry and provider-owned boundary services | `ProviderRegistry`, `ProviderCapabilities`, `ProviderId`, history/task/CLI service contracts |
| `runtime/` | Provider-neutral runtime contracts | `ChatRuntime`, `ChatTurnRequest`, `PreparedChatTurn`, `SessionUpdateResult`, approval/query types |
| `security/` | Access control | `ApprovalManager` (permission utilities), `BashPathValidator`, `BlocklistChecker` |
| `storage/` | Generic persistence primitives | `VaultFileAdapter` |
| `tools/` | Tool utilities | `toolNames` (incl. plan mode tools), `toolIcons`, `toolInput`, `todo` |
| `types/` | Type definitions | `settings`, `mcp`, `chat`, `tools`, `diff` |

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
- `BlocklistChecker`: Platform-specific dangerous commands

## Gotchas

- `ChatRuntime.cleanup()` must be called on tab close
- Storage paths are encoded: non-alphanumeric → `-`
- Plan mode uses dedicated callbacks (`exitPlanModeCallback`, `permissionModeSyncCallback`) that bypass normal approval flow in `canUseTool`. `EnterPlanMode` is auto-approved by the SDK; the stream event is detected to sync UI state.
- Session bookkeeping (`providerSessionId`, `forkSource`, `previousProviderSessionIds`) is handled by `ChatRuntime.buildSessionUpdates()` — features should not access these fields directly. All conversations use SDK-native storage; legacy JSONL storage has been removed.
