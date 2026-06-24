# Prompt Library Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an in-app local "prompt library" — create, edit, delete preset prompts from a toolbar panel, and insert a chosen prompt into the chat input box (editable before sending).

**Architecture:** A provider-neutral `PromptLibraryStorage` reads/writes `.claudian/prompts.json` via the existing `VaultFileAdapter`, exposed through `SharedAppStorage`. A toolbar button (added to `createInputToolbar`) opens a popover `PromptLibraryPanel` that lists/searches prompts and supports inline CRUD. Selecting a prompt calls an `onInsert(content)` callback that fills the tab's `textarea`.

**Tech Stack:** TypeScript, Obsidian plugin APIs (DOM `createDiv`/`setIcon`, `Notice`, `Modal`), Jest unit tests, modular CSS under `src/style/`.

**Confirmed design decisions (from brainstorm):**
- Selecting a prompt **replaces** the current input draft (then editable before send).
- Open via a **toolbar button** in the input toolbar.
- Create/edit/delete all happen **inside the popover panel** (no settings tab).
- Data model: `{ id, name, content, updatedAt }` only — no categories/tags (YAGNI).
- Storage: dedicated `.claudian/prompts.json`, provider-neutral.

**Key integration facts (verified):**
- `VaultFileAdapter` (`src/core/storage/VaultFileAdapter.ts`): `exists / read / write / ensureFolder`; `write` auto-creates parent folders.
- `StoragePaths` (`src/core/bootstrap/StoragePaths.ts`): path constants; `CLAUDIAN_STORAGE_PATH = '.claudian'`.
- `SharedAppStorage` interface (`src/core/bootstrap/storage.ts:13`) + `SharedStorageService` (`src/app/storage/SharedStorageService.ts:14`): the shared storage surface; `plugin.storage` (main.ts:52) is the instance.
- Toolbar built by `createInputToolbar(parentEl, callbacks)` (`src/features/chat/ui/InputToolbar.ts:1212`); `ToolbarCallbacks` interface at line 49. Per-tab call site at `src/features/chat/tabs/Tab.ts:825`.
- Tab DOM: `dom.inputEl` (`HTMLTextAreaElement`), `dom.inputContainerEl`, `dom.inputWrapper` (Tab.ts ~538-543). Existing "set input" pattern: `InputController.restoreMessageToInput` (InputController.ts:647) → `inputEl.value = ...; resetInputHeight(); inputEl.focus();`.
- Confirm dialog: `confirmDelete(app, message): Promise<boolean>` (`src/shared/modals/ConfirmModal.ts`).
- i18n: `import { t } from '../../../i18n/i18n'`; locales are JSON in `src/i18n/locales/` (10 files); `TranslationKey` is keyed off `en.json`.
- uuid: `crypto.randomUUID()` (used in `src/utils/env.ts`).
- CSS aggregated via `@import` in `src/style/index.css` (read by `scripts/build-css.mjs`); toolbar styles live in `src/style/toolbar/`.

**Verify after each task:** `npm run typecheck && npm run lint` (fast feedback). Full gate before done: `npm run typecheck && npm run lint && npm run test && npm run build`.

---

### Task 1: Storage path constant

**Files:**
- Modify: `src/core/bootstrap/StoragePaths.ts`

**Step 1: Add the constant**

Append after the `SESSIONS_PATH` line:

```ts
export const PROMPTS_PATH = `${CLAUDIAN_STORAGE_PATH}/prompts.json`;
```

**Step 2: Verify**

Run: `npm run typecheck`
Expected: PASS (no errors).

**Step 3: Commit**

```bash
git add src/core/bootstrap/StoragePaths.ts
git commit -m "feat(prompts): add prompts.json storage path constant"
```

---

### Task 2: PromptLibraryStorage (TDD)

**Files:**
- Create: `src/core/storage/PromptLibraryStorage.ts`
- Test: `tests/unit/core/storage/PromptLibraryStorage.test.ts`

**Step 1: Write the failing tests**

