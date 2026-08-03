# CSS Style Guide

`src/style/` contains modular CSS that builds into root `styles.css`.

## Structure

| Area | Owns |
| --- | --- |
| `base/` | Variables, container primitives, animations, and global visibility behavior |
| `components/` | Reusable chat surfaces such as messages, input, tabs, navigation, status, context, citations, and tool output |
| `toolbar/` | Composer and provider-option controls |
| `features/` | Styles coupled to a named feature workflow such as context, diff, inline edit, plan mode, or commands |
| `modals/` | Modal-specific layouts |
| `settings/` | Shared settings shell and provider settings modules |
| `accessibility.css` | Cross-feature accessibility adaptations |
| `index.css` | Complete module inclusion and deterministic build order |

Choose a folder by UI ownership, not by the screen where a selector happens to appear. Shared visual primitives belong in `components/`; behavior-specific selectors stay with their feature.

## Boundaries

- TypeScript owns semantic and lifecycle state. CSS may render classes and attributes but must not be treated as the source of truth for state transitions.
- Feature-specific styling must not leak provider behavior into shared selectors. Provider variants should use explicit provider classes or data attributes supplied by UI config.
- Keep Obsidian host-selector overrides narrow. Do not globally restyle host classes when a Claudian container can scope the rule.
- Root `styles.css` is generated output. Never edit it directly.

## Build Rules

- `npm run build:css` builds root `styles.css`.
- `npm run dev` and `npm run build` both invoke the CSS build.
- Every new module must be registered in `index.css`; otherwise the CSS build should fail.

## Conventions

- Claudian-owned classes use the `.claudian-` prefix.
- Shared Obsidian host selectors and generic state classes may remain unprefixed.
- Prefer BEM-lite names: `.claudian-{block}`, `.claudian-{block}-{element}`, `.claudian-{block}--{modifier}`.
- Avoid `!important` unless overriding Obsidian defaults.
- Use Obsidian CSS variables such as `--background-*`, `--text-*`, and `--interactive-*`.
- Use `var(--font-monospace)` for code blocks.

## Gotchas

- Obsidian uses `body.theme-dark` and `body.theme-light` for theme detection.
- Modal z-index must be greater than `1000` to overlay Obsidian UI.
- Keep fixed-format UI dimensions stable so dynamic labels, icons, loading text, and hover states do not shift layout.
