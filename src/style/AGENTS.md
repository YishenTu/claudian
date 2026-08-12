# CSS Style Guide

`src/style/` contains modular CSS that builds into root `styles.css`.

## Structure

| Area | Owns |
| --- | --- |
| `base/` | Variables, container primitives, animations, and global visibility behavior |
| `components/` | Reusable chat surfaces such as messages, input, tabs, navigation, history/session management, status, context, citations, and tool output |
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
- Use Obsidian CSS variables such as `--background-*`, `--text-*`, and `--interactive-*`.
- Use `var(--font-monospace)` for code blocks.

## Specific Element Rules

Every Claudian-owned instance of an element listed below must use its required base pattern. A departure is allowed only through an explicit semantic or surface modifier; selector order, nesting, and inherited Obsidian styles are not exceptions.

### Buttons

- All buttons use `border: 0`, `background: transparent`, `box-shadow: none`, and `color: var(--text-muted)` at rest.
- Hover and `focus-visible` use `color: var(--text-normal)` while retaining no border, transparent background, and no box shadow. Filled hover or focus surfaces require an explicit modifier.
- Disabled buttons use `color: var(--text-faint)` and `cursor: default`, and must not retain hover, focus, or active emphasis.
- Button SVGs inherit `currentColor`; their width and height are declared by the button's base selector. Different icon sizing requires an explicit modifier.
- Apply the complete base pattern to the Claudian button class and its hover, focus, active, and disabled selectors so Obsidian cannot restore native button chrome in any state.

### Inputs and Textareas

- All standalone inputs and textareas use `min-width: 0`, `border: 1px solid var(--background-modifier-border)`, `background: var(--background-modifier-form-field)`, `box-shadow: none`, `color: var(--text-normal)`, and the inherited UI font.
- Hover retains the base border, background, and box shadow. Focus uses `outline: none` and `border-color: var(--interactive-accent)` without introducing a browser or Obsidian box shadow.
- Placeholders use `color: var(--text-muted)`. Disabled controls use `color: var(--text-faint)` and `cursor: default`.
- An input or textarea embedded in a wrapper uses `border: 0`, `background: transparent`, and `box-shadow: none` in every interaction state; the wrapper alone owns the border, background, radius, and focus treatment.
- Textareas use `resize: none` and `overflow-y: auto` by default. A resizable textarea requires an explicit modifier and bounded sizing.
- Error, warning, read-only, and semantic-mode treatments require explicit modifiers or scoped custom properties; they must override every affected interaction state.

## Gotchas

- Obsidian uses `body.theme-dark` and `body.theme-light` for theme detection.
- Modal z-index must be greater than `1000` to overlay Obsidian UI.
- Keep persistent session-manager layout rules scoped under `.claudian-session-sidebar` or `.claudian-wide-session-layout`. The single-panel history menu shares item primitives but must retain its own sizing, tab-state labels, and actions.
- Session-manager pinned and session lists are independent scroll owners. Preserve `min-height: 0` through their flex ancestors so sticky headers and bounded sections do not clip or overlap content.