Mirror the mock pattern from `tests/unit/providers/claude/storage/SessionStorage.test.ts` (jest.Mocked<VaultFileAdapter>).

```ts
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { PROMPTS_PATH } from '@/core/bootstrap/StoragePaths';
import { PromptLibraryStorage, type StoredPrompt } from '@/core/storage/PromptLibraryStorage';

describe('PromptLibraryStorage', () => {
  let mockAdapter: jest.Mocked<VaultFileAdapter>;
  let storage: PromptLibraryStorage;

  beforeEach(() => {
    mockAdapter = {
      exists: jest.fn(),
      read: jest.fn(),
      write: jest.fn(),
      delete: jest.fn(),
      listFiles: jest.fn(),
    } as unknown as jest.Mocked<VaultFileAdapter>;
    storage = new PromptLibraryStorage(mockAdapter);
  });

  describe('PROMPTS_PATH', () => {
    it('is .claudian/prompts.json', () => {
      expect(PROMPTS_PATH).toBe('.claudian/prompts.json');
    });
  });

  describe('load', () => {
    it('returns empty array when file is missing', async () => {
      mockAdapter.exists.mockResolvedValue(false);
      await expect(storage.load()).resolves.toEqual([]);
      expect(mockAdapter.read).not.toHaveBeenCalled();
    });

    it('returns parsed prompts', async () => {
      const prompts: StoredPrompt[] = [
        { id: 'a', name: 'Summarize', content: 'Summarize this:', updatedAt: 1 },
      ];
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify(prompts));
      await expect(storage.load()).resolves.toEqual(prompts);
    });

    it('filters out malformed entries', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify([
        { id: 'a', name: 'OK', content: 'c', updatedAt: 1 },
        { id: 'b', name: 'no content' },
        'not-an-object',
        null,
      ]));
      const result = await storage.load();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('a');
    });

    it('returns empty array on corrupt JSON', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue('{ not json');
      await expect(storage.load()).resolves.toEqual([]);
    });

    it('returns empty array when payload is not an array', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({ id: 'x' }));
      await expect(storage.load()).resolves.toEqual([]);
    });
  });

  describe('save', () => {
    it('writes JSON array to PROMPTS_PATH', async () => {
      const prompts: StoredPrompt[] = [
        { id: 'a', name: 'N', content: 'C', updatedAt: 9 },
      ];
      await storage.save(prompts);
      expect(mockAdapter.write).toHaveBeenCalledWith(PROMPTS_PATH, expect.any(String));
      const written = mockAdapter.write.mock.calls[0][1];
      expect(JSON.parse(written)).toEqual(prompts);
    });

    it('drops malformed entries before writing', async () => {
      await storage.save([
        { id: 'a', name: 'N', content: 'C', updatedAt: 1 },
        { id: 'b' } as unknown as StoredPrompt,
      ]);
      const written = JSON.parse(mockAdapter.write.mock.calls[0][1]);
      expect(written).toHaveLength(1);
      expect(written[0].id).toBe('a');
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- --selectProjects unit -- PromptLibraryStorage`
Expected: FAIL ("Cannot find module '@/core/storage/PromptLibraryStorage'").

**Step 3: Write the implementation**

```ts
// src/core/storage/PromptLibraryStorage.ts
import { PROMPTS_PATH } from '../bootstrap/StoragePaths';
import type { VaultFileAdapter } from './VaultFileAdapter';

export interface StoredPrompt {
  id: string;
  name: string;
  content: string;
  updatedAt: number;
}

export function isStoredPrompt(value: unknown): value is StoredPrompt {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string'
    && typeof v.name === 'string'
    && typeof v.content === 'string'
    && typeof v.updatedAt === 'number';
}

export class PromptLibraryStorage {
  constructor(private adapter: VaultFileAdapter) {}

  async load(): Promise<StoredPrompt[]> {
    if (!(await this.adapter.exists(PROMPTS_PATH))) return [];
    try {
      const raw = await this.adapter.read(PROMPTS_PATH);
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isStoredPrompt);
    } catch {
      return [];
    }
  }

  async save(prompts: StoredPrompt[]): Promise<void> {
    const clean = prompts.filter(isStoredPrompt);
    await this.adapter.write(PROMPTS_PATH, JSON.stringify(clean, null, 2));
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run test -- --selectProjects unit -- PromptLibraryStorage`
Expected: PASS (all 8 tests).

