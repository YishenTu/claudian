# Claude constraints

- Preserve a live SDK query across turns when native setters suffice. Prompt/tool/plugin/settings-source/launch changes require restart without losing intended binding.
- Native incremental and final assistant messages can duplicate text. Deduplicate them while merging assistant input usage with result context-window information; multi-model context selection must return unknown on ambiguity.
- Resolve Node-backed launches through the full Node executable path when available. Handle abort manually: Obsidian's cross-realm `AbortSignal` cannot safely be passed to Node spawn.
- Native Claude owns plugin installation and enablement. Plugin discovery is read-only; permission approvals use SDK permission updates rather than rewriting native settings.
- Native Claude owns MCP setup/authentication/health. Only initialization's legacy cleanup may touch the obsolete `.claude/mcp.json`; never read, inject, or migrate it elsewhere.
- Resolve native history through configured Claude home, not hardcoded default paths. Branch replay must retain relevant sibling tool results.
- Missing authoritative checkpoint/latest-segment model evidence cannot fall back to an older segment or make a recovery-only locator resumable.
- A returned session differing from the resume target triggers history recovery, except initial fork session initialization. Crash retry is allowed only before any output chunk; late automatic turns may arrive without a handler.
