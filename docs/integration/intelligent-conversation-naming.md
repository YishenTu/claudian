# Optional intelligent conversation naming

Enable **Intelligent conversation naming** under Conversations in Claudian settings. It is off by default and uses the existing global title-model and title-language settings. Select an available title model before use. Disable an external naming companion first; the API refuses duplicate subscribers.

The wand ribbon provides long/short/both regeneration, manual short-label editing, and confirmed missing-label completion for 2, 3, 7, 30 days or all history. Commands are secondary access. Regeneration asks before replacing existing names; concurrent manual edits are protected independently per field. Manual long-title editing remains in the existing session UI.

Automatic naming receives only the first accepted visible request and makes one passive task producing structured long/short titles. Semantic labels accept general Unicode, including non-Latin languages and technical identifiers. Invalid responses preserve existing titles. Turning the feature off unregisters subscriptions, stops queued generation and fences in-flight results; an already-started provider request remains bounded by the API deadline. Plugin unload cancels it.

Batch completion uses a frozen confirmed set, skips labels added after confirmation, and only writes absent short labels. It uses existing long titles rather than eagerly hydrating every native transcript. Manual regeneration may explicitly read first user text. Neither tab switching nor rendering runs models or scans native history.

Tab badges display stored short labels, falling back to existing numbered badges when absent; double-click still expands the long history title. Disabling generation does not delete previously saved titles or labels. UI strings are English with Simplified Chinese translations; other UI locales currently use the added English strings. Model output follows the configured title locale.

## Review and acceptance

The feature is proposed on top of the separate Naming API PR. No runtime bundle is installed into a working Vault by this contribution. Before promotion from draft, verify in Obsidian: enable/disable and companion conflicts, first accepted input, manual edits during generation, failure/timeout, each batch range, keyboard controls, and 10–15 open tabs without rendering-path model work. Also review the Node performance warning; headless checks do not prove renderer performance.