**Step 5: Verify + commit**

```bash
npm run typecheck && npm run lint
git add src/core/storage/PromptLibraryStorage.ts tests/unit/core/storage/PromptLibraryStorage.test.ts
git commit -m "feat(prompts): add PromptLibraryStorage with load/save + validation"
```

---

### Task 3: Expose prompts on SharedAppStorage

**Files:**
- Modify: `src/core/bootstrap/storage.ts` (interface)
- Modify: `src/app/storage/SharedStorageService.ts` (implementation)

**Step 1: Add to the interface**

In `src/core/bootstrap/storage.ts`, add the import and the field:

```ts
import type { PromptLibraryStorage } from '../storage/PromptLibraryStorage';
```
```ts
export interface SharedAppStorage {
  initialize(): Promise<{ claudian: Record<string, unknown> }>;
  saveClaudianSettings(settings: Record<string, unknown>): Promise<void>;
  setTabManagerState(state: AppTabManagerState): Promise<void>;
  getTabManagerState(): AppTabManagerState | null;
  sessions: AppSessionStorage;
  prompts: PromptLibraryStorage;   // <-- add
  getAdapter(): VaultFileAdapter;
}
```

**Step 2: Wire into the service**

In `src/app/storage/SharedStorageService.ts`:

- Import: `import { PromptLibraryStorage } from '../../core/storage/PromptLibraryStorage';`
- Add field: `readonly prompts: PromptLibraryStorage;`
- In the constructor, after `this.sessions = new SessionStorage(this.adapter);`:
  ```ts
  this.prompts = new PromptLibraryStorage(this.adapter);
  ```

**Step 3: Verify + commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

```bash
git add src/core/bootstrap/storage.ts src/app/storage/SharedStorageService.ts
git commit -m "feat(prompts): expose PromptLibraryStorage on SharedAppStorage"
```

---

### Task 4: i18n keys

**Files:**
- Modify: all 10 locale files in `src/i18n/locales/` (`en.json`, `zh-CN.json`, `zh-TW.json`, `de.json`, `es.json`, `fr.json`, `ja.json`, `ko.json`, `pt.json`, `ru.json`)

**Step 1: Check the TranslationKey contract**

Open `src/i18n/types.ts` and `src/i18n/i18n.ts` to confirm how `TranslationKey` is derived (almost certainly `keyof typeof enLocale`). Confirm missing-key fallback behavior. Add keys to **all** locales so no locale is missing keys.

**Step 2: Add `prompts` group to `en.json`**

Add a top-level `"prompts"` object (place it near other feature groups, e.g. after `"common"` or alongside `"chat"`):

```json
"prompts": {
  "title": "Prompts",
  "searchPlaceholder": "Search prompts",
  "new": "New prompt",
  "edit": "Edit",
  "name": "Name",
  "content": "Content",
  "save": "Save",
  "cancel": "Cancel",
  "delete": "Delete",
  "deleteConfirm": "Delete this prompt?",
  "empty": "No prompts yet. Create one to get started.",
  "namePlaceholder": "Prompt name",
  "contentPlaceholder": "Prompt content…",
  "loadError": "Failed to load prompts",
  "saveError": "Failed to save prompt"
}
```

**Step 3: Add the same keys to `zh-CN.json` (translated)**

```json
"prompts": {
  "title": "提示词",
  "searchPlaceholder": "搜索提示词",
  "new": "新建提示词",
  "edit": "编辑",
  "name": "名称",
  "content": "内容",
  "save": "保存",
  "cancel": "取消",
  "delete": "删除",
  "deleteConfirm": "确定删除这个提示词吗？",
  "empty": "还没有提示词，新建一个开始吧。",
  "namePlaceholder": "提示词名称",
  "contentPlaceholder": "提示词内容…",
  "loadError": "加载提示词失败",
  "saveError": "保存提示词失败"
}
```

