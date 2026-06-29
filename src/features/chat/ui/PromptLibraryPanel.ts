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
  private lastQuery = '';
  private outsideHandler: ((e: MouseEvent) => void) | null = null;

  constructor(parentEl: HTMLElement, deps: PromptLibraryPanelDeps) {
    this.deps = deps;
    this.container = parentEl.createDiv({ cls: 'claudian-prompt-panel claudian-hidden' });
  }

  async toggle(): Promise<void> {
    if (this.visible) this.hide();
    else await this.show();
  }

  async show(): Promise<void> {
    this.visible = true;
    this.mode = 'list';
    this.editingId = null;
    this.container.removeClass('claudian-hidden');
    this.outsideHandler = (e: MouseEvent) => {
      if (!this.container.contains(e.target as Node)) this.hide();
    };
    this.container.ownerDocument.addEventListener('click', this.outsideHandler, true);
    await this.reload();
  }

  hide(): void {
    this.visible = false;
    this.mode = 'list';
    this.editingId = null;
    this.container.addClass('claudian-hidden');
    this.container.empty();
    if (this.outsideHandler) {
      this.container.ownerDocument.removeEventListener('click', this.outsideHandler, true);
      this.outsideHandler = null;
    }
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
    if (this.mode === 'edit') this.renderEdit();
    else this.renderList();
  }

  private renderList(): void {
    const header = this.container.createDiv({ cls: 'claudian-prompt-header' });
    const search = header.createEl('input', {
      cls: 'claudian-prompt-search',
      attr: { type: 'text', placeholder: t('prompts.searchPlaceholder') },
    });
    search.value = this.lastQuery;
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
}
