# Cross-session messaging

Agents in one Claudian session can find other sessions, read them, send them messages, steer or interrupt their work, and start new sessions on any enabled provider. An agent can hand off a task, consult a session that already has the right context, or delegate work to a different model.

Agents use three tools for this. You don't call them yourself: ask the agent, for example "ask the Review session what it found" or "start a Codex session to write the tests".

For other Obsidian plugins that want to send prompts to sessions, see the [Plugin API guide](plugin-api.md).

## The tools

| Tool | What it does |
|---|---|
| `claudian_list_destinations` | Lists the sessions an agent can message, and optionally the providers, models and reasoning levels it can start a new session with. |
| `claudian_send_message` | Sends a message to an existing session, or starts a new session with it. |
| `claudian_read_session` | Reads another session's prompts and final replies. |

### Listing sessions

`claudian_list_destinations` returns non-archived sessions, most recently active first. Each entry has the session's id, title, provider and status:

| Status | Meaning |
|---|---|
| `idle` | Not working. |
| `running` | Working on a turn or background work. |
| `awaiting-user` | Waiting for you to answer a question or approval. |

- The session you are viewing is marked `active`, and the calling session is marked `self`. A session cannot message itself.
- It returns 50 sessions by default and at most 200; `truncated` is set when more exist.
- With `includeProviders: true`, it also lists the enabled providers with their models and reasoning levels, and marks the provider, model and reasoning level a new tab would use.
- With `project: true`, it lists only the sessions in the calling session's project. See [Projects](projects.md).

### Sending a message

`claudian_send_message` returns as soon as the message is accepted, with the recipient's id, title, provider and a status. It does not wait for the recipient's turn or a reply.

| `mode` | Behavior | Status |
|---|---|---|
| `queue` (default) | Starts a turn in the recipient, or waits until the recipient finishes its current work. | `started`, `queued` |
| `steer` | Joins the recipient's running turn. Without a turn to join, or while the recipient waits for your answer to a prompt, it is queued instead. | `steered`, `uncertain`, or the `queue` statuses |
| `interrupt` | Stops the recipient's work like the Stop button, then delivers this message first. | `interrupted`, or the `queue` statuses when nothing was running |

- `uncertain` means a steer may or may not have reached the provider. It is never resent.
- An interrupt without text only stops the recipient: `interrupted`, or `idle` when nothing was running. An interrupt stops the recipient's main work only; a running side chat continues.
- After an interrupt, messages other agents had already queued are kept, and your own queued input returns to the composer.
- `steer` and `interrupt` need an existing session.

#### Starting a new session

Without a `sessionId`, the message starts a new session. Omitted choices follow your new-tab defaults. An agent can pick a `provider` (which then needs a `model`), a `model`, and a `reasoning` level. Invalid choices are rejected with the valid options listed. A session started from a project member joins that project.

#### Switching an existing session's model

With an existing session, the message runs on that session's own provider, model and reasoning settings. An agent can pass `model` or `reasoning` to switch them before the message is delivered. The model must belong to the session's provider. The switch stays for the session's later turns and shows in its model controls. A switch cannot be combined with `steer`, and a rejected send changes nothing.

A reasoning level chosen by an agent applies to that session only and does not change your saved setting, so it resets after Obsidian or the plugin restarts.

### Reading a session

`claudian_read_session` returns a session's transcript as Markdown: each turn's prompt and final reply, without tool calls, thinking, or a turn still running. Turns are numbered from 1.

- A read holds the latest turns that fit in about 40,000 characters. When `fromTurn` is greater than 1, the agent passes it as `beforeTurn` to page back. A single turn that is too long is truncated.
- A loaded session, in a tab or in the background, is read live; any other session is read from its stored history.
- Archived sessions can be read by id.

## How messages are delivered

Each session has its own mailbox. A queued message waits until the recipient is free: no running turn, no queued input from you, no background work, and no question or approval waiting for your answer. Your queued input always goes first.

- Messages are delivered one per turn, in arrival order, and are never merged with each other or put into the composer. Interrupts go ahead of ordinary messages, the newest first.
- A recipient that isn't open in a tab is loaded in the background without opening one.
- Stopping a session, or archiving or deleting it, drops its pending messages. Claudian shows a notice naming the senders whose messages could not be delivered.
- A message from another session does not clear the recipient's unread mark.
- If the recipient asks for a permission or a question during the turn, the turn waits until you answer on screen.

## Received messages

A received message shows a **From session:** line with the sender's title, linking to the sender. The line survives history reload.

The agent sees the message wrapped in `<session_message from="…" session_id="…">`, with a note that replying is optional. It replies only when a response is needed, by sending a message back to that `session_id`.

## Tool cards

| Tool | Card |
|---|---|
| List destinations | The returned sessions, linking to each, with the calling session marked **This session**. |
| Message session | The recipient (**New session** when the send created it), the requested model and reasoning, the delivery mode, and the full message. A stop without a message is titled **Stop session**. |
| Read session | The session and the returned turn range. The transcript itself stays with the agent. |

## Pointing an agent at a session

- **@ mentions:** type `@` in the composer and pick a Claudian session. The agent receives the session's title, id, provider and last update, and reads it with `claudian_read_session` when it needs the content.
- **Copy session ID:** in a session's menu in the session list, choose **Copy session ID** and paste it into your prompt. It is offered for non-archived sessions.

## Availability

The tools are available in main chat and side chat sessions on these providers:

| Provider | Notes |
|---|---|
| Claude Code | |
| Codex | A thread keeps the tools it started with. Threads created before the session tools have none; older threads may lack the read tool, the send modes, or project listing. Start a new session to get the current tools. |
| DeepSeek Harness | |
| Grok Build | |
| OpenCode v2 | OpenCode v1 is not supported: its sessions get no session tools. |
| Pi | |

- On providers or threads without the read tool, an @ mention still carries the session id, but the agent cannot read the session.
- Calls that Claudian cannot tie to a running chat session are rejected with "Session tools are only available in Claudian main chat sessions with the default tool policy." For example, a Codex fork or a session on a shared OpenCode or DeepSeek Harness process may see the tools listed without being bound to a Claudian chat; its calls fail.
- A side chat acts as its parent session: its `self` entry and the sender of its messages are the parent, so it cannot message its own parent. A side chat on a draft that hasn't been sent yet has no session tools.
- OpenCode v2, DeepSeek Harness and Grok Build sessions reach the tools through a listener that accepts connections from 127.0.0.1 only.