**Step 4: Add the same keys (English placeholders) to the other 8 locales**

Copy the `en.json` `prompts` block verbatim into `zh-TW.json`, `de.json`, `es.json`, `fr.json`, `ja.json`, `ko.json`, `pt.json`, `ru.json`. (zh-TW may use Traditional Chinese if desired; English placeholder is acceptable for v1.)

**Step 5: Verify + commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS (no missing-key errors).

```bash
git add src/i18n/locales/*.json
git commit -m "feat(prompts): add prompt-library i18n keys across locales"
```

---

### Task 5: filterPrompts pure helper (TDD)

**Files:**
- Create: `src/features/chat/utils/filterPrompts.ts`
- Test: `tests/unit/features/chat/utils/filterPrompts.test.ts`

**Step 1: Write the failing test**

```ts
import { filterPrompts } from '@/features/chat/utils/filterPrompts';
import type { StoredPrompt } from '@/core/storage/PromptLibraryStorage';

const mk = (name: string, content: string): StoredPrompt => ({
  id: name, name, content, updatedAt: 0,
});

describe('filterPrompts', () => {
  it('returns all when query is blank', () => {
    const p = [mk('A', 'x'), mk('B', 'y')];
    expect(filterPrompts(p, '')).toEqual(p);
    expect(filterPrompts(p, '   ')).toEqual(p);
  });

  it('matches name case-insensitively', () => {
    const p = [mk('Summarize', 'x'), mk('Translate', 'y')];
    expect(filterPrompts(p, 'summ')).toEqual([p[0]]);
  });

  it('matches content', () => {
    const p = [mk('A', 'explain the code'), mk('B', 'rewrite')];
    expect(filterPrompts(p, 'code')).toEqual([p[0]]);
  });
});
```

**Step 2: Run to verify failure**

Run: `npm run test -- --selectProjects unit -- filterPrompts`
Expected: FAIL (module not found).

**Step 3: Implement**

```ts
// src/features/chat/utils/filterPrompts.ts
import type { StoredPrompt } from '../../../core/storage/PromptLibraryStorage';

export function filterPrompts(prompts: StoredPrompt[], query: string): StoredPrompt[] {
  const q = query.trim().toLowerCase();
  if (!q) return prompts;
  return prompts.filter(p =>
    p.name.toLowerCase().includes(q) || p.content.toLowerCase().includes(q),
  );
}
```

**Step 4: Run to verify pass + commit**

Run: `npm run test -- --selectProjects unit -- filterPrompts` → PASS.
```bash
npm run typecheck && npm run lint
git add src/features/chat/utils/filterPrompts.ts tests/unit/features/chat/utils/filterPrompts.test.ts
git commit -m "feat(prompts): add filterPrompts search helper"
```

---

### Task 6: PromptLibraryPanel UI component

**Files:**
- Create: `src/features/chat/ui/PromptLibraryPanel.ts`
- Test: `tests/unit/features/chat/ui/PromptLibraryPanel.test.ts`

**Step 1: Write the failing test**

Mirror the DOM-mock setup from `tests/unit/features/chat/ui/StatusPanel.test.ts` (read it first for the exact `createDiv`/`createEl` mocking approach used in this repo). Focus the test on: rendering rows from loaded prompts, and calling `onInsert` with content when a row body is clicked.

