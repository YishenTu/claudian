# Inspecting response work

A response can contain explanation, tool activity, thinking and a final answer.
Some of this content appears inside expandable sections rather than staying fully expanded.
The English labels below are examples; labels follow the interface language.

## Expand completed work

When a completed response is folded, its final trailing answer stays visible outside the work section.
Look for **Worked** or a duration such as **Worked for 01:05** above the answer.
The work duration uses minutes and seconds.

1. Activate the work header to show its contents.
2. Inspect the explanation, tool activity and any nested sections.
3. Activate the header again to close it.

Keyboard users can Tab to the work button and activate it with **Enter** or **Space**.
Earlier explanatory text before a tool can be inside this section, not just tool cards.
Work can also include earlier segments of the response.
If an explanation seems absent, expand the work header before looking for it in the final answer.
Not every response has a work section.

## Open nested thinking and notifications

After opening work, a **Thought** or **Thought for 12s** header may still be collapsed.
Activate that header separately to inspect the thinking text supplied by the provider.
Its keyboard control supports **Enter** and **Space** when focused.

Thinking collapses when it finishes; reopen the section if you want to inspect it.
Only provider-supplied thinking can be shown, not guaranteed complete or private reasoning.
Providers do not necessarily expose the same information.

A **Task notification** can also have its own disclosure.
Opening the outer work section does not automatically expand every nested section.
Thinking or notification Markdown may be formatted on its first expansion.
This presents content already supplied; expanding it does not start another agent run.

## Inspect interrupted output

An **Interrupted · What should Claudian do instead?** header may contain an interrupted turn's partial text and work.
Expand it to inspect what was produced before interruption.
Treat that output as partial work, not a completed final answer.

A bare stop indicator can remain visible without an expandable section.
Other unsuccessful output can remain expanded instead of appearing under Worked.
Use the content and status of the particular response rather than assuming every error is folded.

## Presentation limits

Expansion controls help inspect the displayed transcript; they do not change response grouping or compaction behavior.
Do not rely on expansion state being saved across reloads.
