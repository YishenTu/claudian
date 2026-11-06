# Prompt history

Recall earlier prompts in the Main message composer to revise or send them again.
Recalling text alone does not send a message.

## Recall and resend

1. Open the conversation you want and focus its Main message composer.
2. With the input completely empty, press **Up** without any modifier keys to recall the latest eligible prompt.
3. Use **Up** and **Down** to browse earlier and later prompts.
4. Edit the text if needed, then use your configured send shortcut.

In ordinary Main chat, sending recalled text submits a new prompt.
Recall does not edit the earlier message or rewind files.
If you are already editing a branch, sending keeps that branch-edit workflow's behavior.

## Navigate recalled text

Within multiline or soft-wrapped text, Up and Down first move the caret between rows.
History navigation occurs from the first rendered row for Up or the last rendered row for Down, with no text selected.
Recalling a prompt places the caret at the end, so a multiline prompt may need several Up presses before reaching an earlier prompt.
At the oldest prompt, Up leaves that prompt in the composer.
Down beyond the latest prompt returns the composer to empty input.
Press **Escape** to clear an unchanged active recall.

Recall stays active only while the input still exactly matches the recalled text.
While your edited text is nonempty and differs, recall does not consume Up, Down or Escape; normal composer behavior applies.
Clearing the input allows Up to start a fresh recall.
An open composer or toolbar menu may handle navigation or Escape first.
Escape is therefore not a universal clear-draft shortcut.

## Scope and limits

- Recall starts only from completely empty input. Whitespace counts as existing text, and recall does not replace a nonempty draft.
- Recall uses eligible user-prompt text from the current conversation or branch, including prompts outside the currently rendered part of the transcript.
- Assistant replies, hidden entries, reconstructed context entries and textless image-only prompts are skipped.
- Recall inserts prompt text only. It does not restore earlier attachments or injected context.
- While editing a branch, recall uses prompts before the branch point.
- Recall is unavailable when the composer targets **Side**. Switching conversations or destinations resets recall navigation.
- Modified arrow keys and IME composition are left to normal editor behavior.

Prompt history is conversation-scoped; it is not a global prompt database.
