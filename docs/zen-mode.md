# Zen Mode

Zen Mode keeps the existing chat available in a compact panel while you work in a note.
It presents the same conversation and composer that normally live in the sidebar.

## Enter Zen Mode

1. Open **Settings → Claudian → General → Display** and turn on **Enable zen mode**.
2. Open your Claudian chat in the left or right sidebar.
3. Collapse the sidebar that actually contains that chat.

The chat's composer moves into a compact panel near the bottom of the central workspace.
Collapsing the opposite sidebar does not trigger Zen Mode for that chat.
A chat placed in a main editor tab or pop-out is not a sidebar source for this presentation.
Zen Mode requires desktop Obsidian, an available chat and a supported central workspace host.

Your existing draft and active conversation remain with the same chat.
Use the composer's normal configured keyboard controls when writing and sending.
Opening or hiding this presentation does not submit a message or change the composer destination.

## Read activity and open the conversation

When the chat has messages, its one-line activity preview offers **Show conversation**.
Activate that button to expand the existing transcript above the composer.
A new conversation with no messages has no history drawer yet.

The preview summarizes Main chat activity, such as response text, thinking, a tool, waiting, an error or a request for your input.
A finished response can show its work duration and the first line of the answer.
Open the conversation for the complete response and interaction details.
Side Chat reports in its own panel and status; the Main preview does not identify the composer's selected destination.

To use a hotkey for disclosure, assign one to **Claudian: Toggle zen mode history** in Obsidian's hotkey settings.
That command is available when a Zen panel is attached and its chat contains messages.
It changes whether the transcript is expanded while keeping the same conversation.

Clicking or moving focus elsewhere in Obsidian collapses the expanded transcript.
Interacting inside the panel, or in menus, modals and suggestions opened by its controls, keeps it open.
Moving to another application window alone may leave the transcript expanded.

## Move or dock the panel

Find the **Move chat panel** grip beneath the composer by hovering over the panel.
Drag the grip to reposition the panel within the central workspace.
Bring it near its bottom dock to snap it back, or double-click the grip to dock it.

## Return to the sidebar or hide the panel

Reopen the sidebar holding the chat to return the composer and conversation to their normal location.
To hide a visible Zen panel while keeping the sidebar collapsed, use **Claudian: Toggle chat view**.
Use that command again to show the hidden panel while its sidebar remains collapsed.

If the panel does not appear, check **Enable zen mode**, the chat's actual sidebar placement and whether that same sidebar is collapsed.
Allow an existing restored chat to become available before checking for its compact presentation.
