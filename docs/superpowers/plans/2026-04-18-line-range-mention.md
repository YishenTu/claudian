# Line-Range @mention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to press Option+K (Alt+K on Windows/Linux) when an editor has a selection to insert `@filename#start-end` into the chat input, which at send time resolves to injected line content as `<editor_selection>` XML.

**Architecture:** New `resolveLineRangeMentions` utility reads vault file lines at send time using a whitelist in `FileContextState`. The shortcut is registered in `ClaudianView.wireEventHandlers`. `InputController.buildTurnSubmission` passes the line-range map into `ChatTurnRequest`, which is then resolved before `prepareTurn` is called.

**Tech Stack:** TypeScript, Obsidian API (`app.vault.read`, `MarkdownView`), existing `EditorSelectionContext` (already has `startLine`/`lineCount`).

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/utils/lineRangeMention.ts` | `LineRangeMention` type + `resolveLineRangeMentions` function |
| Modify | `src/features/chat/ui/file-context/state/FileContextState.ts` | Add line-range whitelist map + CRUD methods |
| Modify | `src/core/runtime/types.ts` | Add `lineRangeMentions` field to `ChatTurnRequest` |
| Modify | `src/features/chat/ClaudianView.ts` | Register Alt+K keydown handler |
| Modify | `src/features/chat/controllers/InputController.ts` | Pass line-range map in `buildTurnSubmission`; call resolver before `prepareTurn` |
| Create | `tests/unit/utils/lineRangeMention.test.ts` | Unit tests for `resolveLineRangeMentions` |
| Modify | `tests/unit/features/chat/ui/file-context/state/FileContextState.test.ts` | Tests for new line-range state methods |

---

## Task 1: Create `lineRangeMention` utility with tests (TDD)

**Files:**
- Create: `src/utils/lineRangeMention.ts`
- Create: `tests/unit/utils/lineRangeMention.test.ts`

- [ ] **Step 1.1: Write failing tests**

Create `tests/unit/utils/lineRangeMention.test.ts`:

```typescript
import { resolveLineRangeMentions } from '@/utils/lineRangeMention';

