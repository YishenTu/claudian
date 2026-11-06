# Linked content

Linked content is a conversation's optional primary vault file, Markdown note or folder reference. Choose it before starting the conversation, especially when the note currently open is unrelated to your question.

## A path reference, not a bulk attachment

Claudian supplies a vault-relative path such as `Notes/Plan.md`. Linking content does not automatically paste the complete file or every file in a folder into your prompt.

The agent is instructed to inspect the files needed for your request. Linking a folder does not change the vault-root working directory, require a recursive read, grant extra access outside the existing sandbox, or restrict work to that folder.

Actual file access depends on the provider's native runtime, configured tools and permissions. The reference does not guarantee identical retrieval or ingestion across providers.

## Choose or clear the draft reference

A new draft automatically picks an eligible active Markdown note. While the draft is active, that choice follows active-note changes until you explicitly choose or clear a reference. Excluded tags can prevent a note from being picked automatically; other file types are not automatically selected this way.

1. On the welcome screen, click the value beside **Linked content:**.
2. Type part of a file name, folder name or vault-relative path. Results appear only after you enter a search query.
3. Click a matching result, or use **Up/Down** and **Enter** to select it. The result's detail shows its path, helping distinguish similarly named content.
4. Press **Escape** to close the picker without changing the selection.

To start without a reference, search for **None** and choose the entry with the detail **No Linked content**. You can also remove an existing draft chip with its **×** button. Both actions explicitly clear the reference and stop automatic note following for that draft.

Explicitly choosing a file or folder also stops automatic following. Opening another note then leaves your chosen draft reference intact.

## What happens when you send

Check the chosen reference before the first send. Selection is temporarily unavailable while that input creates the conversation. Once the conversation is created, its captured reference is locked: opening another note does not retarget it, and the chip no longer offers removal.

If conversation creation itself fails, the editable draft is restored. A failure after creation, including a provider failure, does not unlock the reference just because no reply or message was recorded.

Start a new conversation when you need a different primary reference or no reference. Additional `@` references in later prompts are separate context references; they do not replace this conversation binding.

For example, if a course discussion was started with an unrelated research note linked, switching the active editor to the course note will not change that existing conversation's Linked content. Choose the course note in a new draft before sending.

## Open linked content and handle missing paths

The chip remains usable after locking: click it to open its file or reveal its folder. This activates the content rather than reopening the selection picker.

If a locked path no longer resolves, the chip is marked **Missing content**. Activating it reports the missing path instead of guessing a replacement.

## Current limitation

Changing or removing Linked content after conversation creation is not currently available. The [request to edit it after the first message](https://github.com/YishenTu/claudian/issues/2109) discusses that separate feature; this guide describes the existing selection and lifetime rules.
