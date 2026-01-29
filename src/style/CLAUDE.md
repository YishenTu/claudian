# CSS Style Guide

## Structure

```
src/style/
├── base/           # container, animations (@keyframes), variables
├── components/     # header, history, messages, code, thinking, toolcalls, status-panel, subagent, input, context-footer, tabs, scroll-to-bottom
├── toolbar/        # model-selector, thinking-selector, permission-toggle, external-context, mcp-selector
├── features/       # file-context, image-context, image-modal, inline-edit, diff, slash-commands, file-link, image-embed
├── modals/         # approval, instruction, mcp-modal
├── settings/       # base (shared .claudian-sp-* panel layout), env-snippets, slash-settings, mcp-settings, plugin-settings, agent-settings
├── accessibility.css
└── index.css       # Build order (@import list)
```

## Build

CSS is built into root `styles.css` via `npm run build:css` (also runs in `npm run dev`).

**Adding new modules**: Register in `index.css` via `@import` or the build will omit them.

## Conventions

- **Prefix**: All classes use `.claudian-` prefix
- **BEM-lite**: `.claudian-{block}`, `.claudian-{block}-{element}`, `.claudian-{block}--{modifier}`
- **No `!important`**: Avoid unless overriding Obsidian defaults
- **CSS variables**: Use Obsidian's `--background-*`, `--text-*`, `--interactive-*` tokens

## Naming Patterns

| Pattern | Examples |
|---------|----------|
| Layout | `-container`, `-header`, `-messages`, `-input` |
| Messages | `-message`, `-message-user`, `-message-assistant` |
| Tool calls | `-tool-call`, `-tool-header`, `-tool-content`, `-tool-status` |
| Thinking | `-thinking-block`, `-thinking-header`, `-thinking-content` |
| Panels | `-todo-list`, `-todo-item`, `-subagent-list`, `-subagent-header` |
| Context | `-file-chip`, `-image-chip`, `-mention-dropdown` |
| Modals | `-approval-modal`, `-instruction-modal`, `-mcp-modal` |

## Gotchas

- Obsidian uses `body.theme-dark` / `body.theme-light` for theme detection
- Modal z-index must be > 1000 to overlay Obsidian UI
- Use `var(--font-monospace)` for code blocks, not hardcoded fonts
