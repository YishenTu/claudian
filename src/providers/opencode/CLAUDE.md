# OpenCode Provider

OpenCode integration via ACP (Agent Client Protocol) over stdio JSON-RPC 2.0.

## Architecture

- **Runtime**: `OpenCodeChatRuntime` - JSON-RPC client over stdio
- **CLI**: `opencode acp --cwd <path>` - Starts ACP server
- **Protocol**: ACP v1 (Agent Client Protocol)
- **Session Management**: OpenCode manages sessions internally
- **Transport**: Newline-delimited JSON over stdin/stdout

## Key Differences from Claude/Codex

| Feature | Claude | Codex | OpenCode |
|---------|--------|-------|----------|
| SDK | `@anthropic-ai/claude-agent-sdk` | `codex app-server` | `opencode acp` |
| Protocol | SDK internal | JSON-RPC 2.0 | JSON-RPC 2.0 (ACP) |
| Session | Persistent query | Thread-based | ACP session |
| History | SDK-managed | JSONL files | ACP protocol |
| Commands | Runtime discovery | Skill catalog | Not exposed yet |

## ACP Protocol Flow

1. **Initialize**: `initialize` → protocol version negotiation
2. **New Session**: `session/new` → creates session with cwd and MCP servers
3. **Prompt**: `session/prompt` → sends user message
4. **Notifications**: Stream responses via `session/update` notifications
5. **Cancel**: `session/cancel` → cancels current turn

## Current Limitations

- No plan mode support (can be added later)
- No rewind support
- No fork support
- Simple title generation (no LLM call)
- No skill/command catalog
- Basic instruction refinement

## Future Enhancements

- Plan mode integration
- Session fork/resume
- Enhanced title generation via LLM
- Skill catalog from `.opencode/skills/`
- Subagent support
- Enhanced permission handling

## Storage

OpenCode manages its own storage:
- Sessions: `~/.opencode/sessions/` (managed by OpenCode)
- Config: `.opencode/` in project root
- MCP: Managed by OpenCode internally

## CLI Detection

`OpenCodeCliResolver` searches for opencode in:
1. Explicit path from settings (`opencodeCliPath`)
2. PATH environment variable
3. npm global installation path

## Testing

```bash
# Test ACP protocol manually
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | opencode acp
```
