# Session Summary: MCP Tool Toggle Feature

**Status**: In Progress (Plan Approved, Ready for Implementation)

## Objective
Implement a feature that allows users to toggle on/off individual MCP tools in the settings. When testing an MCP server, users should see available tools with toggle switches to disable tools they don't want.

## User Requirements
- Show available tools with toggle switches when testing an MCP server
- Persist disabled tools in `mcp.json` under `_claudian.servers.<name>.disabledTools`
- Auto-save on each toggle (no explicit Save button)
- **Save context window** by hiding disabled tools from agent entirely

## Actions Taken
1. **Explored codebase** - Understood MCP test modal, storage, settings UI, and how tools flow through SDK
2. **Clarified requirements** - User chose persistence in mcp.json + auto-save on toggle
3. **Initial plan** - Created PreToolUse hook approach to block disabled tools at runtime
4. **User feedback** - Asked if there's a way to hide tools entirely to save context window
5. **Discovered better approach** - Found SDK has `disallowedTools` option that hides tools from agent
6. **Updated plan** - Switched to using SDK's `disallowedTools` (simpler, saves context)
7. **Plan approved** - User approved the final implementation plan

## Decisions Made
- **Use `disallowedTools` over PreToolUse hook**: SDK's `disallowedTools` option hides tools from agent entirely, saving context window. Better than hook which only blocks at runtime.
- **Tool naming pattern**: MCP tools follow `mcp__<server-name>__<tool-name>` format
- **Storage location**: `_claudian.servers.<name>.disabledTools` in `.claude/mcp.json`

## Current State
- Plan approved
- No code changes made yet
- Ready to begin implementation

---

# Full Implementation Plan

## Summary
Add toggle switches to the MCP test modal so users can enable/disable individual tools per MCP server. Disabled tools are persisted in `.claude/mcp.json` and **hidden from the agent using SDK's `disallowedTools` option** (saves context window).

## Key Insight
The SDK has a `disallowedTools` option that **hides tools from the agent entirely**. MCP tools follow the naming pattern `mcp__<server-name>__<tool-name>`. By passing disabled tool names to `disallowedTools`, we save context window (better than a PreToolUse hook which only blocks at runtime).

**Sources:**
- [SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) - Documents `disallowedTools` option
- [MCP in SDK](https://platform.claude.com/docs/en/agent-sdk/mcp) - Shows MCP tool naming convention

---

## Implementation Steps

### 1. Add `disabledTools` to types
**File**: `src/core/types/mcp.ts`

- Add `disabledTools?: string[]` to `ClaudianMcpServer` interface
- Add `disabledTools?: string[]` to `_claudian.servers` type in `ClaudianMcpConfigFile`

### 2. Update McpStorage to handle disabledTools
**File**: `src/core/storage/McpStorage.ts`

- In `load()`: Read `disabledTools` from `_claudian.servers.<name>`
- In `save()`: Write `disabledTools` only if non-empty (like other optional fields)

### 3. Add getDisallowedMcpTools to McpServerManager
**File**: `src/core/mcp/McpServerManager.ts`

```typescript
/** Get all disabled MCP tools formatted for SDK disallowedTools option. */
getDisallowedMcpTools(): string[] {
  const disallowed: string[] = [];
  for (const server of this.servers) {
    if (server.enabled && server.disabledTools) {
      for (const tool of server.disabledTools) {
        disallowed.push(`mcp__${server.name}__${tool}`);
      }
    }
  }
  return disallowed;
}
```

### 4. Pass disallowedTools to SDK options
**File**: `src/core/agent/ClaudianService.ts`

In `queryViaSDK()`, add disabled MCP tools to SDK options:

```typescript
// Get disabled MCP tools and pass to SDK
const disallowedMcpTools = this.mcpManager.getDisallowedMcpTools();
if (disallowedMcpTools.length > 0) {
  options.disallowedTools = disallowedMcpTools;
}
```

### 5. Update McpTestModal with toggle UI
**File**: `src/ui/modals/McpTestModal.ts`

- Add constructor params: `initialDisabledTools?: string[]`, `onToolToggle?: (toolName, enabled) => Promise<void>`
- Track disabled tools in `Set<string>`
- In `renderTool()`: Add toggle button next to each tool name
- On toggle click: Update set, update UI, call `onToolToggle` callback

### 6. Wire up McpSettingsManager
**File**: `src/ui/settings/McpSettingsManager.ts`

In `testServer()`:
- Pass `server.disabledTools` and toggle callback to `McpTestModal`
- Toggle callback updates server's `disabledTools`, saves to storage, reloads MCP servers

### 7. Add CSS for toggle styling
**File**: `src/style/modals/mcp-modal.css`

- `.claudian-mcp-test-tool-toggle` - Container for toggle button
- `.claudian-toggle-btn` / `.claudian-toggle-btn.is-enabled` - Toggle button states
- `.claudian-mcp-test-tool-disabled` - Dimmed/strikethrough for disabled tools

### 8. Add unit tests
**File**: `tests/unit/core/mcp/McpServerManager.test.ts`

Test `getDisallowedMcpTools()`:
- Returns empty array when no disabled tools
- Formats tool names correctly: `mcp__server__tool`
- Only includes tools from enabled servers
- Handles multiple servers with different disabled tools

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/core/types/mcp.ts` | Add `disabledTools` field |
| `src/core/storage/McpStorage.ts` | Load/save `disabledTools` |
| `src/core/mcp/McpServerManager.ts` | Add `getDisallowedMcpTools()` method |
| `src/core/agent/ClaudianService.ts` | Pass `disallowedTools` to SDK options |
| `src/ui/modals/McpTestModal.ts` | Add toggle UI |
| `src/ui/settings/McpSettingsManager.ts` | Pass callback to modal |
| `src/style/modals/mcp-modal.css` | Toggle styling |
| `tests/unit/core/mcp/McpServerManager.test.ts` | Add tests |

## Implementation Order

1. Types (`mcp.ts`)
2. Storage (`McpStorage.ts`)
3. McpServerManager (`getDisallowedMcpTools`)
4. ClaudianService (pass to SDK options)
5. McpTestModal (toggle UI)
6. McpSettingsManager (wire callback)
7. CSS styling
8. Tests

## Advantages Over Hook Approach
- **Saves context window**: Disabled tools not sent to agent at all
- **Simpler**: No hook parsing/filtering logic needed
- **SDK-native**: Uses built-in SDK capability
- **Fewer files to modify**: No changes to SecurityHooks.ts

---

## Context & Notes

### Key Code Locations
- **MCP Test Modal**: `src/ui/modals/McpTestModal.ts` - Shows tools after testing connection
- **MCP Settings**: `src/ui/settings/McpSettingsManager.ts` - Server list with test button
- **MCP Storage**: `src/core/storage/McpStorage.ts` - Reads/writes `.claude/mcp.json`
- **MCP Types**: `src/core/types/mcp.ts` - `ClaudianMcpServer` interface
- **Agent Service**: `src/core/agent/ClaudianService.ts` - Passes options to SDK

### Storage Format (mcp.json)
```json
{
  "mcpServers": {
    "google-workspace": { "command": "...", "args": [...] }
  },
  "_claudian": {
    "servers": {
      "google-workspace": {
        "enabled": true,
        "contextSaving": true,
        "disabledTools": ["calendar_createEvent", "gmail_send"]
      }
    }
  }
}
```

### Run Commands
```bash
npm run dev       # Development (watch mode)
npm run build     # Production build
npm run typecheck # Type check
npm run lint      # Lint code
npm run test      # Run tests
```
