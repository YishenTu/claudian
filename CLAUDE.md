# CLAUDE.md

## Project Overview

Geminian - An Obsidian plugin that embeds Gemini CLI as a sidebar chat interface. The vault directory becomes Gemini's working directory, giving it full agentic capabilities: file read/write, bash commands, and multi-step workflows.

## Commands

```bash
npm run dev        # Development (watch mode)
npm run build      # Production build
npm run typecheck  # Type check
npm run lint       # Lint code
npm run lint:fix   # Lint and auto-fix
npm run test       # Run tests
npm run test:watch # Run tests in watch mode
```

## Architecture

| Layer | Purpose | Details |
|-------|---------|---------|
| **core** | Infrastructure (no feature deps) | See [`src/core/CLAUDE.md`](src/core/CLAUDE.md) |
| **features/chat** | Main sidebar interface | See [`src/features/chat/CLAUDE.md`](src/features/chat/CLAUDE.md) |
| **features/inline-edit** | Inline edit modal | `InlineEditService`, read-only tools |
| **features/settings** | Settings tab | UI components for all settings |
| **shared** | Reusable UI | Dropdowns, instruction modal, fork target modal, @-mention, icons |
| **i18n** | Internationalization | 10 locales |
| **utils** | Utility functions | date, path, env, editor, session, markdown, diff, context, sdkSession, frontmatter, slashCommand, mcp, geminiCli, externalContext, externalContextScanner, fileLink, imageEmbed, inlineEdit |
| **style** | Modular CSS | See [`src/style/CLAUDE.md`](src/style/CLAUDE.md) |

## Tests

```bash
npm run test -- --selectProjects unit        # Run unit tests
npm run test -- --selectProjects integration # Run integration tests
npm run test:coverage -- --selectProjects unit # Unit coverage
```

Tests mirror `src/` structure in `tests/unit/` and `tests/integration/`.

## Storage

| File | Contents |
|------|----------|
| `.claude/settings.json` | CC-compatible: permissions, env, enabledPlugins |
| `.claude/geminian-settings.json` | Geminian-specific settings (model, UI, etc.) |
| `.claude/settings.local.json` | Local overrides (gitignored) |
| `.claude/mcp.json` | MCP server configs |
| `.claude/commands/*.md` | Slash commands (YAML frontmatter) |
| `.claude/agents/*.md` | Custom agents (YAML frontmatter) |
| `.claude/skills/*/SKILL.md` | Skill definitions |
| `.claude/sessions/*.meta.json` | Session metadata |
| `~/.claude/projects/{vault}/*.jsonl` | SDK-native session messages |

## Development Notes

- **CLI-first**: Proactively use native Gemini CLI features over custom implementations. If the CLI provides a capability, use it — do not reinvent it. This ensures compatibility with Gemini CLI.
- **CLI exploration**: When developing CLI-related features, write a throwaway test script (e.g., in `dev/`) that calls the real CLI to observe actual response shapes, event sequences, and edge cases. Real output lands in `~/.gemini/` or `{vault}/.gemini/` — inspect those files to understand patterns and formats. Run this before writing implementation or tests — real output beats guessing at types and formats. This is the default first step for any CLI integration work.
- **Comments**: Only comment WHY, not WHAT. No JSDoc that restates the function name (`/** Get servers. */` on `getServers()`), no narrating inline comments (`// Create the channel` before `new Channel()`), no module-level docs on barrel `index.ts` files. Keep JSDoc only when it adds non-obvious context (edge cases, constraints, surprising behavior).
- **TDD workflow**: For new functions/modules and bug fixes, follow red-green-refactor:
  1. Write a failing test first in the mirrored path under `tests/unit/` (or `tests/integration/`)
  2. Run it with `npm run test -- --selectProjects unit --testPathPattern <pattern>` to confirm it fails
  3. Write the minimal implementation to make it pass
  4. Refactor, keeping tests green
  - For bug fixes, write a test that reproduces the bug before fixing it
  - Test behavior and public API, not internal implementation details
  - Skip TDD for trivial changes (renaming, moving files, config tweaks) — but still verify existing tests pass
- Run `npm run typecheck && npm run lint && npm run test && npm run build` after editing
- No `console.*` in production code 
  - use Obsidian's notification system if user should be notified
  - use `console.log` for debugging, but remove it before committing
- Generated docs/test scripts go in `dev/`.
