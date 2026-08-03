# AGENTS.md

## Project

Claudian is an Obsidian plugin that embeds provider-backed coding agents in a sidebar and inline-edit flow. Claude is the default provider. Codex, Grok, OpenCode, and Pi are optional providers that plug into the same conversation model through `Conversation.providerId` and opaque provider-owned `providerState`.

Do not assume provider parity. Check each provider's `capabilities.ts`, `registration.ts`, and UI config before wiring shared behavior.

## Instruction Map

- This file is the canonical cross-agent guide. Keep shared instructions here.
- `CLAUDE.md` files should import the nearest `AGENTS.md`; do not duplicate shared guidance there.
- Before editing a scoped area, read its nearest scoped guide:
  - `src/app/AGENTS.md`
  - `src/core/AGENTS.md`
  - `src/features/chat/AGENTS.md`
  - `src/providers/claude/AGENTS.md`
  - `src/providers/codex/AGENTS.md`
  - `src/providers/grok/AGENTS.md`
  - `src/providers/opencode/AGENTS.md`
  - `src/providers/pi/AGENTS.md`
  - `src/style/AGENTS.md`

## Commands

```bash
npm run dev
npm run build
npm run typecheck
npm run lint
npm run lint:fix
npm run test
npm run test:watch
npm run test:coverage
```

Use focused commands while iterating. Before handing off code changes, run the narrowest meaningful verification plus broader checks when the change touches shared behavior. The default full check is:

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

Tests mirror `src/` under `tests/unit/` and `tests/integration/`.

## Architecture

This table is a location map. It describes responsibility, not exclusive mutation authority. Scoped guides name the source of truth and allowed mutators for state in their area.

| Area | Responsibility |
| --- | --- |
| `src/main.ts` | Plugin lifecycle and concrete application composition |
| `src/app/` | Application conversation, settings, provider-host, and storage services |
| `src/core/` | Provider-neutral runtime, registry, storage, tool, and type contracts |
| `src/providers/acp/` | Shared ACP transport, interaction, and session primitives without provider policy |
| `src/providers/*/` | Provider adaptors, provider-owned runtime protocol, history, storage, settings, and UI |
| `src/features/chat/` | Sidebar chat orchestration against provider-neutral contracts |
| `src/features/inline-edit/` | Inline edit modal and provider-backed edit services |
| `src/features/settings/` | Shared settings shell and provider tab assembly |
| `src/shared/` | Reusable UI components |
| `src/style/` | Modular CSS built into `styles.css` |

### Dependency Direction

In the rules below, `A -> B` means `A` may import or call `B`:

```text
composition root (`src/main.ts`) -> app services + features + provider registrations + core
app services -> core contracts
features -> FeatureHost + core contracts + shared UI
providers -> ProviderHost + core contracts + shared provider primitives
```

- `core/` must not import feature code, app composition, or provider implementations.
- Feature code must not import provider implementations. Resolve provider behavior through core registries and contracts.
- Provider runtime and protocol code must not import chat views, feature controllers, or other feature orchestration.
- Existing Claude compatibility re-exports that point into `src/app/` are migration seams, not an allowed general dependency direction. Do not add new provider-to-app imports; move shared contracts into `core/` when touching those seams materially.
- `src/providers/acp/` may contain protocol primitives shared by ACP providers. Provider-specific launch policy, extensions, normalization, history, and state remain in the owning provider.
- If a dependency does not fit these directions, introduce or extend an explicit contract at the owning boundary instead of reaching across layers.

### Cross-Layer Ownership

- `src/main.ts` owns plugin lifecycle and wiring; it does not become the home for feature or provider behavior.
- `src/app/` owns application-scoped repositories, settings transactions, host adapters, and persistence coordination. See its scoped guide for exact state authority.
- `src/features/*/` owns user-facing orchestration and presentation state, not provider-native processes or storage formats.
- `src/providers/*/` owns native protocol, process, session, transcript, settings, and provider-state interpretation.
- `src/core/` owns provider-neutral contracts and shared lifecycle mechanisms, not concrete provider behavior.

