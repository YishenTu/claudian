# CSS Style Guide

`src/style/` contains modular CSS that builds into root `styles.css`.

## Structure

```text
src/style/
├── base/           # container, animations, variables
├── components/     # header, history, messages, code, thinking, toolcalls, status-panel, input, tabs
├── toolbar/        # model selector, thinking selector, permission toggles, external context, MCP selector
├── features/       # file/image context, inline edit, diff, commands, plan mode, ask-user, resume session
├── modals/         # instruction, MCP, fork target
├── settings/       # shared settings panels and provider settings modules
├── accessibility.css
└── index.css       # build order
```

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
