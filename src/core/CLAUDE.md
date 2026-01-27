# Core Infrastructure

Core modules have **no feature dependencies**. Features depend on core, never the reverse.

## Modules

| Module | Purpose | Key Files |
|--------|---------|-----------|
| `agent/` | Claude Agent SDK wrapper | `ClaudianService`, `SessionManager`, `QueryOptionsBuilder`, `MessageChannel`, `customSpawn` |
| `agents/` | Custom agent discovery | `AgentManager`, `AgentStorage` |
| `commands/` | Built-in command actions | `builtInCommands` |
| `hooks/` | Security hooks | `SecurityHooks` |
| `images/` | Image caching | SHA-256 dedup, base64 encoding |
| `mcp/` | Model Context Protocol | `McpServerManager`, `McpService`, `McpTester` |
| `plugins/` | Claude Code plugins | `PluginManager`, `PluginStorage` |
| `prompts/` | System prompts | `mainAgent`, `inlineEdit`, `instructionRefine`, `titleGeneration` |
| `sdk/` | SDK message transform | `transformSDKMessage`, `typeGuards`, `types` |
| `security/` | Access control | `ApprovalManager` (permission utilities), `BashPathValidator`, `BlocklistChecker` |
| `storage/` | Persistence layer | `StorageService`, `SessionStorage`, `CCSettingsStorage`, `ClaudianSettingsStorage`, `McpStorage`, `SlashCommandStorage`, `VaultFileAdapter` |
| `tools/` | Tool utilities | `toolNames`, `toolIcons`, `toolInput`, `todo` |
| `types/` | Type definitions | `settings`, `agent`, `mcp`, `chat`, `tools`, `models`, `sdk`, `plugins`, `diff` |

## Dependency Rules

```
types/ ← (all modules can import)
storage/ ← security/, agent/, mcp/
security/ ← agent/
sdk/ ← agent/
hooks/ ← agent/
prompts/ ← agent/
```

## Key Patterns

### ClaudianService
```typescript
// One instance per tab (lazy init on first query)
const service = new ClaudianService(plugin, vaultPath);
await service.query(prompt, options);  // Returns async iterator
service.abort();  // Cancel streaming
```

### QueryOptionsBuilder
```typescript
// Builds SDK Options from settings
const builder = new QueryOptionsBuilder(plugin, settings);
const options = builder.build({ sessionId, maxThinkingTokens });
```

### Storage (Claude Code pattern)
```typescript
// Settings in vault/.claude/settings.json
await CCSettingsStorage.load(vaultPath);
await CCSettingsStorage.save(vaultPath, settings);

// Sessions: SDK-native (~/.claude/projects/) + metadata overlay (.meta.json)
await SessionStorage.loadSession(vaultPath, sessionId);
```

### Security
- `BashPathValidator`: Vault-only by default, symlink-safe via `realpath`
- `ApprovalManager`: Permission utility functions (`buildPermissionUpdates`, `matchesRulePattern`, etc.)
- `BlocklistChecker`: Platform-specific dangerous commands

## Gotchas

- `ClaudianService` must be disposed on tab close (abort + cleanup)
- `SessionManager` handles SDK session resume via `sessionId`
- Storage paths are encoded: non-alphanumeric → `-`
- `customSpawn` handles cross-platform process spawning
