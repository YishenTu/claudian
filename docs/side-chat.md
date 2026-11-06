# Side chat

Explore an alternative with a temporary child conversation while keeping the Main conversation branch separate.
The same composer serves Main and Side, so check the expanded panel before sending or stopping work.

## Start from a completed reply

1. Keep the parent conversation open and wait for a completed Main reply.
2. Submit `/side Compare another approach` or `/btw Explain this alternative` with your configured send control or shortcut.
3. Continue in the expanded Side panel, where the composer is named **Side chat message**.

Include a nonempty prompt after the command.
Merely typing the command previews its styling; it does not start the child.
If the provider is unsupported, a checkpoint is missing, or the source cannot be used, Claudian shows a notice rather than sending the command as an ordinary Main prompt.

The child captures the latest completed assistant checkpoint once when it starts.
It does not track later Main replies.
Where a provider allows starting Side while Main is working, it uses the earlier settled boundary, not the unfinished reply.
Provider support and running-state restrictions vary; Antigravity currently does not support this fork workflow.

## Know the composer's destination

- **Side expanded:** the shared composer, toolbar settings and Stop apply to Side.
- **Side collapsed or absent:** they apply to Main.

Use **Collapse** to return to Main, then activate the collapsed Side chip to reopen the child.
**Full height** gives the expanded panel more space without changing its destination.
Control labels are localized; the names above are English examples.

Main and Side keep separate unsent text and image drafts while you switch destinations.
Inspect the restored draft before sending; this is not a promise of draft recovery after restarting.

## Continue or start afresh

Follow-ups in the expanded panel reuse the existing child.
While that child is responding, a direct expanded send leaves your draft in place; wait for it to finish.
From collapsed Main, submitting another `/side ...` or `/btw ...` also reuses the child, queuing the submission if it is busy.

Each parent has one child at a time.
To capture a newer Main checkpoint, **Discard** the existing child before starting another.
Side cannot start a nested side chat, and Main-only local commands are unavailable there.

## Collapse, Stop and Discard

| Action | Effect |
| --- | --- |
| **Collapse** | Retains the child and its ongoing work; routes the shared composer back to Main. |
| **Stop** | Cancels the selected destination. With Side selected, also clears queued Side submissions. |
| **Discard** | Disposes the child, clears its Side draft and returns routing to Main. |

These actions do not undo tool effects that already happened.

## Settings and file effects

Side starts with copied parent settings.
Subsequent Side model, reasoning and permission choices are independent; collapsing restores Main's toolbar settings.
Model changes within Side stay on the same provider.

Side can use tools that change actual vault files, with the normal permission and approval mechanisms.
A separate conversation branch is not a filesystem sandbox or rollback boundary.
A side chat from a project member also receives the parent's project instructions; see [Projects](projects.md#what-members-get).
For how Side uses its parent's messaging identity, see [Cross-session messaging](cross-session-messaging.md#availability).

## Temporary history

Side's transcript and settings live in Claudian memory, not as a separately saved Claudian conversation.
They can remain while you switch tabs or the parent temporarily loses its display.
Discarding, disposal of the parent session, or plugin shutdown releases the child.
Copy useful results before discarding or restarting; use a normal conversation when you need durable Claudian history.

Provider-native artifacts and persistence vary.
Discard is not a guarantee of erasing native provider history or reversing file changes.
