# Claude Provider

`src/providers/claude/` implements provider-neutral execution contracts over `@anthropic-ai/claude-agent-sdk` and layers Claude Code CLI compatibility around it.

## Dependency Boundary

- Native SDK events, options, transcript records, and provider state must be normalized before crossing into core or feature contracts.
- Existing imports from provider compatibility storage/types into `src/app/` are migration seams. Do not add new ones; move a shared contract into `core/` when changing those seams materially.

## Ownership

| Area | Owns |
| --- | --- |
| `execution/` | Provider execution-session binding, snapshots, event adaptation, interactions, and recovery policy |
| `runtime/` | Persistent SDK query, restart decisions, message-channel behavior, CLI spawning, and native prompt construction |
| `history/` | Read-only native transcript discovery, branch projection, historical model recovery, rewind, and subagent replay |
| `app/`, `commands/`, `agents/`, `plugins/` | Workspace-scoped discovery and provider-native catalogs |
| `storage/` | Only the documented Claudian-managed portions of Claude-compatible settings, command, skill, agent, and plugin files |
| `types/` | Typed interpretation and sanitization of Claude-owned provider state |

The execution session owns the live provider snapshot. History services reconstruct replay state but must not become a second live-session authority.

## Design Rules

- Keep the persistent SDK query alive across turns when possible. Update model, permission mode, and effort through SDK calls.
- Claude's provider fallback model is a user preference resolved against the current dynamic model options, including environment-mapped and custom options. Fresh settings prefer the Opus tier; an unavailable preference falls back without changing existing conversations or the global future-tab seed.
- Restart the persistent query when the effective system prompt, disabled-tool set, plugin set, settings source set, CLI path, Chrome enablement, auto-mode enablement, or external context paths change.
- Do not duplicate assistant text. The SDK can emit text incrementally and again in the final assistant message; stream handling must preserve the existing dedupe behavior.
- Token usage is intentionally merged from assistant and result messages. Assistant messages provide accurate input-side counts; result messages provide authoritative context-window data.
- `createCustomSpawnFunction()` handles Obsidian/Electron process quirks. Preserve full-path `node` resolution and manual abort handling.

## Storage Rules

- `CCSettingsStorage.save()` must merge with existing `.claude/settings.json`; Claudian only owns permissions and plugin enablement.
- Claude Code owns MCP configuration, authentication, health checks, and connection lifecycle through its native CLI and settings scopes. At application storage initialization, the composition root invokes the Claude-owned legacy cleanup to delete `.claude/mcp.json`; no other Claudian code may read, write, inject, or migrate that path.
- Plugin enabled state is dual-written to `.claude/settings.json` and `PluginManager.plugins[].enabled`. Keep both in sync.
- Native transcripts are read from `{CLAUDE_CONFIG_DIR:-~/.claude}/projects/{vault}/`; resolve the config dir through `resolveClaudeConfigDir`, never hardcode `~/.claude`.
- Historical selected-model recovery returns a provider-qualified model only from a valid active-branch checkpoint. For multi-segment conversations, the checkpoint-bearing or latest authoritative segment must resolve; do not silently fall back to an older segment's model or make the recovery locator resumable.
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

- Restarting or recovering a query must preserve the intended conversation binding and must not duplicate visible output.
- Provider snapshots are the only path from live SDK state into persisted Claudian resume state.
