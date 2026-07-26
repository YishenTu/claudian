# AGENTS.md

## Project

Claudian is an Obsidian plugin (desktop only, Obsidian v1.7.2+) that embeds provider-backed coding agents in a sidebar chat and an inline-edit flow. The vault becomes the agent's working directory, so file reads/writes, search, bash commands, and multi-step workflows run against the user's notes.

Claude is the default provider. Codex, Grok, Kimi, OpenCode, and Pi are optional providers that plug into the same conversation model through `Conversation.providerId` and opaque provider-owned `providerState`. Each provider adapts a different protocol:

- **Claude** — `@anthropic-ai/claude-agent-sdk` with Claude Code CLI compatibility
- **Codex** — OpenAI Codex via `codex app-server` over stdio JSON-RPC 2.0
- **Grok** — Grok Build via Agent Client Protocol (ACP) over a `grok agent --no-leader stdio` subprocess
- **Kimi** — ACP over a `kimi acp` subprocess
- **OpenCode** — ACP over an `opencode acp` subprocess
- **Pi** — RPC over a `pi --mode rpc` subprocess

Shared ACP transport primitives live in `src/providers/acp/`; provider-specific protocol behavior stays in the owning provider directory.

Do not assume provider parity. Check each provider's `capabilities.ts`, `registration.ts`, and UI config before wiring shared behavior.

The repository is TypeScript bundled with esbuild into a single `main.js` (CJS, `es2018` target). `src/main.ts` is the entry point. Node 24 is required (`.node-version`: 24.16.0, `engines: >=24 <25`).

## Instruction Map

- This file is the canonical cross-agent guide. Keep shared instructions here.
- `CLAUDE.md` files should import the nearest `AGENTS.md`; do not duplicate shared guidance there.
- Before editing a scoped area, read its nearest scoped guide:
  - `src/core/AGENTS.md`
  - `src/features/chat/AGENTS.md`
  - `src/providers/claude/AGENTS.md`
  - `src/providers/codex/AGENTS.md`
  - `src/providers/grok/AGENTS.md`
  - `src/providers/kimi/AGENTS.md`
  - `src/providers/opencode/AGENTS.md`
  - `src/providers/pi/AGENTS.md`
  - `src/style/AGENTS.md`

## Commands

```bash
npm run dev                # CSS build + esbuild watch mode
npm run build              # CSS build + esbuild production (minified, no sourcemap)
npm run build:css          # build src/style/ modules into root styles.css
npm run typecheck          # tsc --noEmit
npm run lint               # eslint over src/ and tests/
npm run lint:fix
npm run test               # jest (unit + integration) + node --test script checks
npm run test:unit          # jest only
npm run test:architecture  # node --test architecture boundary checks only
npm run test:watch
npm run test:coverage
npm run check:performance  # startup performance budget check against built bundle
```

Use focused commands while iterating. Before handing off code changes, run the narrowest meaningful verification plus broader checks when the change touches shared behavior. The default full check is:

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

`npm run test` runs Jest (two projects: `tests/unit/` and `tests/integration/`, both under `tsconfig.jest.json`) and then `node --test` for `scripts/check-architecture-boundaries.test.mjs`, `scripts/check-eslint-config.test.mjs`, and `scripts/check-release-version.test.mjs`.

Jest path aliases: `@/*` -> `src/*`, `@test/*` -> `tests/*`. The `obsidian` and `@anthropic-ai/claude-agent-sdk` modules are mocked under `tests/__mocks__/`.

Setting `OBSIDIAN_VAULT` in `.env.local` (created by the postinstall script from `.env.local.example`) makes the build copy `main.js`, `manifest.json`, and `styles.css` into that vault's `.obsidian/plugins/claudian/` folder.

## Architecture

