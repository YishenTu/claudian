# Session history, forks and rewind

Closing a chat tab changes what is open; it does not delete the saved session.
Use the session list to return to earlier conversations. In single-pane mode the
history picker opens beside the composer; dual-pane mode keeps the session
manager beside the chat.

## Find and organize a session

Search the session list to narrow its titles. Its organization menu can show one
list or group sessions by Linked content, and sort by creation or last activity.
Projects have their own groups; see the [Projects guide](projects.md).

A session's menu offers the actions available in that layout:

| Action | Result |
| --- | --- |
| Open in new tab | Opens the session in another compact chat tab. |
| Open in background tab | Opens it without selecting that tab. |
| Switch to open session | Goes to the view that already holds the session. |
| Rename | Changes its conversation title. |
| Pin / Unpin | Changes its position in the active session list. |
| Mark as unread / Mark as read | Changes the session's review-attention mark, when offered. |
| Copy session ID | Copies the identifier used by the cross-session tools. |
| Move to project / Remove from project | Changes project membership. |

You can also point another agent at a session with an **@** mention or its copied
ID. That shares a reference, not the entire transcript; see
[cross-session messaging](cross-session-messaging.md).

Long conversations initially render their latest turns. Choose **Show earlier
messages** above the transcript to reveal older turns; their absence from the
initial screen does not mean they were deleted.

## Archive, restore and delete

**Archive** removes a session from the active list. Open the archive view to
choose **Restore** or **Delete**. Running sessions cannot be archived or deleted;
bulk actions skip sessions that are still running. This includes background work,
not just the chat currently on screen.

A session row's **Delete** action removes the saved Claudian session directly;
bulk deletion asks for confirmation. Use **Archive** to keep a session for later
instead. Closing a tab, archiving a
session and deleting a session do not undo the edits its agent made to notes.
Use rewind's file option when that is the operation you intend.

## Fork a conversation

Where the provider supports it, an assistant reply offers **Fork conversation**.
Forking creates a separate conversation from that checkpoint, keeping the original
conversation available. Later work in the fork does not replace the original
conversation's later replies.

In single-pane mode, choose **New tab** or **Current tab** for the fork. Choosing
the current tab replaces that tab's displayed session; the source session remains
in history. In dual-pane mode, the fork is shown in the conversation viewer.
A fork keeps the source session's project and Linked content.

The action needs a native checkpoint the provider can fork. It may be unavailable
while work is running or when the saved message identity is missing. A copied
transcript alone does not supply that native checkpoint. Forking conversation
history does not restore old note contents.

## Rewind a Claude conversation

Claude Code provides **Rewind to here** on eligible user messages. Stop the
current turn before rewinding. The menu distinguishes two operations:

- **Rewind conversation only**: return the conversation to that point and keep
  file changes.
- **Rewind code + conversation**: also restore tracked file changes. Read the
  confirmation and any reported conflicts; files changed outside the agent may
  be overwritten. The confirmation describes this as an operation that cannot
  be undone.

If rewind succeeds but saving its state fails, the notice says so. Do not assume
a failed state save means the native rewind or file changes were reversed.

## Pi branches

Pi can keep alternative user-message branches inside one native session. When a
message has alternatives, its branch controls show the position and let you move
between them. The controls may be unavailable while navigation is busy or until
the native message identity is known.

This branch navigation stays within the Pi session. **Fork conversation** creates
a separate conversation instead; it is a different choice from selecting another
branch in the current one.
