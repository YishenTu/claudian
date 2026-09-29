# Claude constraints

- Preserve a live SDK query across turns when native setters suffice. Prompt/tool/plugin/settings-source/launch changes require restart without losing intended binding.
- Native incremental and final assistant messages can duplicate text. Deduplicate them while merging assistant input usage with result `modelUsage.contextWindow`; multi-model context selection must return unknown on ambiguity. `getContextUsage().rawMaxTokens` describes the autocompact threshold and must not supply the context-meter denominator.
- Metadata discovery uses the configured runtime without inference or persisted sessions. Read command metadata after session init: MCP commands can arrive after the initialize response.
- Resolve Node-backed launches through the full Node executable path when available. Handle abort manually: Obsidian's cross-realm `AbortSignal` cannot safely be passed to Node spawn.
- Native Claude owns plugin installation and enablement. Plugin discovery is read-only; permission approvals use SDK permission updates rather than rewriting native settings.
- Native Claude owns MCP setup/authentication/health. Only initialization's legacy cleanup may touch the obsolete `.claude/mcp.json`; never read, inject, or migrate it elsewhere.
- Resolve native history through configured Claude home, not hardcoded default paths. Branch replay must retain relevant sibling tool results.
- Missing authoritative checkpoint/latest-segment model evidence cannot fall back to an older segment or make a recovery-only locator resumable.
- A returned session differing from the resume target triggers history recovery, except initial fork session initialization. Crash retry is allowed only before any output chunk; late automatic turns may arrive without a handler.
- A steer belongs to the requested run until a result consumes it, whether Claude folds it mid-turn or runs it as the next native turn. Queued sends survive a native interrupt, so cancelling with an undelivered steer must replace the process.