| Area | Ownership |
| --- | --- |
| `src/app/` | Shared settings defaults and plugin-level storage helpers |
| `src/core/` | Provider-neutral runtime, registry, storage, tool, and type contracts |
| `src/providers/*/` | Provider adaptors, provider-owned runtime protocol, history, storage, settings, and UI |
| `src/providers/acp/` | Shared ACP transport and normalization primitives used by ACP-based providers |
| `src/features/chat/` | Sidebar chat orchestration against provider-neutral contracts |
| `src/features/inline-edit/` | Inline edit modal and provider-backed edit services |
| `src/features/settings/` | Shared settings shell and provider tab assembly |
| `src/shared/` | Reusable UI components |
| `src/i18n/` | Localization strings and locale plumbing |
| `src/utils/` | Provider-neutral utility helpers |
| `src/style/` | Modular CSS built into `styles.css` |

The feature layer depends on `core/` contracts, not provider internals. Provider-specific session fields belong behind typed helpers in the owning provider directory. `core/` must never import provider implementation files — if shared behavior needs provider data, add an explicit contract and have providers implement it.

Key runtime flow: features call `ProviderRegistry.createChatRuntime()`, then `ChatRuntime.prepareTurn()` and `ChatRuntime.query()`, consuming provider-neutral `StreamChunk` values. Workspace services (command catalogs, agent mentions, CLI resolution, settings tabs) resolve through `ProviderWorkspaceRegistry`.

## Provider Rules

- Prefer provider-native behavior over local reimplementation. Adapt provider output at the boundary instead of shadowing provider features.
- Keep live streaming and history replay responsibilities separate. Live output should come from the provider runtime protocol when available; provider transcript files are the replay source. Never mutate provider-native history from Claudian.
- New provider behavior must be expressed through registries and capabilities: `ProviderRegistry`, `ProviderWorkspaceRegistry`, `ProviderChatUIConfig`, provider capabilities, and provider-owned settings reconciliation.
- Model, permission, plan-mode, command, MCP, skill, and subagent behavior is provider-specific unless the core contract explicitly makes it shared.
- `Conversation.providerState` is opaque to feature code. Provider-specific fields belong behind typed provider helpers in the owning provider directory.
- When provider behavior is uncertain, inspect real runtime output first. Put throwaway scripts, traces, and handoff notes in `.context/`.
- Shared skill management for Codex, Grok, Kimi, Pi, and OpenCode owns only `.agents/skills`; composer discovery remains exclusively provider-protocol-driven. Claude stays on `.claude/skills` and `.claude/commands`, and legacy provider roots are never migrated automatically.

## Storage

