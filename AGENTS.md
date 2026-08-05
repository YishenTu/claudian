# AGENTS.md

## Project

Claudian is an Obsidian plugin that embeds provider-backed coding agents in a sidebar and inline-edit flow. Claude is the default provider. Codex, Grok, OpenCode, and Pi are optional providers that plug into the same conversation model through `Conversation.providerId` and opaque provider-owned `providerState`.

Do not assume provider parity. Check each provider's `capabilities.ts`, `registration.ts`, and UI config before wiring shared behavior.

## Scope Guides

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

## AGENTS.md Maintenance

- AGENTS.md is execution context for agents, not general documentation. Keep only repository- or scope-specific information that a capable agent would not reliably know; every statement must change implementation, review, or verification behavior.
- Keep repository-wide rules here; put local ownership, dependencies, invariants, failure modes, verification, and active decisions in the narrowest scoped guide that governs them.
- Do not duplicate inherited guidance or silently contradict it. State a necessary local exception and its rationale explicitly.
- Omit tours, ordinary implementation details, temporary status, and general engineering advice.
- Record a decision only when it is active, surprising from the code, expensive to reverse, and reflects a real tradeoff. State the decision, rationale, and any concrete reconsideration condition; use Git history as the archive.
- `CLAUDE.md` files should import the nearest `AGENTS.md`; do not duplicate shared guidance there.

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

The default full check is:

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

Tests mirror `src/` under `tests/unit/` and `tests/integration/`.

## Architecture

Scoped guides define the source of truth and allowed mutators for state in their area.

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
providers -> ProviderHost + core contracts + shared provider and UI primitives
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

Provider-specific session fields belong behind typed helpers in the owning provider directory.

## Naming Conventions

- **Symbols**: no `I` prefix on interfaces. Treat acronyms as words (`SdkSessionReadResult`), except in types mirroring an external SDK (`SDKMessage`).
- **Files**: name the file after its primary exported concept in `PascalCase.ts`; use `camelCase.ts` only for utility bags with no dominant export (when in doubt, `PascalCase`). Use `kebab-case.ts` only to mirror an external package name (`tests/__mocks__/claude-agent-sdk.ts`). Barrels stay `index.ts`, type buckets stay `types.ts`, tests mirror the source name plus `.test.ts` (qualifiers allowed: `fileLink.dom.test.ts`).
- **Folders**: `kebab-case`.
- **Imports**: no `.ts` extensions; prefer `@/` aliases over deep relative paths.

## Development Rules

- Write code, comments, identifiers, commit messages, and code blocks in English.
- Do not use `console.*` in production code.
- Settings writers must merge rather than replace provider-owned configuration.
- Put non-committed notes, handoff files, traces, and throwaway scripts in `.context/`.

## TDD Workflow

- For new behavior or bug fixes, work one observable slice at a time: add or update the failing test in the mirrored `tests/` path, make it pass, then refactor.
- Test through the closest stable owner or public interface; do not expose or test private methods only for convenience.
- Mock environment and provider boundaries. Prefer real Claudian code, fixtures, or lightweight fakes for Claudian-owned collaborators.
- For shared provider contracts, test provider-neutral behavior first, then cover each provider adapter's distinct behavior separately.
- If a change cannot be tested directly, document why and cover the closest stable contract instead.

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

## Review Checks

Reviews must enforce the dependency, ownership, provider-boundary, and state-lifetime constraints above.
