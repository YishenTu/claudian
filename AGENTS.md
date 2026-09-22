# AGENTS.md

## Loading and verification

- Read ancestor guides and any nested guide governing the files you change. Tests also use their source owner's guides; they do not inherit `src/` instructions automatically.
- Build, dependency, lockfile, locale/static-asset import, and `esbuild.config.mjs` changes also require `scripts/AGENTS.md`. Composition changes require the guides of the services being wired.
- Use the Node version in `.node-version`. For code changes, the full verification command is:

```bash
npm run typecheck && npm run lint && npm run test && npm run build && npm run check:performance
```

- For focused changes, `npm run test:affected -- --base origin/main` selects related tests and applicable LAN compatibility checks; it does not replace typecheck, lint, build, or performance checks. Documentation-only changes need relevant documentation checks, not a production build.
- Dev and production builds load `.env.local` and may copy artifacts into the configured `OBSIDIAN_VAULT`, including removal of its old `.codex-vendor`. Check that destination before building; clearing the shell variable does not prevent reloading it from the file.

## Architectural constraints

- `src/main.ts` is the sole concrete composition root and lifecycle publisher. App subcomposition returns complete domains, never a second root or service locator.
- App repositories/settings/storage depend on core contracts, not feature orchestration or provider-native protocols. Concrete provider imports are confined to composition and provider-default assembly.
- Features use `FeatureHost` and core registries, never concrete app/provider implementations. Providers use `ProviderHost`, never feature orchestration. Core imports none of these implementations.
- Existing Claude compatibility re-exports into app settings/storage are exceptions, not precedent. Do not extend them; move shared contracts to core when materially changing those seams.
- Shared ACP code contains protocol mechanics and protocol-level normalization only; provider launch policy, extensions, provider-specific normalization, and history stay provider-owned.
- `@claudian-collab/protocol` is an exact registry dependency owned by its standalone repository. Import only its package root; do not vendor its source, add source aliases/core re-exports, or copy package-owned registries or compatibility policy. Claudian's LAN compatibility policy remains local.

## Provider policy

- Do not assume provider parity. Check the owning capabilities, registration, and UI config before sharing behavior; use `ProviderRegistry` and `ProviderWorkspaceRegistry`.
- App/features may store opaque provider state but may not interpret native session/checkpoint fields. Providers normalize native payloads at the core boundary.
- Live output and history replay remain separate. Application metadata changes never edit or delete native history files; explicit native session operations belong to providers.
- Persisted provider settings require runtime decoding; invalid permission/tool/sandbox modes fail closed. Writers merge provider-owned configuration.
- Chat offers only explicitly enabled models from enabled providers; an empty model selection stays empty. No synthetic entry, hidden session model, or default fallback may bypass provider or model enablement.
- Runtime-discovered commands are read-only. Auxiliary queries own processes/sessions independently from chat.

## Local conventions

- Use English for code/comments/identifiers/commits/code blocks. Soft-wrap Markdown. Put uncommitted notes, traces, and throwaway scripts in `.context/`. No production `console.*`.
- TypeScript files use PascalCase for their main concept, camelCase for utility bags, and kebab-case for external package names. Preserve `index.ts` barrels, `types.ts` buckets, and source-mirrored test names; this does not require creating new barrels or type buckets. No interface `I` prefix; treat acronyms as words except external SDK types. Folders use kebab-case; imports omit `.ts` and prefer `@/`.
- UI actions use native controls. Buttons that do not submit a form declare `type="button"`; non-native controls need equivalent accessible names, roles, and keyboard behavior.

## Regression verification

- For behavior changes, demonstrate the intended failing regression before implementation and rerun it afterward. Documentation/mechanical changes are exempt; when automation is infeasible, record a repeatable reproduction and verify the nearest stable contract.
- Do not weaken tests to hide failures. Correct an expectation when the requested behavior or independent contract evidence justifies it; explain that evidence. Ask only when intended behavior remains ambiguous.
- Report the checks actually run and any remaining verification gaps.

## Instruction maintenance

- Keep non-obvious constraints at their narrowest common scope, with one authoritative home and explicit exceptions. Remove implementation inventories, generic advice, inherited duplicates, and retired decisions.
- Each guide has a sibling `CLAUDE.md` containing only `@AGENTS.md`.
