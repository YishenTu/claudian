# Claude Provider

`src/providers/claude/` implements provider-neutral execution contracts over `@anthropic-ai/claude-agent-sdk` and layers Claude Code CLI compatibility around it.

## Dependency Boundary

- Claude code may depend on core contracts, shared UI primitives, the Anthropic SDK, and provider-local modules. It must not import chat views or feature controllers.
- Native SDK events, options, transcript records, and provider state must be normalized before crossing into core or feature contracts.
- Existing imports from provider compatibility storage/types into `src/app/` are migration seams. Do not add new ones; move a shared contract into `core/` when changing those seams materially.

## Ownership

| Area | Owns |
| --- | --- |
| `execution/` | Provider execution-session binding, snapshots, event adaptation, interactions, and recovery policy |
| `runtime/` | Persistent SDK query, restart decisions, message-channel behavior, CLI spawning, and native prompt construction |
| `history/` | Read-only native transcript discovery, branch projection, rewind, and subagent replay |
| `app/`, `commands/`, `agents/`, `plugins/` | Workspace-scoped discovery and provider-native catalogs |
| `storage/` | Only the documented Claudian-managed portions of Claude-compatible settings, MCP, command, skill, agent, and plugin files |
| `types/` | Typed interpretation and sanitization of Claude-owned provider state |

The execution session owns the live provider snapshot. History services reconstruct replay state but must not become a second live-session authority.

## Design Rules

- Keep the persistent SDK query alive across turns when possible. Update model, permission mode, MCP servers, and effort through SDK calls.
- Restart the persistent query when the effective system prompt, disabled-tool set, plugin set, settings source set, CLI path, Chrome enablement, auto-mode enablement, or external context paths change.
- Do not duplicate assistant text. The SDK can emit text incrementally and again in the final assistant message; stream handling must preserve the existing dedupe behavior.
- Token usage is intentionally merged from assistant and result messages. Assistant messages provide accurate input-side counts; result messages provide authoritative context-window data.
- `createCustomSpawnFunction()` handles Obsidian/Electron process quirks. Preserve full-path `node` resolution and manual abort handling.

## Storage Rules

- `CCSettingsStorage.save()` must merge with existing `.claude/settings.json`; Claudian only owns permissions and plugin enablement.
- `.claude/mcp.json` has a Claude-compatible `mcpServers` namespace and a Claudian `_claudian.servers` metadata namespace. Keep them separate.
- Plugin enabled state is dual-written to `.claude/settings.json` and `PluginManager.plugins[].enabled`. Keep both in sync.
- Native transcripts are read from `{CLAUDE_CONFIG_DIR:-~/.claude}/projects/{vault}/`; resolve the config dir through `resolveClaudeConfigDir`, never hardcode `~/.claude`.
- Slash command IDs use reversible encoding: dashes become `-_`, slashes become `--`.

## Runtime Gotchas

- SDK amnesia is detected when the returned session ID differs from the resume ID. The next turn injects full conversation history unless this is the first `session_init` after a fork.
- Crash recovery retries once only when the previous send produced no chunks.
- Auto-triggered SDK turns can arrive without a registered handler; they buffer until the result event.
- `MessageChannel` coalesces text-only queued messages and keeps only one queued attachment message.
- Claude session files are tree-structured. Branch filtering must preserve the canonical branch plus relevant sibling tool results.
- `EnterPlanMode` does not hit `canUseTool`; `ExitPlanMode` does.
- Context-window selection must handle multi-model runs by exact model match first, then family match, and null on ambiguity.

## Invariants

- Dynamic model, permission, MCP, and effort updates must not restart a compatible persistent query.
- Restarting or recovering a query must preserve the intended conversation binding and must not duplicate visible output.
- Provider snapshots are the only path from live SDK state into persisted Claudian resume state.
- Reads of native transcripts and user-owned Claude configuration are non-destructive; writes merge only the fields explicitly owned above.
