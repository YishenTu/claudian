# Inline edit

Use Inline edit to replace a passage or insert new text at the cursor in a
Markdown note. Claudian shows the proposed change inside the note for review.

## Start an edit

1. Open a Markdown note in its editor.
2. Select the text to replace. To insert text instead, leave the selection empty
   and place the cursor at the insertion point.
3. Run **Claudian: Inline edit** from Obsidian's command palette. You can assign
   this command a shortcut in **Settings → Hotkeys**; a shortcut is not required.
4. Enter an instruction such as “Make this paragraph clearer while preserving
   the links,” then press **Enter**.

A whitespace-only selection starts an insertion rather than a replacement.
The selection highlight shows the passage the edit targets. While entering the
first instruction, you can select a different passage in the same note to move
that target.

## Choose the model

The model chip beside the instruction shows the model and, when supported, its
reasoning effort. Open the chip to choose an enabled model or change its effort.
Before the edit starts a provider conversation, the picker also offers models
from other enabled providers. Once the agent is conversing, the edit keeps that
provider.

A choice becomes the default for later inline edits. It does not change the
model selected in your chat sessions. The current request uses the model and
effort shown on the inline chip.

If the chip reports **Model unavailable** or **Set up models**, enable an
available model in Claudian's provider settings. See
[model discovery troubleshooting](troubleshooting.md#a-newly-released-model-is-missing)
if the desired model is absent.

## Add context and answer questions

Type **@** in the instruction to find vault files and folders. A file choice
inserts its vault path into the instruction; keep that mention intact so the
request can resolve the file as context. For example:

```text
Match the terminology in @Notes/Style guide.md and keep the existing headings.
```

The provider's slash commands and skills are offered when available. Their
trigger characters follow that provider. Main-chat commands such as `/clear`
and `/sessions` are not offered in the inline instruction picker.

If the agent asks for clarification, its question appears above the instruction
field. Type your reply and press **Enter** to continue the same edit. The note
has not yet accepted a replacement merely because a question or preview appears.

## Review the result

The preview renders the affected Markdown as removed and added blocks, with
line counts beside the actions. An insertion has added content only. Review the
text, formatting and links before choosing **Accept** or **Reject**.

| Action | Keyboard behavior |
| --- | --- |
| Send the instruction or clarification | Enter in the instruction field |
| Choose a suggestion | Arrow keys, then Enter or Tab |
| Close an open suggestion or model menu | Escape closes that menu first |
| Accept the preview | Enter in the note, outside the preview's controls |
| Reject the edit | Escape while focus is in the note or inline edit |

The preview's **Accept** and **Reject** buttons also work with their normal
keyboard activation. Rejecting removes the proposed edit and, for a selected passage, restores its
highlight. Accepting applies the replacement or insertion through the
note editor.

## When an edit cannot be applied

Changing the source document while a request or preview is open invalidates the
proposal. Claudian rejects it rather than applying text against an outdated
version of the note. Start Inline edit again from the updated note and selection.
Closing the note's editor also ends its inline edit.

If a provider cannot start or a request fails, the instruction remains available
for a retry when the edit is still usable. Check the provider configuration and
[CLI troubleshooting](troubleshooting.md#provider-cli-not-found) if it keeps
failing. An error placeholder is not an applied change to the note.