```ts
import { PromptLibraryPanel } from '@/features/chat/ui/PromptLibraryPanel';
import type { PromptLibraryStorage, StoredPrompt } from '@/core/storage/PromptLibraryStorage';

function mockStorage(prompts: StoredPrompt[]): jest.Mocked<PromptLibraryStorage> {
  return {
    load: jest.fn().mockResolvedValue(prompts),
    save: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<PromptLibraryStorage>;
}

describe('PromptLibraryPanel', () => {
  it('renders a row per loaded prompt and inserts content on click', async () => {
    const prompts: StoredPrompt[] = [
      { id: '1', name: 'Summarize', content: 'Summarize this:', updatedAt: 1 },
    ];
    const onInsert = jest.fn();
    const parent = document.body.createEl('div');
    const panel = new PromptLibraryPanel(parent, {
      storage: mockStorage(prompts),
      onInsert,
      getApp: () => null as never,
    });

    await panel.show();

    // Find the row body (the clickable area, not the edit/delete buttons).
    const rowBody = parent.querySelector('.claudian-prompt-row-body');
    expect(rowBody).toBeTruthy();
    rowBody?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onInsert).toHaveBeenCalledWith('Summarize this:');
  });
});
```

> If the repo's StatusPanel test mocks `createDiv` globally rather than using real DOM, adapt accordingly. The goal is one test proving: load → render rows → click row → onInsert(content). Keep it to that.

**Step 2: Run to verify failure**

Run: `npm run test -- --selectProjects unit -- PromptLibraryPanel`
Expected: FAIL (module not found).

**Step 3: Implement the panel**

```ts
// src/features/chat/ui/PromptLibraryPanel.ts
import { type App, Notice } from 'obsidian';

import type { PromptLibraryStorage, StoredPrompt } from '../../../core/storage/PromptLibraryStorage';
import { t } from '../../../i18n/i18n';
import { confirmDelete } from '../../../shared/modals/ConfirmModal';
import { filterPrompts } from '../utils/filterPrompts';

export interface PromptLibraryPanelDeps {
  storage: PromptLibraryStorage;
  onInsert: (content: string) => void;
  getApp: () => App;
}

export class PromptLibraryPanel {
  private container: HTMLElement;
  private deps: PromptLibraryPanelDeps;
  private prompts: StoredPrompt[] = [];
  private visible = false;
  private mode: 'list' | 'edit' = 'list';
  private editingId: string | null = null;

  constructor(parentEl: HTMLElement, deps: PromptLibraryPanelDeps) {
    this.deps = deps;
    this.container = parentEl.createDiv({ cls: 'claudian-prompt-panel claudian-hidden' });
  }

  async toggle(): Promise<void> {
    this.visible ? this.hide() : await this.show();
  }

  async show(): Promise<void> {
    this.visible = true;
    this.mode = 'list';
    this.editingId = null;
    this.container.removeClass('claudian-hidden');
    await this.reload();
  }

  hide(): void {
    this.visible = false;
    this.mode = 'list';
    this.editingId = null;
    this.container.addClass('claudian-hidden');
    this.container.empty();
  }

  private async reload(): Promise<void> {
    try {
      this.prompts = await this.deps.storage.load();
    } catch {
      new Notice(t('prompts.loadError'));
      this.prompts = [];
    }
    this.render();
  }

  private render(): void {
    this.container.empty();
    this.mode === 'edit' ? this.renderEdit() : this.renderList();
  }

  private renderList(): void {
    const header = this.container.createDiv({ cls: 'claudian-prompt-header' });
    const search = header.createEl('input', {
      cls: 'claudian-prompt-search',
      attr: { type: 'text', placeholder: t('prompts.searchPlaceholder') },
    });
    search.value = this.lastQuery ?? '';
    search.addEventListener('input', () => {
      this.lastQuery = search.value;
      this.renderListItems(listEl, search.value);
    });

    const newBtn = header.createEl('button', {
      cls: 'claudian-prompt-new-btn',
      text: t('prompts.new'),
    });
    newBtn.addEventListener('click', () => {
      this.mode = 'edit';
      this.editingId = null;
      this.render();
    });

    const listEl = this.container.createDiv({ cls: 'claudian-prompt-list' });
    this.renderListItems(listEl, search.value);
  }

  private renderListItems(listEl: HTMLElement, query: string): void {
    listEl.empty();
    const items = filterPrompts(this.prompts, query);
    if (items.length === 0) {
      listEl.createDiv({ cls: 'claudian-prompt-empty', text: t('prompts.empty') });
      return;
    }
    const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const prompt of sorted) {
      const row = listEl.createDiv({ cls: 'claudian-prompt-row' });

      const body = row.createDiv({ cls: 'claudian-prompt-row-body' });
      body.createDiv({ cls: 'claudian-prompt-row-name', text: prompt.name });
      const snippet = prompt.content.split('\n')[0].slice(0, 80);
      body.createDiv({ cls: 'claudian-prompt-row-snippet', text: snippet });
      body.addEventListener('click', () => {
        this.deps.onInsert(prompt.content);
        this.hide();
      });

      const actions = row.createDiv({ cls: 'claudian-prompt-row-actions' });
      const editBtn = actions.createEl('button', { cls: 'claudian-prompt-action', text: t('prompts.edit') });
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.editingId = prompt.id;
        this.mode = 'edit';
        this.render();
      });
      const delBtn = actions.createEl('button', { cls: 'claudian-prompt-action claudian-prompt-delete', text: t('prompts.delete') });
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDelete(this.deps.getApp(), t('prompts.deleteConfirm'));
        if (!ok) return;
        this.prompts = this.prompts.filter(p => p.id !== prompt.id);
        await this.persist();
      });
    }
  }

  private renderEdit(): void {
    const existing = this.editingId ? this.prompts.find(p => p.id === this.editingId) : null;
    const form = this.container.createDiv({ cls: 'claudian-prompt-form' });

    const nameInput = form.createEl('input', {
      cls: 'claudian-prompt-name-input',
      attr: { type: 'text', placeholder: t('prompts.namePlaceholder') },
    });
    nameInput.value = existing?.name ?? '';

    const contentArea = form.createEl('textarea', {
      cls: 'claudian-prompt-content-input',
      attr: { placeholder: t('prompts.contentPlaceholder') },
    });
    contentArea.value = existing?.content ?? '';

    const actions = form.createDiv({ cls: 'claudian-prompt-form-actions' });
    const cancelBtn = actions.createEl('button', { text: t('prompts.cancel') });
    cancelBtn.addEventListener('click', () => {
      this.mode = 'list';
      this.editingId = null;
      this.render();
    });
    const saveBtn = actions.createEl('button', { cls: 'mod-cta', text: t('prompts.save') });
    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const content = contentArea.value;
      if (!name || !content) return;
      if (existing) {
        existing.name = name;
        existing.content = content;
        existing.updatedAt = Date.now();
      } else {
        this.prompts.push({
          id: crypto.randomUUID(),
          name,
          content,
          updatedAt: Date.now(),
        });
      }
      await this.persist();
      this.mode = 'list';
      this.editingId = null;
      this.render();
    });
  }

  private async persist(): Promise<void> {
    try {
      await this.deps.storage.save(this.prompts);
    } catch {
      new Notice(t('prompts.saveError'));
    }
  }

  private lastQuery = '';
}
```

