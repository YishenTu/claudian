# Claude Provider

`src/providers/claude/` wraps `@anthropic-ai/claude-agent-sdk` behind `ChatRuntime` and layers Claude Code CLI compatibility around it.

## Ownership

- Runtime lifecycle, prompt encoding, stream transforms, history hydration, CLI resolution, plugin discovery, agent discovery, MCP storage, settings UI, and Claude-specific storage live here.
- Shared feature code should consume Claude behavior through core contracts and registries.

## Design Rules

- Keep the persistent SDK query alive across turns when possible. Update model, permission mode, MCP servers, and effort through SDK calls.
- Restart the persistent query when the effective system prompt, disabled-tool set, plugin set, settings source set, CLI path, Chrome enablement, or external context paths change.
- Do not duplicate assistant text. The SDK can emit text incrementally and again in the final assistant message; stream handling must preserve the existing dedupe behavior.
- Token usage is intentionally merged from assistant and result messages. Assistant messages provide accurate input-side counts; result messages provide authoritative context-window data.
- `createCustomSpawnFunction()` handles Obsidian/Electron process quirks. Preserve full-path `node` resolution and manual abort handling.

## Storage Rules

- `CCSettingsStorage.save()` must merge with existing `.claude/settings.json`; Claudian only owns permissions and plugin enablement.
- `.claude/mcp.json` has a Claude-compatible `mcpServers` namespace and a Claudian `_claudian.servers` metadata namespace. Keep them separate.
- Plugin enabled state is dual-written to `.claude/settings.json` and `PluginManager.plugins[].enabled`. Keep both in sync.
- Slash command IDs use reversible encoding: dashes become `-_`, slashes become `--`.

## Runtime Gotchas

- SDK amnesia is detected when the returned session ID differs from the resume ID. The next turn injects full conversation history unless this is the first `session_init` after a fork.
- Crash recovery retries once only when the previous send produced no chunks.
- Auto-triggered SDK turns can arrive without a registered handler; they buffer until the result event.
- `MessageChannel` coalesces text-only queued messages and keeps only one queued attachment message.
- Claude session files are tree-structured. Branch filtering must preserve the canonical branch plus relevant sibling tool results.
- `EnterPlanMode` does not hit `canUseTool`; `ExitPlanMode` does.
- Context-window selection must handle multi-model runs by exact model match first, then family match, and null on ambiguity.
