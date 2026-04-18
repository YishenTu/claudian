# Line-Range @mention Design

**Date:** 2026-04-18  
**Status:** Approved  
**Scope:** Option+K shortcut inserts `@filename#start-end` into input; send-time resolves mentioned lines into `<editor_selection>` XML.

---

## 1. Overview

Users can press **Option+K** (Mac) / **Alt+K** (Windows/Linux) when an editor has an active selection to insert a line-range mention like `@CLAUDE.md#9-15` into the chat input. At send time, Claudian reads the referenced lines from the vault and injects them as `<editor_selection path="..." lines="9-15">…content…</editor_selection>` into the prompt.

Manually typed `@file#line` syntax is **not** parsed — the `#` suffix is only recognised when inserted via the shortcut (enforced via a whitelist in `FileContextState`).

No rich-text highlighting of mention tokens in the textarea (deferred to a future task).

---

## 2. Data Structures

### 2.1 `LineRangeMention` (`src/utils/lineRangeMention.ts`)

```typescript
export interface LineRangeMention {
  filePath: string;    // vault-relative path, e.g. "CLAUDE.md"
  startLine: number;   // 1-indexed
  endLine: number;     // 1-indexed
  mentionText: string; // original token, e.g. "@CLAUDE.md#9-15"
}
```

### 2.2 `FileContextState` extensions

Add `lineRangeMentions: Map<string, { startLine: number; endLine: number }>` keyed by vault-relative file path. Only paths present in this map (inserted via Option+K) trigger line-content injection at send time.

New methods:
- `attachLineRangeMention(filePath, startLine, endLine): void`
- `removeLineRangeMention(filePath): void`
- `getLineRangeMentions(): Map<string, { startLine: number; endLine: number }>`
- Updated `resetForNewConversation()` and `resetForLoadedConversation()` to clear the map.

---

## 3. Option+K Shortcut

**Registration:** `ClaudianView.wireEventHandlers()`, alongside the existing `Shift+Tab` handler.

**Trigger condition:** `e.altKey && e.key === 'k'` (case-insensitive).

**Logic:**
1. Get `SelectionController.getContext()` from the active tab.
2. If `context === null` or `context.mode !== 'selection'` → do nothing.
3. Derive mention text:
   - `filename = basename(context.notePath)` (short name, e.g. `CLAUDE.md`)
   - `start = context.startLine` (1-indexed, already in `EditorSelectionContext`)
   - `end = start + (context.lineCount ?? 1) - 1`
   - `mentionText = "@" + filename + "#" + start + "-" + end`
4. Insert into textarea:
   - If textarea value is non-empty and doesn't end with whitespace, prepend a space.
   - Append `mentionText + " "`.
   - Move cursor to end.
   - Dispatch `input` event so `FileContextManager.handleInputChange()` picks up the change.
5. Register the line-range whitelist:
   - Call `fileContextManager.attachLineRangeMention(context.notePath, start, end)`.
   - Also call the existing `attachFile(context.notePath)` so the file appears in `attachedFiles`.

**Edge cases:**
- No active tab or no file context manager → silently do nothing.
- `startLine` is undefined in context → do nothing (treat as no selection).

---

## 4. Send-Time Resolution

### 4.1 New utility: `resolveLineRangeMentions`  (`src/utils/lineRangeMention.ts`)

```typescript
export async function resolveLineRangeMentions(
  prompt: string,
  lineRangeMentions: Map<string, { startLine: number; endLine: number }>,
  readFile: (filePath: string) => Promise<string>,
): Promise<string>
```

Steps:
1. If `lineRangeMentions` is empty, return `prompt` unchanged.
2. For each `(filePath, { startLine, endLine })` entry in the map:
   a. Build the expected mention token: `@basename#start-end` and `@basename#start-end` with full path variant.
   b. Read file content via `readFile(filePath)`.
   c. Split by `\n`, extract lines `[startLine-1, endLine]` (0-indexed slice).
   d. Format as `<editor_selection path="${filePath}" lines="${startLine}-${endLine}">\n${selectedText}\n</editor_selection>`.
   e. Append to prompt with `\n\n` separator (same pattern as `appendEditorContext`).
3. Return the augmented prompt.

The function does **not** remove the `@filename#start-end` token from the user-visible prompt — the token stays in the persisted content as the user typed it; only the injected XML block is added at the end.

### 4.2 Integration points

**Claude:** `encodeClaudeTurn` in `ClaudeTurnEncoder.ts` becomes `async` and calls `resolveLineRangeMentions` after the existing context appends, before MCP mention extraction. The `lineRangeMentions` map is passed in via `ChatTurnRequest`. Because `prepareTurn` on `ChatRuntime` is currently synchronous, the resolution is instead done in `InputController` before calling `prepareTurn` — `InputController.buildTurnRequest()` calls `resolveLineRangeMentions` and stores the augmented prompt back into the request, keeping `prepareTurn` synchronous.

**Codex:** Same approach — `InputController` resolves before handing off to `CodexChatRuntime.prepareTurn`.

**`ChatTurnRequest`** (`src/core/runtime/types.ts`): add optional field `lineRangeMentions?: Map<string, { startLine: number; endLine: number }>`.

**`InputController`**: when building `ChatTurnRequest`, pass `fileContextManager.getLineRangeMentions()` as `lineRangeMentions`. After send, call `fileContextManager.resetLineRangeMentions()` (or it resets with `resetForNewConversation`).

---

## 5. `EditorSelectionContext` completeness check

`startLine` is already defined as `number | undefined` (1-indexed) in `src/utils/editor.ts:32`. The `SelectionController` must populate it when mode is `'selection'`. Verify this is done; if not, add it in `SelectionController.poll()`.

---

## 6. Error Handling

- If `readFile` throws (file deleted between insert and send): skip that mention silently, do not inject XML. Log nothing (no `console.*` in prod).
- If line range is out of bounds (file shorter than `endLine`): clamp to available lines and still inject.

---

## 7. Testing

Mirror under `tests/unit/utils/lineRangeMention.test.ts`:
- `resolveLineRangeMentions` with empty map → prompt unchanged.
- Single mention → correct XML appended.
- Multiple mentions → all XML blocks appended.
- Out-of-bounds line range → clamped content injected.
- File read error → prompt unchanged (no throw).

Mirror under `tests/unit/features/chat/ui/file-context/state/FileContextState.test.ts` (extend existing):
- `attachLineRangeMention` / `removeLineRangeMention` round-trip.
- `resetForNewConversation` clears line range map.

No integration tests needed for the shortcut (DOM event testing is out of scope for this codebase's integration suite).

---

## 8. Out of Scope

- Rich-text highlighting of `@mention` tokens in textarea (deferred).
- Manual `@file#line` parsing from typed text.
- Single-line `@file#9` mention (only ranges from selections; cursor-only → do nothing).
- Codex-specific line-range history reload or fork handling.
