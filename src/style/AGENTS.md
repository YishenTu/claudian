# Style constraints

- Root `styles.css` is generated. Register modules in `index.css`; source edits outside that inclusion set must not silently disappear from builds.
- Scope Obsidian overrides under Claudian containers. Shared selectors must not encode provider behavior; use explicit provider classes/attributes.
- Claudian classes use the `.claudian-` prefix with block/element/modifier names. Host selectors and generic state classes are exceptions.
- Obsidian can restore native button/input chrome on hover, focus, active, or disabled states. Apply control resets across those states while retaining visible keyboard focus; filled button surfaces need an explicit modifier.
- Embedded inputs stay transparent/borderless in every state; their wrapper owns surface/focus treatment. Textarea resizing needs an explicit bounded modifier.
- Persistent session-manager styles stay under its dedicated containers; shared history item primitives must not impose persistent-sidebar sizing or actions on the compact menu.
- Pinned/session lists scroll independently. Preserve min-height: 0 through flex ancestors so bounded lists and sticky headers do not clip.