Notes:
- `crypto.randomUUID()` and `Date.now()` are available in the Obsidian/Electron renderer runtime (the `Date.now()` restriction applies only to Workflow scripts, not plugin code).
- Click-outside-to-close: add a document click listener in `show()` that hides when the click target is outside `this.container`; remove it in `hide()`. (Implement during this task — see "click-outside" detail below.)
- The `.claudian-prompt-row-body` class is what the unit test clicks; keep that selector stable.

**Click-outside detail** — inside `show()`, after unhiding:
```ts
this.outsideHandler = (e: MouseEvent) => {
  if (!this.container.contains(e.target as Node)) this.hide();
};
document.addEventListener('click', this.outsideHandler, true);
```
And in `hide()`:
```ts
if (this.outsideHandler) {
  document.removeEventListener('click', this.outsideHandler, true);
  this.outsideHandler = null;
}
```
(Add `private outsideHandler: ((e: MouseEvent) => void) | null = null;` field.) Guard so the same click that opened the panel (from the toolbar button) doesn't immediately close it: the toolbar button handler should call `e.stopPropagation()` or the panel should defer attaching the listener via `setTimeout(..., 0)`.

**Step 4: Run test to verify pass**

Run: `npm run test -- --selectProjects unit -- PromptLibraryPanel` → PASS.

