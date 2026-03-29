# CLAUDE.md

## Project Overview

Claudian - An Obsidian plugin that embeds Claude Code as a sidebar chat interface. The vault directory becomes Claude's working directory, giving it full agentic capabilities: file read/write, bash commands, and multi-step workflows.

## Architecture Status

- Product status: Claudian is a multi-provider product. Claude is the primary provider with full feature support. Codex is the second provider, supporting the essential chat lifecycle (send, stream, cancel, resume, history reload). Unsupported Codex features (fork, rewind, plan mode, inline edit, instructions, subagents, plugins, MCP, images) are gated in UI.
- Architecture: `src/core/bootstrap/` provides shared app defaults and storage. `src/core/runtime/` and `src/core/providers/` provide the provider-neutral chat seam. `ProviderRegistration` is chat-facing only. `ProviderSettingsCoordinator` reconciles settings per-provider. `src/core/providers/commands/` defines the shared `ProviderCommandCatalog` and `ProviderCommandEntry` contracts. Chat tabs/controllers depend on `ChatRuntime`, `ProviderCapabilities`, and `ProviderCommandCatalog` for routing, feature gating, and command/skill discovery.
- Claude adaptor: `src/providers/claude/` owns runtime, prompt encoding, stream transforms, history hydration, CLI resolution, and auxiliary services. Claude-only workspace services (commands, skills, agents, plugins, MCP) are explicit in `src/providers/claude/app/`. `ClaudeCommandCatalog` wraps Claude storage + runtime SDK commands behind the shared catalog contract.
- Codex adaptor: `src/providers/codex/` owns runtime (`codex app-server` over stdio JSON-RPC), prompt encoding, history reload (JSONL parsing), settings reconciliation, and no-op auxiliary services. `CodexSkillStorage` scans `.codex/skills` and `.agents/skills` (vault + home). `CodexSkillCatalog` provides scan-backed command discovery without runtime dependency. Runtime uses `CodexAppServerProcess` (process wrapper), `CodexRpcTransport` (JSON-RPC correlation), `CodexNotificationRouter` (stream chunk mapping), and `CodexServerRequestRouter` (approval/ask-user handling). Provider state: `threadId` and `sessionFilePath` in `providerState`.
- `Conversation` carries `providerId` and opaque `providerState`. Claude-specific session fields are behind `ClaudeProviderState`. Codex-specific state is behind `CodexProviderState`. `StreamChunk` and `UsageInfo` are documented for provider-specific vs required variants; cache token fields are optional (Claude-specific).
- Planning docs:
  - Target architecture: [`docs/multi-provider-architecture-plan.md`](docs/multi-provider-architecture-plan.md)
  - Execution plan: [`docs/multi-provider-execution-plan.md`](docs/multi-provider-execution-plan.md)

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
| **core** | Provider-neutral contracts and infrastructure | See [`src/core/CLAUDE.md`](src/core/CLAUDE.md) |
| **core/bootstrap** | Shared app defaults and storage | `DEFAULT_CLAUDIAN_SETTINGS`, `SharedAppStorage` |
| **providers/claude** | Claude SDK adaptor | `ClaudeChatRuntime`, `ClaudeQueryOptionsBuilder`, `ClaudeSessionManager`, `ClaudeMessageChannel`, `ClaudeCliResolver`, `ClaudeHistoryStore`, `ClaudeTurnEncoder`, `transformClaudeMessage`, `ClaudeCommandCatalog`, aux services |
| **providers/claude/app** | Claude-only workspace services | CLI resolver, plugin/agent managers, command/skill/MCP storage |
| **providers/codex** | Codex app-server adaptor | `CodexChatRuntime`, `CodexAppServerProcess`, `CodexRpcTransport`, `CodexNotificationRouter`, `CodexServerRequestRouter`, `CodexSessionManager`, `CodexHistoryStore`, `encodeCodexTurn`, `CodexSkillCatalog`, `CodexSkillStorage`, aux stubs |
| **features/chat** | Main sidebar interface | See [`src/features/chat/CLAUDE.md`](src/features/chat/CLAUDE.md) |
| **features/inline-edit** | Inline edit modal | `InlineEditModal`, read-only tools |
| **features/settings** | Settings tab | UI components for all settings |
| **shared** | Reusable UI | Dropdowns, instruction modal, fork target modal, @-mention, icons |
| **i18n** | Internationalization | 10 locales |
| **utils** | Utility functions | date, path, env, editor, session, markdown, diff, context, frontmatter, slashCommand, mcp, externalContext, externalContextScanner, fileLink, imageEmbed, inlineEdit |
| **style** | Modular CSS | See [`src/style/CLAUDE.md`](src/style/CLAUDE.md) |
| **docs** | Architecture and execution plans | Multi-provider target and phased implementation plan |

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
| `.claude/claudian-settings.json` | Claudian-specific settings (model, UI, etc.) |
| `.claude/settings.local.json` | Local overrides (gitignored) |
| `.claude/mcp.json` | MCP server configs |
| `.claude/commands/*.md` | Slash commands (YAML frontmatter) |
| `.claude/agents/*.md` | Custom agents (YAML frontmatter) |
| `.claude/skills/*/SKILL.md` | Skill definitions |
| `.claude/sessions/*.meta.json` | Session metadata |
| `~/.claude/projects/{vault}/*.jsonl` | SDK-native session messages |

## Development Notes

- **SDK-first**: Proactively use native Claude SDK features over custom implementations. If the SDK provides a capability, use it — do not reinvent it. This ensures compatibility with Claude Code.
- **SDK exploration**: When developing SDK-related features, write a throwaway test script (e.g., in `dev/`) that calls the real SDK to observe actual response shapes, event sequences, and edge cases. Real output lands in `~/.claude/` or `{vault}/.claude/` — inspect those files to understand patterns and formats. Run this before writing implementation or tests — real output beats guessing at types and formats. This is the default first step for any SDK integration work.
- **Comments**: Only comment WHY, not WHAT. No JSDoc that restates the function name (`/** Get servers. */` on `getServers()`), no narrating inline comments (`// Create the channel` before `new Channel()`), no module-level docs on barrel `index.ts` files. Keep JSDoc only when it adds non-obvious context (edge cases, constraints, surprising behavior).
- **Provider refactor rule**: For the provider-runtime extraction, preserve the current conversation schema and replay model in PR1. First move Claude-specific knowledge behind the boundary; only then decide whether any schema cleanup is justified.
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
