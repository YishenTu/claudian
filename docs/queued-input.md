# Queued composer input

You can submit an ordinary follow-up while a conversation's Main turn is working.
Use the queue controls to inspect pending input before it starts another turn.
Agent-to-agent messages use the separate [cross-session mailbox](cross-session-messaging.md).

## Submit a follow-up while work is active

Select the intended conversation and the **Main** destination in the composer.
Type your follow-up and use your configured send shortcut.
Ordinary input admitted while Main is working goes into a queued follow-up.
Composer menus, text composition and submission preparation can affect when input is admitted.
Local slash commands have their own handling; use ordinary follow-up text for this workflow.

Look for the **Queued** strip above the input box to inspect pending input.
There is one queued follow-up: additional admitted input merges into it, including attached images.
These submissions are not separately reorderable queue items.
The strip shows a shortened preview and can append **[images]** when images are attached.
Use the editing action to inspect and revise the pending draft rather than relying on its preview.

Pending input normally waits for the current turn to settle before starting the next turn.
Starting that turn still depends on the conversation being available for input and an available model.
Check the conversation's subsequent activity to see what has started.

## Edit or discard the pending follow-up

The **Queued** strip has icon controls named **Edit queued message** and **Discard queued message**.
Select **Edit queued message** to withdraw the pending follow-up into Main's composer.
It merges with any draft already there, so inspect the resulting text and images before revising and submitting it.
The withdrawn input is no longer waiting to start automatically.

Select **Discard queued message** to remove the pending follow-up and its scheduled continuation.
Discarding pending input leaves the current turn working.
It does not change a previously sent message or undo work that tools have already performed.

## Steer the running turn when offered

**Steer Now** appears when the active execution and provider support allow steering.
Select it to ask the provider to incorporate the queued input into the running turn.
This hands input to that turn rather than locally interrupting it and starting another one.

While the strip reads **Steering**, that pending request has no Edit or Discard controls.
Wait for its delivery outcome and inspect subsequent conversation activity.
If the provider accepts the input, its steering strip clears.
The strip clearing does not mean the parent answer is complete.

## Interpret returned or unconfirmed input

If steering is definitely unsent, its input can return to the queue while the turn is still running,
or to the composer after the turn stops running. The return belongs to the originating conversation.
If you switched conversations, return to that conversation to inspect the restored input.
Review any returned draft before deciding whether to submit it again.

If steering delivery cannot be confirmed, a notice explains that the message was not requeued
to avoid sending it twice. Inspect later conversation activity before deciding on a follow-up;
do not resend the same input merely because its strip disappeared.
Accepted input is already handed to the provider and is not withdrawn by the pending-input controls.

Main cancellation can also return still-queued input to the composer.
Inspect that returned draft, including any existing draft it merged with, before submitting again.