| Path | Contents |
| --- | --- |
| `.claudian/claudian-settings.json` | Shared Claudian settings and provider-specific configuration |
| `.claudian/sessions/*.meta.json` | Provider-neutral session metadata |
| `.claude/settings.json` | Claude Code-compatible project settings, permissions, and plugin overrides |
| `.claude/mcp.json` | Claudian-managed MCP servers for Claude |
| `.claude/commands/**/*.md` | Claude slash commands |
| `.claude/skills/*/SKILL.md` | Claude skills |
| `.claude/agents/*.md` | Claude vault agents |
| `.agents/skills/*/SKILL.md` | Claudian-managed shared vault skills for Codex, Grok, Kimi, Pi, and OpenCode |
| `.codex/skills/*/SKILL.md` | Legacy/provider-native Codex skills; never managed or migrated by Claudian |
| `.codex/agents/*.toml` | Codex vault subagent definitions |
| `.kimi-code/agents/*.md` | Kimi vault agent definitions (managed by Claudian's Kimi agent settings) |
| `.agents/agents/*.md` | Kimi generic vault agent definitions (read-only from Claudian; surfaced for @-mentions) |
| `.kimi-code/mcp.json` | Claudian-managed MCP servers for Kimi (merged with hand-written entries; read natively by the kimi CLI) |
| `.opencode/agent`, `.opencode/agents` | OpenCode agent definitions |
| `.pi/agent/sessions/` | Pi vault-local sessions |
| `~/.claude/projects/{vault}/*.jsonl` | Claude-native transcripts |
| `~/.codex/sessions/**/*.jsonl` | Codex-native transcripts |
| `~/.grok/sessions/` | Grok-native sessions (read-only from Claudian) |
| `~/.kimi-code/sessions/<wd_slug_hash>/session_<uuid>/` | Kimi-native sessions (read-only from Claudian; `KIMI_CODE_HOME` relocates the root) |
| `~/.kimi-code/config.toml`, `~/.kimi-code/mcp.json` | Kimi-owned user-level config and MCP servers; never written by Claudian |
| `~/.pi/agent/sessions/` | Pi user-level sessions |

## Code Style

- Write code, comments, identifiers, commit messages, and code blocks in English.
- Keep comments sparse. Explain non-obvious intent, protocol constraints, or invariants; do not narrate obvious code.
- Do not use `console.*` in production code.
- Imports are auto-sorted by `simple-import-sort` (enforced as an ESLint error) and type imports must use `import type` (`@typescript-eslint/consistent-type-imports`).
- Type-aware rules are enforced on `src/`: no misused promises, no unsafe assignments/returns/arguments, no unnecessary type assertions, no unbound methods, and `obsidianmd/prefer-create-el`.
- Obsidian plugin review conventions are enforced through `eslint-plugin-obsidianmd` rules (sentence-case UI text, platform guards, no hardcoded config paths, etc.).
- Service and shared modules must not import UI modules or the view (`no-restricted-imports` on the legacy service paths in `eslint.config.mjs`).
- CSS conventions (`.claudian-` prefix, BEM-lite naming, Obsidian CSS variables, module registration in `index.css`) are documented in `src/style/AGENTS.md`.

## Testing

- Tests mirror `src/` under `tests/unit/` and `tests/integration/`.
- For new behavior or bug fixes, write or update the failing test first in the mirrored `tests/` path.
- Make the narrowest implementation change that passes the focused test.
- Refactor after the test is green, preserving the provider and feature ownership boundaries above.
- If a change cannot be tested directly, document why and cover the closest stable contract instead.
- Architecture boundary and release-version checks live as `node --test` files in `scripts/` and run as part of `npm run test`.
- CI (`.github/workflows/ci.yml`) runs lint, typecheck, test, and build plus `check:performance` on every push and PR to `main`.

## Security Considerations

- Preserve user data and provider-native files. Settings writers should merge with existing provider-owned data instead of clobbering it (e.g., `.claude/settings.json`, `.claude/mcp.json`).
- Do not read or write provider credential stores, and do not persist provider secrets in Claudian settings or caches.
- Never commit secrets; `.env.local` holds only the local `OBSIDIAN_VAULT` development path and stays untracked.
- Put non-committed notes, handoff files, traces, and throwaway scripts in `.context/`.
- Do not add new production dependencies without a clear need and an explicit tradeoff.
- Permission and approval helpers live in `src/core/security/`; provider approval gates go through the provider runtime protocol rather than feature-layer reimplementation.

## Release Process

- Releases are tag-driven: pushing a tag runs `.github/workflows/release.yml`, which validates the tag against `manifest.json` via `scripts/check-release-version.mjs`, builds, checks startup performance, generates artifact attestations, and publishes a GitHub Release with `main.js`, `manifest.json`, and `styles.css`.
- Bump versions with `npm version`; the `version` hook runs `scripts/sync-version.js` to sync `manifest.json` and stages it.
- `versions.json` maps plugin versions to minimum Obsidian app versions for community plugin compatibility.

## Review Expectations

- Findings first: correctness, regression risk, API or contract ambiguity, and missing tests.
- Treat maintainability issues as real findings when they increase future change cost or failure risk.
- Call out duplicated logic, unclear ownership, and tight coupling with a concrete refactoring direction.
