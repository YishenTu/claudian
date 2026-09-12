# Style constraints

- Root `styles.css` is generated. Register modules in `index.css`; source edits outside that inclusion set must not silently disappear from builds.
- Scope Obsidian overrides under Claudian containers. Shared selectors must not encode provider behavior; use explicit provider classes/attributes.
- Claudian classes use the `.claudian-` prefix with block/element/modifier names. Host selectors and generic state classes are exceptions.

## Control design

- Buttons rest borderless/transparent/shadowless with muted text. Hover/focus changes to normal text, disabled to faint/default cursor; filled surfaces require an explicit modifier. Apply the full treatment in every state so host styles cannot restore native chrome.
- Button icons inherit currentColor and get dimensions from the base button class; alternate sizing needs a modifier.
- Standalone inputs/textareas use the host form-field background, border variable, normal text, inherited font, and no shadow. Focus changes border to interactive accent without browser/host shadow.
- Embedded inputs stay transparent/borderless in every state; the wrapper alone owns surface/focus treatment. Textareas are non-resizable unless an explicit modifier supplies bounded resizing.
- Semantic/error/readonly overrides must cover every affected interaction state.

## Session layout

- Persistent session-manager styles stay under its dedicated containers; shared history item primitives must not impose persistent-sidebar sizing or actions on the compact menu.
- Pinned/session lists scroll independently. Preserve min-height: 0 through flex ancestors so bounded lists and sticky headers do not clip.
