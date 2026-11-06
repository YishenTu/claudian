# Approvals and questions

An agent can ask for permission to perform an action or ask you to choose an answer.
Return to the conversation that owns the request and inspect its panel before responding.
Answer with the controls in that panel; typing in the ordinary composer does not select a panel response.

## Respond to an approval

A **Permission required** panel asks **Allow this action?** and identifies the tool and action.
Read the action details and any reason or path shown before selecting a decision.
For a long description, focus its details region and scroll to inspect the rest.

Select one of the decisions actually offered by the request.
An ordinary approval selection submits immediately; there is no separate **Submit answers** step.
The available decisions, their descriptions and their scope depend on the provider and request.
For example, **Allow once**, **Deny** or **Always allow** may appear, but they are not a universal set.

Do not infer permanent or global permission from the **Always allow** label alone.
Claude offers it when native permission updates are supplied and permitted for that request;
Claude Code owns those updates. A Codex command approval can use that label for approval for the session.
Other providers can supply their own native choices and labels.

## Answer questions and review them

A question panel can contain several questions, each with its own tab.
Read each question and its offered choices:

- A single-choice selection advances to the next question or the review tab.
- A multiple-choice question lets you select or deselect several options before moving on.
- A custom answer field appears only when the question allows it and that panel enables it.
  If it appears, enter your answer there.

Use the question tabs to revisit answers, and select **Submit** to open **Review your answers**.
The review lists each question and its current answer; select a review row to edit that answer.
Every question needs an answer before **Submit answers** becomes available.
After checking the review, select **Submit answers** to hand the answers back.

Where **Cancel** is offered, it abandons the unsubmitted response.
The provider determines how cancellation affects its request or turn.

## Watch for delivery feedback

Some question replies need an asynchronous handoff. During that handoff, the panel shows
**Sending...** and disables repeat submission. Wait for its delivery result.
If the panel remains with an error, review the retained answers and retry there when submission is available.
A request that has expired or been cancelled may no longer accept an answer.

If a notice says delivery could not be confirmed, Claudian has not requeued the answer,
to avoid sending it twice. Check subsequent conversation activity before deciding what to do next.
A dismissed panel does not by itself mean the agent has finished its work;
look for the agent's subsequent output or status.

## Return to a waiting request

Switching conversations or hiding the view does not answer a request.
Returning to the same still-live conversation can restore its pending panel and answer draft,
including a submission still in progress. Check that you are in the intended conversation before responding.
This is not a promise that pending requests survive a plugin restart or provider shutdown.

## Permission modes and Stop

The toolbar's permission-mode control is separate from an individual request.
It appears when the provider supplies permission-mode options and shows that provider's current mode label.
Read the offered mode descriptions; providers do not share a universal list of modes.
Changing a mode configures execution policy for its destination, rather than answering a waiting panel.

Use **Stop** to stop work in the selected destination when needed.
Do not assume it clears every waiting question: an unanswered asynchronous question can remain open,
while an answer still being submitted can be withdrawn. Later expiry or cancellation depends on the request.
Stopping also does not undo effects of tools that have already run.
