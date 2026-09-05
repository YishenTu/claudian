# Claude constraints

- Preserve a live SDK query across turns when native setters suffice. Prompt/tool/plugin/settings-source/launch/external-context changes require restart without losing intended binding.
- Native incremental and final assistant messages can duplicate text. Deduplicate them while merging assistant input usage with result context-window information; multi-model context selection must return unknown on ambiguity.
- Keep Obsidian/Electron spawn handling, full-path Node resolution, and manual abort behavior.
- Claudian owns only permissions/plugin enablement in Claude settings; merge other keys and preserve the plugin manager's matching enablement state.
- Native Claude owns MCP setup/authentication/health. Only initialization's legacy cleanup may touch the obsolete `.claude/mcp.json`; never read, inject, or migrate it elsewhere.
- Resolve native history through configured Claude home, not hardcoded default paths. Branch replay must retain relevant sibling tool results.
- Missing authoritative checkpoint/latest-segment model evidence cannot fall back to an older segment or make a recovery-only locator resumable.
- A returned session differing from the resume target triggers history recovery, except initial fork session initialization. Crash retry is allowed only before any output chunk; late automatic turns may arrive without a handler.
- EnterPlanMode bypasses canUseTool while ExitPlanMode does not. Preserve that asymmetry when changing permission UI.
