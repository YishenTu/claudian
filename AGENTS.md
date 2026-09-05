# AGENTS.md

## Loading and verification

- Read the full root-to-file instruction chain, including nested guides. Tests also use their source owner's guides; they do not inherit `src/` instructions automatically.
- Build, dependency, lockfile, locale/static-asset import, and `esbuild.config.mjs` changes also require `scripts/AGENTS.md`. Composition changes require the guides of the services being wired.
- Use `.node-version`. The default code check is:

```bash
npm run typecheck && npm run lint && npm run test && npm run build && npm run check:performance
```

- Dev and production builds load `.env.local` and may copy artifacts into the configured `OBSIDIAN_VAULT`, including removal of its old `.codex-vendor`. Check that destination before building; clearing the shell variable does not prevent reloading it from the file.

## Architectural constraints

- `src/main.ts` is the sole concrete composition root and lifecycle publisher. App subcomposition returns complete domains, never a second root or service locator.
- App repositories/settings/storage depend on core contracts, not feature orchestration or provider-native protocols. Concrete provider imports are confined to composition and provider-default assembly.
- Features use `FeatureHost` and core registries, never concrete app/provider implementations. Providers use `ProviderHost`, never feature orchestration. Core imports none of these implementations.
- Existing Claude compatibility re-exports into app settings/storage are exceptions, not precedent. Do not extend them; move shared contracts to core when materially changing those seams.
- Shared ACP code contains protocol mechanics only; provider launch policy, extensions, normalization, and history stay provider-owned.
- `@claudian-collab/protocol` is an exact registry dependency owned by its standalone repository. Import only its package root; retain no package source, source aliases, copied registries, compatibility policy, or core re-exports.

## Provider policy

- Do not assume provider parity. Check the owning capabilities, registration, and UI config before sharing behavior; use `ProviderRegistry` and `ProviderWorkspaceRegistry`.
- App/features may store opaque provider state but may not interpret native session/checkpoint fields. Providers normalize native payloads at the core boundary.
- Prefer native provider behavior. Inspect real runtime output when uncertain. Live output and history replay remain separate; conversation changes never mutate or delete native history.
- Persisted provider settings require runtime decoding; invalid permission/tool/sandbox modes fail closed. Writers merge provider-owned configuration.
- Chat offers only explicitly enabled models from enabled providers; an empty model selection stays empty. No synthetic entry, hidden session model, or default fallback may bypass provider or model enablement.
- Runtime-discovered commands are read-only. Auxiliary queries own processes/sessions independently from chat.

## Local conventions

- Use English for code/comments/identifiers/commits/code blocks. Soft-wrap Markdown. Put uncommitted notes, traces, and throwaway scripts in `.context/`. No production `console.*`.
- No interface `I` prefix. Treat acronyms as words except external SDK types.
- Files use PascalCase for their main concept, camelCase for utility bags, kebab-case only for external package names. Keep `index.ts` barrels, `types.ts` buckets, and source-mirrored test names. Folders use kebab-case; imports omit `.ts` and prefer `@/`.

## Required test workflow

- Behavior changes require a failing executable test before implementation. Documentation/mechanical changes are exempt; when automation is infeasible, record repeatable failure and test the nearest stable seam.
- Documented owners/public contracts are accepted seams. Resolve ownership before testing beyond them; no test-only public facade.
- Complete one observable behavior before refactoring or adding another. Derive expectations independently from specs, accepted fixtures, captured native examples, or worked examples; no mirrored algorithms, internal call-count assertions, or storage inspection behind undeclared seams.
- Mock only environment, Obsidian, and provider boundaries through narrow ports; keep owned modules real. Shared provider changes need neutral-contract coverage plus distinct native adapter behavior.
- Atomic UI actions use native controls with explicit non-submit button types. Non-native controls need justified semantics and complete name/role/keyboard coverage.
- Real-DOM tests use Testing Library role/name queries and outcome assertions, plus targeted jest-axe checks. MockElement class/tag checks do not substitute.

## Instruction maintenance

- Retain only scope-specific constraints an agent could plausibly miss. Remove code descriptions, inventories, generic advice, and repeated inherited rules.
- Put each constraint at its narrowest common scope. Explain necessary exceptions. Record only active, non-obvious, costly decisions with a real tradeoff; archive retired decisions in Git.
- Each guide has a sibling `CLAUDE.md` containing only `@AGENTS.md`.
