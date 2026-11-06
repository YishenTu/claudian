# Subagent work

When a subagent/task card appears inside a reply, use it to inspect the child work reported by the provider.
These cards represent provider-native tasks, rather than separate Claudian sessions.
For finding, messaging or starting separate sessions, see [Cross-session messaging](cross-session-messaging.md).
Card availability and details depend on the provider's normalized output.
The absence of a card does not establish that no delegation occurred.

## Open a task card

Find the card in the conversation, expanding the surrounding work section if needed.
Read its task description and reported status, then click the header to expand it.
You can also focus the header and press Enter or Space.
The expanded card can contain independently collapsible sections and child-tool entries:

- **Prompt**, when supplied, shows the task's prompt text.
- Each supplied child-tool entry has its own header for inspecting that tool's details.
- **Result** shows the child task's result once its reported state has settled.

Expand those nested headers separately to read their contents.
Opening a card or section inspects supplied information; it does not launch another task.
Prompt and result sections display the supplied plain text.

## Interpret results and progress

Read the child task's reported running, completed or error state separately from the parent reply.
A child result does not establish that the parent has finished its work.
Likewise, completion of a tool invocation that launches child work does not by itself mean that child work is complete.
If a settled task has no nonblank result text, its **Result** section can show **DONE** or **ERROR**.
These are fallback labels, rather than additional result content.

When progress is supplied, the card can show an activity summary or a **Last tool:** label.
It can also show reported tool-use counts, token counts or duration.
Treat these as the latest reported activity: an update that omits a field can leave an earlier value displayed.
They do not establish a continuously current measurement or a complete record of child tools.
Available progress information varies by provider and task.

## Recognize background status

Background task cards can show **Initializing**, **Error** or **Orphaned** when those states are reported.
Running and completed background cards can show status icons without a visible status word;
their accessible labels identify **Running in background** or **Completed**.
Their prompt, child-tool and result sections use the same inspection pattern.

An orphaned card can show **Conversation ended before task completed** when no result was supplied.
This describes the available card state. It does not establish whether a native process is still running or has terminated.

## Inspect earlier loaded runs

If **Previous runs (N)** is offered, expand it to see earlier runs associated with the recognized native agent identity.
Then expand an entry such as **Run 1 · Completed** to inspect its supplied prompt, tools and result.
Run entries can be labeled **Completed**, **Error** or **Running** according to their recorded state.
These are passive copies of earlier task details, rather than controls that create another run.

The list comes from earlier loaded conversation messages matching that native identity,
with rebuilt context excluded. It does not search every past session or establish a complete task history.
If the section is absent, do not infer that no earlier run existed.
The displayed history is not a guarantee that every earlier run remains available after a restart.

Use the current task's own status and result when checking its outcome;
an earlier run's result belongs to that earlier run.