Provider-specific session fields belong behind typed helpers in the owning provider directory. Provider-native transcripts are read-only inputs; Claudian state changes must never rewrite or delete them.

## Provider Rules

- Prefer provider-native behavior over local reimplementation. Adapt provider output at the boundary instead of shadowing provider features.
- Keep live streaming and history replay responsibilities separate. Live output should come from the provider runtime protocol when available; provider transcript files are the replay source.
- New provider behavior must be expressed through registries and capabilities: `ProviderRegistry`, `ProviderWorkspaceRegistry`, `ProviderChatUIConfig`, provider capabilities, and provider-owned settings reconciliation.
- Model, permission, plan-mode, command, MCP, skill, and subagent behavior is provider-specific unless the core contract explicitly makes it shared.
- When provider behavior is uncertain, inspect real runtime output first. Put throwaway scripts, traces, and handoff notes in `.context/`.
- Treat provider-native history and transcripts as read-only. Never mutate or delete provider session data when a Claudian conversation changes.
- Only explicitly enabled models belong in the chat selector: no synthetic provider entries, no hidden session models, and no provider-default fallback when none are enabled.
- Runtime-discovered commands are read-only in Claudian; providers own their editing and deletion.
- Auxiliary query runners own their own process and session, independent from the chat runtime.

## Development Rules

- Use `rg` or `rg --files` for repo searches.
- Write code, comments, identifiers, commit messages, and code blocks in English.
- Keep comments sparse. Explain non-obvious intent, protocol constraints, or invariants; do not narrate obvious code.
- Do not use `console.*` in production code.
- Preserve user data and provider-native files. Settings writers should merge with existing provider-owned data instead of clobbering it.
- Put non-committed notes, handoff files, traces, and throwaway scripts in `.context/`.
- Do not add new production dependencies without a clear need and an explicit tradeoff.

## TDD Workflow

- For new behavior or bug fixes, write or update the failing test first in the mirrored `tests/` path.
- Make the narrowest implementation change that passes the focused test.
- Refactor after the test is green, preserving the provider and feature ownership boundaries above.
- If a change cannot be tested directly, document why and cover the closest stable contract instead.

## Project structure

- Organize code by clear domain responsibility rather than accumulating related files in flat directories.
- Keep each feature's public entry point small and obvious; place its contracts, state, orchestration, adapters, persistence, and implementation in focused subfolders when the feature warrants them.
- Use meaningful ownership-based folder names. Do not create catch-all `utils`, `common`, or miscellaneous folders.
- Mirror the relevant production structure in tests so ownership and coverage remain easy to find.
- Avoid both flat dumping grounds and unnecessary nesting. Before a material reorganization, propose the target tree and explain each group's responsibility.
- Preserve project tooling, build configuration, imports, and test discovery when moving files, and verify the affected build and tests afterward.

## Naming Conventions

- **Symbols**: `PascalCase` for classes, interfaces, types, enums, and enum members; `camelCase` for variables, functions, and properties; `SCREAMING_SNAKE_CASE` for module-level constants and values in enum-like const objects. No `I` prefix on interfaces. Treat acronyms as words (`SdkSessionReadResult`), except in types mirroring an external SDK (`SDKMessage`).
- **Files**: name the file after its primary exported concept in `PascalCase.ts`; use `camelCase.ts` only for utility bags with no dominant export (when in doubt, `PascalCase`). Use `kebab-case.ts` only to mirror an external package name (`tests/__mocks__/claude-agent-sdk.ts`). Barrels stay `index.ts`, type buckets stay `types.ts`, tests mirror the source name plus `.test.ts` (qualifiers allowed: `fileLink.dom.test.ts`).
- **Folders**: `kebab-case`.
- **Imports**: no `.ts` extensions; prefer `@/` aliases over deep relative paths.

## Review Expectations

- Findings first: correctness, regression risk, API or contract ambiguity, and missing tests.
- Treat maintainability issues as real findings when they increase future change cost or failure risk.
- Call out duplicated logic, unclear ownership, and tight coupling with a concrete refactoring direction.
- For architecture changes, ask whether the change reverses an allowed dependency, mutates state outside its owner, leaks a provider detail, or persists state with the wrong lifetime.
