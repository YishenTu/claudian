# Projects

A project groups sessions that work toward one goal. Every session in a project shares the project's instructions and a memory file that the agents keep current, and the agents can find, read and message each other.

A project has a name, instructions and a memory file. Sessions on any provider can be members, and a session belongs to at most one project.

## What members get

From its next turn, each member session gets a Project section in its system prompt with:

- the project's name and instructions;
- the vault path of the project's memory file, and how to keep it;
- how to work with the other sessions in the project.

A side chat opened from a member gets the same section, taken from its parent when the side chat starts.

## The memory file

The memory file is an ordinary Markdown note in your vault, shared by every member. A new project's file starts from a template with Goal, Requirements, Decisions, State, Open questions and Dead ends sections.

Agents are told to:

- read the file first, use it to guide their work, and treat your latest instructions as authoritative;
- keep the goal, scope, constraints, acceptance criteria and open questions current, separating explicit requirements from assumptions;
- record decisions with their reasons, mark superseded ones instead of deleting them, keep the State and Dead ends sections current;
- update it only when something durable changes (a requirement, a decision, a milestone, a dead end, or a handoff), and leave it alone otherwise;
- re-read it right before editing and make targeted edits, since other sessions edit it too;
- not mention it in replies unless you ask about it.

### Editing the memory

Choose **Open project memory** from a project's menu, or **Open** next to the memory file in the project editor. The window shows the memory rendered as Markdown; switch to **Edit** to change it. Clicking a rendered heading opens the editor at that heading.

- The window follows the file while agents change it. Unsaved edits are never replaced: when the file changes under them, you choose **Keep my edits** or reload.
- Saving checks that the file hasn't changed since you loaded it. If it has, choose **Reload** to discard your edits or **Overwrite** to keep them.
- If the file is missing, **Recreate from template** creates it again. An existing file at that path is never replaced.

You can also edit the file directly in Obsidian or any editor.

## Working with other sessions

Members are told to use the [cross-session tools](cross-session-messaging.md) within their project:

- `claudian_list_destinations` with `project: true` lists the non-archived sessions in the calling session's project. It fails when the session is not in a project.
- `claudian_read_session` reads a member, and `claudian_send_message` hands off, delegates or coordinates work. Messages must be self-contained, since the recipient cannot see the sender's conversation.
- A session started with `claudian_send_message` joins the sender's project.

On Codex, project listing needs a thread started with the current session tools; older threads lack it.

## Creating a project

Create a project with the `+` in the session list's **Projects** header, or with **New project…** when moving sessions to a project.

| Field | Notes |
|---|---|
| Name | Shown in the session list and in member sessions. Required. |
| Instructions | Added to every member's system prompt from its next turn. No length limit. |
| Memory file | Vault path of the memory file. Defaults to `.claudian/projects/<project-name>/MEMORY.md`, based on the name; a missing `.md` extension is added. The path must be inside the vault and must not already be used by a file or another project. |

Project records are stored one per project in `.claudian/projects/<id>.json`.

## Adding sessions

- **New sessions:** starting a new session keeps the current session's project, whether from the sidebar or composer New, `/new`, or the tab bar `+`. A project row's New button starts a session in that project.
- **Draft chip:** in a new session started in a project, the project chip in the composer switches to another project or **No project** until you send the first message. After that it is a fixed label. Sessions without a project show no chip.
- **Moving sessions:** a session's menu, or the menu for a multi-selection, offers **Move to project…** and **Remove from project**. You can also drag sessions onto a project, back to the session list to leave the project, or onto Pinned to pin them while keeping their project.
- **Forks** join the source session's project.

## Managing projects

Each project in the **Projects** section has a collapse toggle, a New button and a menu:

| Action | Effect |
|---|---|
| Pin project / Unpin project | Moves the project, with all its members, into Pinned. |
| Edit project | Opens the editor for the name, instructions and memory file. |
| Open project memory | Opens the memory window. |
| Archive all sessions | Archives the project's sessions, skipping running ones. The project stays listed until you delete it. |
| Delete project | Deletes the project after confirmation. See below. |

The **Projects** header's sort menu orders projects by last activity or creation time. In single-pane mode, the history drop-up shows the same Projects section and actions, with pinned projects first.

### Moving the memory file

Changing the memory file path in the editor moves the file to the new path.

- The new path must not already hold a file or belong to another project.
- If the file is missing, the project is only repointed to the new path.
- If another project still uses the same file, which can happen with records from an earlier version or another synced device, the file is copied to the new path instead of moved. The other project keeps the original, and the two files are edited independently from then on.
- If saving the project fails, Claudian tries to undo the move, or removes the new copy.

### Deleting a project

Deleting a project removes its record and moves its memory file to the system trash, or to the vault's `.trash` folder when the system trash is unavailable. An empty project folder inside `.claudian/projects/` is removed too. If another project still uses the same memory file, the file is kept.

The project's sessions are kept and leave the project.
