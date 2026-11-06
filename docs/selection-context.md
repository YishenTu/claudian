# Selection context

Include selected text or Canvas references with a chat request.
Keep the intended chat open and inspect its composer indicators before each send.

## Select, check and send

1. Select text in an Obsidian note/editor, reading view, or a readable browser-style view inside Obsidian. For Canvas context, select nodes in an open Canvas.
2. Return to that chat's message composer and wait for a selection indicator.
3. Check every context indicator and remove anything unintended with its **×** control.
4. Add your instructions and send with your configured control or shortcut.

Text-selection indicators show a line count, such as **2 lines selected**.
Canvas indicators show a node count, such as **2 nodes selected**.
Selection indicators do not open a preview when clicked.
If the context tray overflows, use **+N more** and **Show less** to inspect its items.
More than one selection source can be included; review each indicator.

Removing an indicator clears captured context, not the source text or Canvas nodes.
Selecting again in the source can capture it again.
Selecting content alone does not send a chat message or invoke Inline Edit.

## What the request includes

- **Note/editor or file view:** captured text and a file reference, with a source line range only when available.
- **Embedded browser-style view:** selected text, with a title or URL only when the view exposes that information.
- **Canvas:** the Canvas path and selected node IDs.

Rendered views do not necessarily expose raw Markdown or reliable source lines.
Canvas references do not paste node contents, embedded files/images or the whole board into the request.
The agent may inspect references through its tools within their normal permissions; selection does not grant extra access.

## Embedded browser limits

Browser selection capture requires an active, readable browser-style view **inside Obsidian**.
It does not watch selections in a separate Chrome, Safari or other desktop application.
Support depends on what the view exposes, including access to embedded frames or webviews.
An inaccessible frame or unavailable selection API can leave you without an indicator.

If an indicator does not appear, paste the required text into your prompt explicitly, or use an available file reference.
Do not assume every PDF, plugin view or website supports selection capture.

## Transient context

Selection context is separate from the conversation's primary **Linked content**.
Moving focus into the same chat's composer can preserve an available capture while you type.
Source changes, deselection and tab lifetime can update or clear indicators.
Inspect them again at every send; they are not permanently pinned context.

A request captures a copy of its selection context.
Changing the source selection later does not retroactively rewrite that captured request.
