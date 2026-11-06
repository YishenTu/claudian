# File edit results

File-changing tools such as Write, Edit and patch operations can show result cards in the conversation.
Use these cards to inspect the reported operation, then check the current file separately when needed.
The details available depend on the tool and the data supplied by its provider.

## Inspect a result

Find the tool card in the conversation; expand its surrounding work section first if necessary.
Check the tool's status and any error or verification message before interpreting its diff.
Click the card header to disclose its body, or focus the header and press Enter or Space.
The header shows a file summary and can include counts such as `+3` and `-2`.
Those counts describe inserted and removed lines, rather than words or numbers of files.

Expanding a result inspects an operation that has already been attempted.
It does not execute another file write, apply the displayed changes or undo them.
These result cards do not provide Inline Edit's **Accept** and **Reject** controls.
The disclosure header is not an **Open file** action.

## Read the diff in context

In the body, `+` marks inserted lines, `-` marks removed lines, and a space marks supplied context.
Changes can be grouped into hunks, with `...` between separated groups.
The renderer normally includes up to three supplied context lines on either side of a change.
It cannot show surrounding original text that was not supplied with the diff.

For Write and Edit, a provider-supplied result diff takes precedence when available.
Otherwise, an Edit diff can be derived from the old and new replacement text in the tool input.
A Write fallback treats its supplied content entirely as additions, even when overwriting an existing file.
An all-additions card therefore does not establish that a new file was created or show a complete before/after comparison.
The card renderer does not independently reread the file from disk.

If every diff line is an insertion and there are more than 20 lines, the card displays the first 20
followed by a remaining-line count. There is no load-more control for those omitted diff lines.
This also applies to an all-additions Write fallback for an existing file.
Mixed diffs containing removals or context do not have that same 20-line cap.
Raw patch text and error/result fallbacks can have different display limits.

## Inspect patch groups and errors

Patch details can group changes by full file path and show a source-to-destination path for a move.
A group can show **File deleted** or **No text diff** when the supplied operation has no text lines to render.
When parsed diffs are unavailable, the body may instead list paths, show raw patch text or show result text.

An attempted patch diff can appear alongside a failure message; read both before drawing conclusions.
Write or Edit without usable diff data may show **DONE** or an error instead.
A missing diff does not establish that no file changed, and a displayed diff does not verify the current disk contents.

## Check the current file and choose a display default

For a vault file, use Obsidian's normal file navigation or search to locate the corresponding file
and inspect its complete current contents. The file may have changed since the reported operation.
Use the path information in patch groups to distinguish files with the same name.

In **Settings → Claudian → General → Display**, **Expand file edits by default** controls the initial
presentation of recognized file-edit and patch cards, unless an explicit rendering state overrides it.
It is off by default. You can still toggle individual card headers manually.
This preference changes presentation; it does not approve tool operations or accept proposed edits.
