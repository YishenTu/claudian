# Command menu

Use the Main chat composer to find a command, insert its token, add arguments and then send it.
Choose the intended conversation and provider first; provider entries depend on that provider's available catalog.

## Find an entry

Start with an empty composer and type `/` at the very beginning.
Continue with a command name, alias or part of its description to narrow the list.
Exact name or alias matches come first, followed by prefixes, name substrings and description-only matches.
Matching name text is highlighted; a matching alias can appear beside the canonical name.

Provider menus may also recognize prefixes such as `$` for skills.
Follow the prefix displayed and inserted for the entry you choose.
A menu can open after whitespace within a prompt, but Claudian-owned action rows require `/` at the very beginning of the composer.
An embedded `/new` is not a request to start a new conversation.

## Insert, then send

While a selectable suggestion is highlighted:

- Use Up or Down to change the selection.
- Press Enter or Tab, or select the row with the pointer, to insert its token and a trailing space.
- Press Escape to close the menu.

Selecting a command closes the menu and returns focus to the composer; it does not send the message.
Add any arguments the command supports, then use your configured send shortcut or the send control.
For a slash-prefixed entry, `/<listed-name> <arguments>` illustrates the shape; replace the placeholders with the actual listed name and supported arguments.
Argument hints and descriptions provide guidance, rather than validating that every provider accepts the same arguments.

**Retry**, when offered, is a different kind of row: selecting it requests provider command discovery again instead of inserting a command.

## Local actions and provider commands

Claudian-owned actions operate on the chat, while provider commands and skills use the provider's execution behavior.
Available local actions depend on the provider's capabilities and the composer destination.
For a local action, submit a complete leading command; surrounding whitespace is trimmed during dispatch even though the menu's leading-slash rule is stricter.
`/compact` goes through provider execution rather than being a universal local action.
A command available in a provider's terminal interface is not necessarily supported inside Claudian.

For Claude Code, native entries marked as built-ins are omitted, along with custom entries sharing those names.
Older command snapshots without that marking cannot be classified the same way.

## When an entry is missing

Check that you selected the intended provider and read the menu's feedback:

- **Loading provider commands…** means discovery is pending.
- A session requirement or error message explains why provider entries are unavailable; use **Retry** if it is offered.
- **No matches** means the current menu has no matching entries; shorten the search and check hidden names.

Under **Settings → Claudian → Skills → Hidden commands and skills**, enter exact provider entry names without a leading slash, one per line.
For Pi skills, use `skill:name` rather than just the skill name.
Leave the field after editing so pending text changes are saved.
This list filters provider menu entries across providers; it does not hide Claudian-owned action rows or revoke native permissions.
The catalog and its supported commands still depend on the provider's runtime and configuration.