describe('resolveLineRangeMentions', () => {
  const makeReadFile = (content: string) =>
    (_path: string) => Promise.resolve(content);

  it('returns prompt unchanged when map is empty', async () => {
    const result = await resolveLineRangeMentions(
      'hello world',
      new Map(),
      makeReadFile('line1\nline2\nline3')
    );
    expect(result).toBe('hello world');
  });

  it('appends editor_selection XML for a single mention', async () => {
    const fileContent = 'line1\nline2\nline3\nline4\nline5';
    const map = new Map([['notes/foo.md', { startLine: 2, endLine: 4 }]]);
    const result = await resolveLineRangeMentions(
      'check this @foo.md#2-4',
      map,
      makeReadFile(fileContent)
    );
    expect(result).toBe(
      'check this @foo.md#2-4\n\n' +
      '<editor_selection path="notes/foo.md" lines="2-4">\n' +
      'line2\nline3\nline4\n' +
      '</editor_selection>'
    );
  });

  it('appends multiple XML blocks for multiple mentions', async () => {
    const map = new Map([
      ['a.md', { startLine: 1, endLine: 2 }],
      ['b.md', { startLine: 3, endLine: 3 }],
    ]);
    const readFile = (path: string) =>
      path === 'a.md'
        ? Promise.resolve('a1\na2\na3')
        : Promise.resolve('b1\nb2\nb3');

    const result = await resolveLineRangeMentions('prompt', map, readFile);
    expect(result).toContain('<editor_selection path="a.md" lines="1-2">');
    expect(result).toContain('<editor_selection path="b.md" lines="3-3">');
  });

  it('clamps endLine when it exceeds file length', async () => {
    const map = new Map([['x.md', { startLine: 3, endLine: 99 }]]);
    const result = await resolveLineRangeMentions(
      'prompt',
      map,
      makeReadFile('l1\nl2\nl3')
    );
    expect(result).toContain('lines="3-3"');
    expect(result).toContain('l3');
    expect(result).not.toContain('undefined');
  });

  it('returns prompt unchanged when readFile throws', async () => {
    const map = new Map([['missing.md', { startLine: 1, endLine: 2 }]]);
    const readFile = () => Promise.reject(new Error('file not found'));
    const result = await resolveLineRangeMentions('prompt', map, readFile);
    expect(result).toBe('prompt');
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
npm run test -- --selectProjects unit --testPathPattern lineRangeMention
```

Expected: FAIL — module not found.

- [ ] **Step 1.3: Implement `src/utils/lineRangeMention.ts`**

```typescript
export interface LineRangeMention {
  filePath: string;
  startLine: number;
  endLine: number;
}

export async function resolveLineRangeMentions(
  prompt: string,
  lineRangeMentions: Map<string, { startLine: number; endLine: number }>,
  readFile: (filePath: string) => Promise<string>,
): Promise<string> {
  if (lineRangeMentions.size === 0) return prompt;

  const blocks: string[] = [];

  for (const [filePath, { startLine, endLine }] of lineRangeMentions) {
    let content: string;
    try {
      content = await readFile(filePath);
    } catch {
      continue;
    }

    const lines = content.split('\n');
    const clampedEnd = Math.min(endLine, lines.length);
    const selectedLines = lines.slice(startLine - 1, clampedEnd);
    const selectedText = selectedLines.join('\n');

    blocks.push(
      `<editor_selection path="${filePath}" lines="${startLine}-${clampedEnd}">\n${selectedText}\n</editor_selection>`
    );
  }

  if (blocks.length === 0) return prompt;
  return `${prompt}\n\n${blocks.join('\n\n')}`;
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
npm run test -- --selectProjects unit --testPathPattern lineRangeMention
```

Expected: All 5 tests PASS.

- [ ] **Step 1.5: Commit**

```bash
git add src/utils/lineRangeMention.ts tests/unit/utils/lineRangeMention.test.ts
git commit -m "feat: add resolveLineRangeMentions utility"
```

---

## Task 2: Extend `FileContextState` with line-range whitelist

**Files:**
- Modify: `src/features/chat/ui/file-context/state/FileContextState.ts`
- Modify: `tests/unit/features/chat/ui/file-context/state/FileContextState.test.ts`

- [ ] **Step 2.1: Write failing tests**

Append to the existing test file `tests/unit/features/chat/ui/file-context/state/FileContextState.test.ts`:

```typescript
  describe('line-range mentions', () => {
    it('starts with empty line range map', () => {
      expect(state.getLineRangeMentions().size).toBe(0);
    });

    it('stores a line range mention', () => {
      state.attachLineRangeMention('CLAUDE.md', 9, 15);
      const map = state.getLineRangeMentions();
      expect(map.get('CLAUDE.md')).toEqual({ startLine: 9, endLine: 15 });
    });

    it('overwrites an existing entry for the same file', () => {
      state.attachLineRangeMention('CLAUDE.md', 1, 5);
      state.attachLineRangeMention('CLAUDE.md', 9, 15);
      expect(state.getLineRangeMentions().get('CLAUDE.md')).toEqual({ startLine: 9, endLine: 15 });
    });

    it('removes a line range mention', () => {
      state.attachLineRangeMention('CLAUDE.md', 9, 15);
      state.removeLineRangeMention('CLAUDE.md');
      expect(state.getLineRangeMentions().size).toBe(0);
    });

    it('clears line range mentions on resetForNewConversation', () => {
      state.attachLineRangeMention('CLAUDE.md', 9, 15);
      state.resetForNewConversation();
      expect(state.getLineRangeMentions().size).toBe(0);
    });

    it('clears line range mentions on resetForLoadedConversation', () => {
      state.attachLineRangeMention('CLAUDE.md', 9, 15);
      state.resetForLoadedConversation(true);
      expect(state.getLineRangeMentions().size).toBe(0);
    });

    it('returns a copy so external mutations do not affect internal state', () => {
      state.attachLineRangeMention('CLAUDE.md', 9, 15);
      const map = state.getLineRangeMentions();
      map.clear();
      expect(state.getLineRangeMentions().size).toBe(1);
    });
  });
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
npm run test -- --selectProjects unit --testPathPattern FileContextState
```

Expected: FAIL — `attachLineRangeMention` is not a function.

- [ ] **Step 2.3: Implement changes in `FileContextState.ts`**

Add the private field and methods. The full updated file (only showing additions, keep existing code intact):

Add after `private mentionedMcpServers: Set<string> = new Set();`:
```typescript
  private lineRangeMentions: Map<string, { startLine: number; endLine: number }> = new Map();
```

Add after `addMentionedMcpServer`:
```typescript
  getLineRangeMentions(): Map<string, { startLine: number; endLine: number }> {
    return new Map(this.lineRangeMentions);
  }

  attachLineRangeMention(filePath: string, startLine: number, endLine: number): void {
    this.lineRangeMentions.set(filePath, { startLine, endLine });
  }

  removeLineRangeMention(filePath: string): void {
    this.lineRangeMentions.delete(filePath);
  }
```

In `resetForNewConversation()`, add `this.lineRangeMentions.clear();`

In `resetForLoadedConversation()`, add `this.lineRangeMentions.clear();`

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
npm run test -- --selectProjects unit --testPathPattern FileContextState
```

Expected: All tests PASS.

- [ ] **Step 2.5: Commit**

```bash
git add src/features/chat/ui/file-context/state/FileContextState.ts \
        tests/unit/features/chat/ui/file-context/state/FileContextState.test.ts
git commit -m "feat: add line-range mention whitelist to FileContextState"
```

---

## Task 3: Add `lineRangeMentions` to `ChatTurnRequest` and expose from `FileContextManager`

**Files:**
- Modify: `src/core/runtime/types.ts`
- Modify: `src/features/chat/ui/FileContext.ts`

No new tests needed — this is plumbing only; behavior is tested in Tasks 1 and 2.

- [ ] **Step 3.1: Add field to `ChatTurnRequest`**

In `src/core/runtime/types.ts`, add to the `ChatTurnRequest` interface after `enabledMcpServers`:

```typescript
  lineRangeMentions?: Map<string, { startLine: number; endLine: number }>;
```

- [ ] **Step 3.2: Expose `getLineRangeMentions` from `FileContextManager`**

In `src/features/chat/ui/FileContext.ts`, add after `getMentionedMcpServers()`:

```typescript
  getLineRangeMentions(): Map<string, { startLine: number; endLine: number }> {
    return this.state.getLineRangeMentions();
  }

  attachLineRangeMention(filePath: string, startLine: number, endLine: number): void {
    this.state.attachLineRangeMention(filePath, startLine, endLine);
  }
```

- [ ] **Step 3.3: Typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 3.4: Commit**

```bash
git add src/core/runtime/types.ts src/features/chat/ui/FileContext.ts
git commit -m "feat: add lineRangeMentions to ChatTurnRequest and FileContextManager"
```

---

## Task 4: Wire line-range map into `InputController.buildTurnSubmission` and resolve before send

**Files:**
- Modify: `src/features/chat/controllers/InputController.ts`

- [ ] **Step 4.1: Pass `lineRangeMentions` in `buildTurnSubmission`**

In `src/features/chat/controllers/InputController.ts`, inside `buildTurnSubmission`, after `const enabledMcpServers = mcpServerSelector?.getEnabledServers();`:

```typescript
    const lineRangeMentions = fileContextManager?.getLineRangeMentions();
```

Then in the returned `turnRequest` object, add after `enabledMcpServers`:

```typescript
        lineRangeMentions: lineRangeMentions && lineRangeMentions.size > 0
          ? lineRangeMentions
          : undefined,
```

- [ ] **Step 4.2: Resolve line-range mentions before `prepareTurn`**

Find the `sendMessage` private method. Locate where `buildTurnSubmission` is called, then where `runtime.prepareTurn(turnRequest)` is called.

Import the resolver at the top of the file:

```typescript
import { resolveLineRangeMentions } from '../../../utils/lineRangeMention';
```

After `buildTurnSubmission` returns `{ displayContent, turnRequest }` and before `runtime.prepareTurn`, add:

```typescript
    if (turnRequest.lineRangeMentions && turnRequest.lineRangeMentions.size > 0) {
      const vault = this.deps.plugin.app.vault;
      const resolvedText = await resolveLineRangeMentions(
        turnRequest.text,
        turnRequest.lineRangeMentions,
        (filePath) => vault.adapter.read(filePath),
      );
      turnRequest = { ...turnRequest, text: resolvedText };
    }
```

Note: `sendMessage` is already async, so `await` is valid here. `vault.adapter.read` reads vault-relative paths.

- [ ] **Step 4.3: Typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 4.4: Commit**

```bash
git add src/features/chat/controllers/InputController.ts
git commit -m "feat: resolve line-range mentions at send time in InputController"
```

---

## Task 5: Register Alt+K shortcut in `ClaudianView`

**Files:**
- Modify: `src/features/chat/ClaudianView.ts`

- [ ] **Step 5.1: Add the keydown handler**

In `src/features/chat/ClaudianView.ts`, inside `wireEventHandlers()`, after the `Shift+Tab` handler block (after the closing `}`  of that handler, before the `// Register Escape` comment), add:

```typescript
    // Alt+K (Option+K on Mac): insert a line-range @mention from the current editor selection
    this.registerDomEvent(this.containerEl, 'keydown', (e: KeyboardEvent) => {
      if (!e.altKey || e.key.toLowerCase() !== 'k' || e.isComposing) return;

      const activeTab = this.tabManager?.getActiveTab();
      if (!activeTab) return;

      const selectionController = activeTab.controllers.selectionController;
      const fileContextManager = activeTab.ui.fileContextManager;
      const inputEl = activeTab.dom.inputEl;
      if (!selectionController || !fileContextManager || !inputEl) return;

      const ctx = selectionController.getContext();
      if (!ctx || ctx.mode !== 'selection' || ctx.startLine === undefined) return;

      const filename = ctx.notePath.split('/').pop() ?? ctx.notePath;
      const start = ctx.startLine;
      const end = start + (ctx.lineCount ?? 1) - 1;
      const mentionText = `@${filename}#${start}-${end}`;

      const current = inputEl.value;
      const needsSpace = current.length > 0 && !/\s$/.test(current);
      inputEl.value = current + (needsSpace ? ' ' : '') + mentionText + ' ';
      inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;

      fileContextManager.attachFile(ctx.notePath);
      fileContextManager.attachLineRangeMention(ctx.notePath, start, end);

      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.focus();

      e.preventDefault();
    });
```

- [ ] **Step 5.2: Typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 5.3: Run full test suite**

```bash
npm run test -- --selectProjects unit
```

Expected: All tests PASS.

- [ ] **Step 5.4: Build**

```bash
npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 5.5: Commit**

```bash
git add src/features/chat/ClaudianView.ts
git commit -m "feat: register Alt+K shortcut to insert line-range @mention"
```

---

## Task 6: Verify `sendMessage` call sites and `buildTurnSubmission` mutability

The `buildTurnSubmission` method returns `{ displayContent, turnRequest }`. In Task 4, we reassign `turnRequest` after resolution. Verify the local variable is declared with `let` (not `const`) in the call site that precedes `prepareTurn`.

**Files:**
- Modify: `src/features/chat/controllers/InputController.ts` (if needed)

- [ ] **Step 6.1: Check declaration**

In `InputController.ts`, find `const { displayContent, turnRequest } = this.buildTurnSubmission(...)`. If it's `const`, change it to:

```typescript
    let { displayContent, turnRequest } = this.buildTurnSubmission(options);
```

- [ ] **Step 6.2: Typecheck and test**

```bash
npm run typecheck && npm run test -- --selectProjects unit
```

Expected: No errors, all tests pass.

- [ ] **Step 6.3: Commit if changed**

```bash
git add src/features/chat/controllers/InputController.ts
git commit -m "fix: use let for turnRequest to allow line-range resolution mutation"
```

---

## Task 7: Final verification

- [ ] **Step 7.1: Full typecheck + lint + test + build**

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

Expected: All pass. Fix any lint or type errors before proceeding.

- [ ] **Step 7.2: Manual smoke test**

1. Open Obsidian with the plugin loaded.
2. Open any Markdown file, select lines 9-15.
3. Focus the Claudian input, press **Option+K** (or **Alt+K**).
4. Verify `@filename#9-15 ` is inserted into the input.
5. Send the message.
6. In the persisted Claude transcript (under `~/.claude/`), verify the message contains `<editor_selection path="..." lines="9-15">` with the correct line content.
7. Test with no selection — press Alt+K with cursor only — verify nothing is inserted.
8. Test manual typing `@file#1-5` without using the shortcut — verify at send time the `#1-5` is NOT resolved (no XML injected).

- [ ] **Step 7.3: Create feature branch if not already on one**

```bash
git checkout -b feat/line-range-mention
```

Or if already on a feature branch, push:

```bash
git push -u origin HEAD
```