**Step 5: Verify + commit**

```bash
npm run typecheck && npm run lint
git add src/features/chat/ui/PromptLibraryPanel.ts tests/unit/features/chat/ui/PromptLibraryPanel.test.ts
git commit -m "feat(prompts): add PromptLibraryPanel with list/edit/delete"
```

---

### Task 7: Toolbar button

**Files:**
- Modify: `src/features/chat/ui/InputToolbar.ts` (add callback + button)

**Step 1: Extend ToolbarCallbacks**

In `src/features/chat/ui/InputToolbar.ts`, add to the `ToolbarCallbacks` interface (line 49):

```ts
  onOpenPrompts?: () => void;
```

**Step 2: Render the button in createInputToolbar**

In `createInputToolbar` (line 1212), before the `return`, add:

```ts
  if (callbacks.onOpenPrompts) {
    const promptBtn = parentEl.createDiv({ cls: 'claudian-input-nav-btn claudian-prompt-toolbar-btn' });
    setIcon(promptBtn, 'book-text');
    promptBtn.setAttribute('aria-label', t('prompts.title'));
    promptBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onOpenPrompts?.();
    });
  }
```

Add the `t` import at the top: `import { t } from '../../../i18n/i18n';` (only if not already imported). `setIcon` is already imported.

> Icon choice: `book-text` (a "prompt/library" feel). Alternatives: `message-square`, `list`, `quote`. Pick whichever reads best; verify the icon exists in Obsidian's Lucide set.

**Step 3: Verify + commit**

Run: `npm run typecheck && npm run lint` → PASS.
```bash
git add src/features/chat/ui/InputToolbar.ts
git commit -m "feat(prompts): add prompt-library toolbar button"
```

---

### Task 8: Wire panel into the tab

**Files:**
- Modify: `src/features/chat/tabs/Tab.ts`

**Step 1: Instantiate the panel + connect the button**

Near the `createInputToolbar(...)` call (Tab.ts:825), before it, create the panel anchored inside `dom.inputContainerEl` (so the popover positions under the toolbar / over the input area). Capture it in a local variable.

```ts
import { PromptLibraryPanel } from '../ui/PromptLibraryPanel';
```

```ts
  const promptPanel = new PromptLibraryPanel(dom.inputContainerEl, {
    storage: plugin.storage.prompts,
    getApp: () => plugin.app,
    onInsert: (content) => {
      dom.inputEl.value = content;
      dom.inputEl.focus();
      // Reuse the tab's existing autosize — mirror restoreMessageToInput (InputController.ts:647):
      // it calls resetInputHeight(); locate the tab-local resize helper and call it here.
      resetInputHeight();
    },
  });
```

> `resetInputHeight`: locate the tab-local input-resize helper used on send (search Tab.ts for the function that resizes `dom.inputEl` after clearing input, or the value passed as `resetInputHeight` in InputControllerDeps at Tab.ts ~1329). Call that same helper. If it is not directly callable here, inline: `dom.inputEl.style.height = 'auto'; dom.inputEl.style.height = \`${dom.inputEl.scrollHeight}px\`;`. Prefer the shared helper.

**Step 2: Pass the toggle callback to the toolbar**

In the `createInputToolbar(inputToolbar, { ... })` callbacks object, add:

```ts
    onOpenPrompts: () => {
      void promptPanel.toggle();
    },
```

**Step 3: Dispose on tab cleanup**

Find the tab cleanup path (search Tab.ts for where the tab DOM / controllers are disposed, e.g. `cleanupTabRuntime` or tab close). Add `promptPanel.hide();` there to avoid dangling document click listeners when a tab closes. (If the panel only holds DOM inside `dom.inputContainerEl` which is removed on close, this is belt-and-suspenders — still do it to remove the document-level outside-click listener.)

**Step 4: Verify + commit**

