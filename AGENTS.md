# AGENTS.md

## Loading and verification

- Tests follow the guides of the source they cover; they do not inherit `src/` instructions automatically.
- Build, dependency, lockfile, locale/static-asset import, and `esbuild.config.mjs` changes also require `scripts/AGENTS.md`. Composition changes require the guides of the services being wired.
- Use the Node version in `.node-version`. For code changes, the full verification command is:

```bash
npm run typecheck && npm run lint && npm run test && npm run build && npm run check:performance
```

- For focused changes, `npm run test:affected -- --base origin/main` selects related tests; it does not replace typecheck, lint, build, or performance checks. Documentation-only changes need `git diff --check` (CI enforces it on every pull request) and their affected documentation tests, not a production build.
- Dev and production builds load `.env.local` and may copy artifacts into the configured `OBSIDIAN_VAULT`, including removal of its old `.codex-vendor`. Check that destination before building; clearing the shell variable does not prevent reloading it from the file.

## Architectural constraints

- `src/main.ts` is the sole concrete composition root and lifecycle publisher. App subcomposition returns complete domains, never a second root or service locator.
- `src/composition/` holds main-owned wiring that must reach both `app/` and `features/`. Only `main.ts` and other composition modules import it; it never imports `main.ts` or concrete providers, and `main.ts` still constructs, registers, and tears it down.
- App repositories/settings/storage depend on core contracts, not feature orchestration or provider-native protocols. Concrete provider imports are confined to `main.ts` and provider-default assembly.
- Features use `FeatureHost` and core registries, never concrete app/provider implementations. `FeatureHost` stays feature-neutral; chat-only capabilities belong in chat's `ChatFeatureHost` extension. Providers use `ProviderHost`, never feature orchestration. Core imports none of these implementations.
- Shared ACP code contains protocol mechanics and protocol-level normalization only; provider launch policy, extensions, provider-specific normalization, and history stay provider-owned.

## Local conventions

- Use English for code/comments/identifiers/commits/code blocks. Soft-wrap Markdown. Put uncommitted notes, traces, and throwaway scripts in `.context/`. No production `console.*`.
- TypeScript files use PascalCase for their main concept, camelCase for utility bags, and kebab-case for external package names. Preserve `index.ts` barrels, `types.ts` buckets, and source-mirrored test names; this does not require creating new barrels or type buckets. No interface `I` prefix. Preserve acronym capitals in filenames and matching owned identifiers (`ACPClientConnection`, `buildACPUsageInfo`, `URLs`); leading acronyms remain lowercase in camelCase (`acpConnection`). Preserve external API names and serialized keys. Folders use kebab-case; imports omit `.ts` and prefer `@/`.
- UI actions use native controls. Buttons that do not submit a form declare `type="button"`; non-native controls need equivalent accessible names, roles, and keyboard behavior.

## Regression verification

- For behavior changes, demonstrate the intended failing regression before implementation and rerun it afterward. Documentation/mechanical changes are exempt; when automation is infeasible, record a repeatable reproduction and verify the nearest stable contract.

## Instruction maintenance

- Keep non-obvious constraints at their narrowest common scope, with one authoritative home and explicit exceptions. Remove implementation inventories, generic advice, inherited duplicates, and retired decisions.
- Each guide has a sibling `CLAUDE.md` containing only `@AGENTS.md`.