Run: `npm run typecheck && npm run lint` → PASS.
```bash
git add src/features/chat/tabs/Tab.ts
git commit -m "feat(prompts): wire PromptLibraryPanel into the chat tab"
```

---

### Task 9: CSS

**Files:**
- Create: `src/style/toolbar/prompt-library.css`
- Modify: `src/style/index.css` (add `@import`)

**Step 1: Add the import to index.css**

After line 30 (`@import "./toolbar/mcp-selector.css";`), add:

```css
@import "./toolbar/prompt-library.css";
```

**Step 2: Write the styles**

Create `src/style/toolbar/prompt-library.css`. Cover: the popover container (absolute, below toolbar, max-height + scroll, z-index above messages), header row (search input + new button), list rows (name bold, snippet muted, hover), edit form (stacked name input + textarea + action row), empty state. Reuse existing theme variables from `src/style/base/variables.css` (read it for the available `--claudian-*` vars — match the conventions used in `model-selector.css` / `service-tier-toggle.css`).

```css
.claudian-prompt-panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  margin-bottom: var(--size-4-2, 8px);
  max-height: 340px;
  overflow-y: auto;
  z-index: 50;
  background: var(--background-secondary, var(--background-primary));
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  box-shadow: var(--shadow-s);
  padding: var(--size-4-2, 8px);
}

.claudian-prompt-header {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.claudian-prompt-search { flex: 1; }

.claudian-prompt-list { display: flex; flex-direction: column; gap: 2px; }

.claudian-prompt-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 6px;
}
.claudian-prompt-row:hover { background: var(--background-modifier-hover); }
.claudian-prompt-row-body { flex: 1; cursor: pointer; min-width: 0; }
.claudian-prompt-row-name { font-weight: 600; font-size: var(--font-ui-small); }
.claudian-prompt-row-snippet {
  font-size: var(--font-ui-smaller);
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.claudian-prompt-row-actions { display: flex; gap: 2px; }
.claudian-prompt-action { font-size: var(--font-ui-smaller); }

.claudian-prompt-empty {
  padding: 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: var(--font-ui-small);
}

.claudian-prompt-form { display: flex; flex-direction: column; gap: 8px; }
.claudian-prompt-name-input,
.claudian-prompt-content-input { width: 100%; }
.claudian-prompt-content-input { min-height: 120px; resize: vertical; }
.claudian-prompt-form-actions { display: flex; justify-content: flex-end; gap: 6px; }
```

Adjust variable names to match the actual vars in `src/style/base/variables.css` (verify before finalizing).

**Step 3: Verify + commit**

Run: `npm run build` (this runs build-css and confirms the import resolves) → PASS.
```bash
git add src/style/toolbar/prompt-library.css src/style/index.css
git commit -m "feat(prompts): add prompt-library popover styles"
```

---

### Task 10: Final verification

**Step 1: Full gate**

Run: `npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all PASS, build succeeds.

**Step 2: Manual verification in the app**

Run: `npm run dev` → load the plugin in Obsidian → open the Claudian sidebar.

Checklist:
- [ ] Toolbar shows a prompts button (book-text icon) next to the model selector.
- [ ] Click it → popover opens above the input, shows "No prompts yet" empty state.
- [ ] New prompt → enter name + content → Save → appears in list.
- [ ] Click a prompt row → content fills the input box, popover closes; can edit then send.
- [ ] Edit a prompt → change content → Save → list updates.
- [ ] Delete → confirm dialog → prompt removed.
- [ ] Search filters by name and content.
- [ ] Click outside the popover → it closes.
- [ ] Reload Obsidian → `.claudian/prompts.json` exists and prompts persist.
- [ ] Works the same on a Claude tab and a Codex tab (provider-neutral).

**Step 3: Commit any fixes, then done**

If manual testing surfaces issues, fix and commit per-issue. When green, the feature is complete.

---

## Out of scope (YAGNI — do not build)
- Categories / tags / folders for prompts.
- Import/export of prompts.
- Per-provider prompt scoping.
- Prompt variables / template substitution.
- Drag-to-reorder.
- Settings-tab management UI (panel is sufficient).
