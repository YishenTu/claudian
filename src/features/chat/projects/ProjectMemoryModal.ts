import { type App, Component, MarkdownRenderer, Modal, Notice, setIcon } from 'obsidian';

import {
  ProjectMemoryConflictError,
  type ProjectMemoryContent,
  type ProjectMemoryOperations,
  type ProjectMemoryReadResult,
  type ProjectRecord,
} from '@/core/types';
import { t } from '@/i18n/i18n';
import { confirm } from '@/shared/modals/ConfirmModal';

export interface ProjectMemoryModalOptions {
  project: ProjectRecord;
  memory: ProjectMemoryOperations;
}

/** Agents write the memory file outside Obsidian's index, so no vault event announces their edits. */
const REFRESH_INTERVAL_MS = 2_000;
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

let nextTitleId = 0;

/**
 * Reads the project memory rendered as Markdown and edits it as plain text. The view follows the file while
 * it changes on disk; the user's unsaved text is never replaced without their choice. Saving compares against
 * the revision the user last accepted, so a change it has not seen ends in Reload or Overwrite.
 */
export class ProjectMemoryModal extends Modal {
  private titleTextEl!: HTMLElement;
  private dirtyMarkEl!: HTMLElement;
  private modeButton!: HTMLButtonElement;
  private noticeEl!: HTMLElement;
  private missingEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private contentArea!: HTMLTextAreaElement;
  private updatedEl!: HTMLElement;
  private cancelButton!: HTMLButtonElement;
  private saveButton!: HTMLButtonElement;
  private previewComponent: Component | null = null;
  private refreshTimer: number | null = null;

  private editing = false;
  private busy = false;
  private missing = false;
  /** The text the file held when the user last accepted it; unsaved edits are measured against it. */
  private baseline: string | null = null;
  private revision: string | null = null;
  private modifiedAt: number | null = null;
  /** A disk revision the user chose to keep their edits over; the refresh no longer offers it. */
  private dismissedRevision: string | null = null;
  private readGeneration = 0;
  private reading = false;
  private discardConfirmed = false;
  private confirmingDiscard = false;

  constructor(app: App, private readonly options: ProjectMemoryModalOptions) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('claudian-project-memory-modal');
    this.renderHeader();

    this.noticeEl = this.contentEl.createDiv({ cls: 'claudian-project-memory-notice' });
    this.missingEl = this.contentEl.createDiv({ cls: 'claudian-project-memory-missing' });
    // The rendered view and the editor share one display area; its corner holds the switch between them.
    const body = this.contentEl.createDiv({ cls: 'claudian-project-memory-body' });
    this.previewEl = body.createDiv({
      cls: 'claudian-project-memory-preview markdown-rendered',
      attr: { tabindex: '0' },
    });
    this.previewEl.addEventListener('click', event => this.editAtHeading(event));
    // An aria-label would surface as an Obsidian hover tooltip; the modal title names the editor instead.
    this.contentArea = body.createEl('textarea', {
      cls: 'claudian-project-memory-content',
      attr: { spellcheck: 'false', 'aria-labelledby': this.titleTextEl.id },
    });
    this.contentArea.addEventListener('input', () => this.sync());
    this.modeButton = body.createEl('button', {
      cls: 'claudian-project-memory-icon-btn claudian-project-memory-mode',
      attr: { type: 'button' },
    });
    this.modeButton.addEventListener('click', () => this.setEditing(!this.editing));
    this.renderFooter();

    this.scope.register(['Mod'], 'e', () => {
      if (this.canToggle()) this.setEditing(!this.editing);
      return false;
    });
    this.scope.register(['Mod'], 's', () => {
      if (this.isDirty()) void this.save(false);
      return false;
    });

    this.setEditing(false);
    void this.load();
    this.refreshTimer = window.setInterval(() => { void this.refresh(); }, REFRESH_INTERVAL_MS);
  }

  /** Esc, the close button and an outside click all land here; unsaved edits are discarded only when confirmed. */
  close(): void {
    if (this.discardConfirmed || !this.isDirty()) {
      super.close();
      return;
    }
    void this.confirmDiscard().then((discard) => {
      if (!discard) return;
      this.discardConfirmed = true;
      this.close();
    });
  }

  onClose(): void {
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.readGeneration += 1;
    this.unloadPreview();
    this.contentEl.empty();
  }

  private renderHeader(): void {
    this.titleEl.empty();
    this.titleEl.addClass('claudian-project-memory-title');
    this.titleTextEl = this.titleEl.createSpan({
      cls: 'claudian-project-memory-title-text',
      text: t('chat.projects.memory.title', { name: this.options.project.name }),
    });
    this.titleTextEl.id = `claudian-project-memory-title-${++nextTitleId}`;
    this.modalEl.setAttribute('aria-labelledby', this.titleTextEl.id);
    this.dirtyMarkEl = this.titleTextEl.createSpan({
      cls: 'claudian-project-memory-dirty',
      text: ' •',
      attr: { 'aria-hidden': 'true' },
    });

    // Obsidian's close button joins the title row and takes the look of the panel's icon buttons.
    const closeButton = this.modalEl.querySelector<HTMLElement>('.modal-close-button');
    if (closeButton) {
      closeButton.addClass('claudian-project-memory-icon-btn');
      this.titleEl.appendChild(closeButton);
    }
  }

  private renderFooter(): void {
    const footer = this.contentEl.createDiv({ cls: 'claudian-project-memory-footer' });
    const info = footer.createDiv({ cls: 'claudian-project-memory-info' });
    info.createEl('code', { cls: 'claudian-project-memory-path-value', text: this.options.project.memoryPath });
    this.updatedEl = info.createSpan({ cls: 'claudian-project-memory-updated' });

    const actions = footer.createDiv({ cls: 'claudian-project-modal-actions' });
    this.cancelButton = actions.createEl('button', {
      cls: 'claudian-cancel-btn',
      text: t('common.cancel'),
      attr: { type: 'button' },
    });
    this.cancelButton.addEventListener('click', () => { void this.cancelEdits(); });
    this.saveButton = actions.createEl('button', {
      cls: 'claudian-save-btn mod-cta',
      text: t('common.save'),
      attr: { type: 'button' },
    });
    this.saveButton.addEventListener('click', () => { void this.save(false); });
  }

  private isDirty(): boolean {
    return this.baseline !== null && this.contentArea.value !== this.baseline;
  }

  private canToggle(): boolean {
    return this.baseline !== null && !this.missing && !this.busy;
  }

  /** Projects the state onto the title mark, the toggle, the footer actions, and the updated time. */
  private sync(): void {
    const dirty = this.isDirty();
    this.dirtyMarkEl.hidden = !dirty;
    const modeLabel = t(this.editing ? 'chat.projects.memory.preview' : 'chat.projects.memory.edit');
    if (this.modeButton.getAttribute('aria-label') !== modeLabel) {
      this.modeButton.setAttribute('aria-label', modeLabel);
      setIcon(this.modeButton, this.editing ? 'book-open' : 'pencil');
    }
    this.modeButton.hidden = this.missing;
    this.modeButton.disabled = !this.canToggle();
    const changing = dirty || this.editing;
    this.cancelButton.hidden = !changing;
    this.saveButton.hidden = !changing;
    this.saveButton.disabled = this.busy || !dirty;
    this.contentArea.disabled = this.busy || this.baseline === null;
    this.updatedEl.setText(this.modifiedAt === null
      ? ''
      : t('chat.projects.memory.updated', { time: formatRelativeTime(this.modifiedAt, Date.now()) }));
  }

  /** The rendered view is re-rendered from the editor text whenever it is shown. */
  private setEditing(editing: boolean): void {
    this.editing = editing;
    this.contentArea.hidden = !editing || this.missing;
    this.previewEl.hidden = editing || this.missing;
    this.missingEl.hidden = !this.missing;
    if (editing) {
      this.unloadPreview();
      this.contentArea.focus();
    } else {
      this.renderPreview();
    }
    this.sync();
  }

  private renderPreview(): void {
    this.unloadPreview();
    if (this.baseline === null || this.missing) return;
    const component = new Component();
    component.load();
    this.previewComponent = component;
    // Each render owns a fresh target, so a superseded render cannot write into the current view.
    const target = this.previewEl.createDiv();
    const markdown = this.contentArea.value;
    MarkdownRenderer.render(this.app, markdown, target, this.options.project.memoryPath, component).catch(() => {
      target.setText(markdown);
    });
    if (!hasBody(markdown)) {
      this.previewEl.createEl('p', { cls: 'claudian-project-memory-empty', text: t('chat.projects.memory.emptyHint') });
    }
  }

  private unloadPreview(): void {
    this.previewComponent?.unload();
    this.previewComponent = null;
    this.previewEl.empty();
  }

  /** A click on a rendered heading opens the editor at that heading's line. */
  private editAtHeading(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target || target.closest('a')) return;
    const heading = target.closest('h1, h2, h3, h4, h5, h6');
    if (!heading || !this.previewEl.contains(heading)) return;
    const index = Array.from(this.previewEl.querySelectorAll('h1, h2, h3, h4, h5, h6')).indexOf(heading);
    const line = headingLines(this.contentArea.value)[index];
    if (line === undefined) return;
    this.setEditing(true);
    const lines = this.contentArea.value.split('\n');
    const offset = lines.slice(0, line).reduce((total, text) => total + text.length + 1, 0);
    this.contentArea.setSelectionRange(offset, offset);
    const lineHeight = Number.parseFloat(getComputedStyle(this.contentArea).lineHeight) || 20;
    this.contentArea.scrollTop = Math.max(0, line * lineHeight - lineHeight);
  }

  private async load(): Promise<void> {
    const generation = ++this.readGeneration;
    this.reading = true;
    if (this.baseline === null && !this.missing) this.showNotice(t('chat.projects.memory.loading'));
    try {
      const result = await this.options.memory.readMemory(this.options.project.id);
      if (generation !== this.readGeneration) return;
      this.accept(result);
    } catch {
      if (generation !== this.readGeneration) return;
      const actions = this.showNotice(t('chat.projects.memory.loadFailed'), 'alert');
      const retryButton = actions.createEl('button', { text: t('common.retry'), attr: { type: 'button' } });
      retryButton.addEventListener('click', () => { void this.load(); });
    } finally {
      if (generation === this.readGeneration) this.reading = false;
    }
  }

  /** Follows the file on disk: unchanged text takes the new content; unsaved edits get a choice instead. */
  private async refresh(): Promise<void> {
    if (this.busy || this.reading || this.confirmingDiscard) return;
    const generation = ++this.readGeneration;
    let result: ProjectMemoryReadResult;
    try {
      result = await this.options.memory.readMemory(this.options.project.id);
    } catch {
      // The next tick retries; a passing read error is no reason to interrupt the user.
      return;
    }
    if (generation !== this.readGeneration || this.busy) return;
    if (!this.isDirty()) {
      if ('missing' in result ? !this.missing : result.revision !== this.revision) this.accept(result);
      else this.sync();
      return;
    }
    if ('missing' in result || result.revision === this.revision || result.revision === this.dismissedRevision) {
      this.sync();
      return;
    }
    this.showChangedOutside(result);
  }

  /** Makes a read the accepted state, replacing the editor text. */
  private accept(result: ProjectMemoryReadResult): void {
    this.readGeneration += 1;
    this.reading = false;
    this.dismissedRevision = null;
    if ('missing' in result) {
      this.baseline = null;
      this.revision = null;
      this.modifiedAt = null;
      this.contentArea.value = '';
      this.missing = true;
      this.showMissing();
    } else {
      this.apply(result);
      this.clearNotice();
    }
    this.setEditing(this.editing && !this.missing);
  }

  private apply(memory: ProjectMemoryContent): void {
    this.missing = false;
    this.missingEl.empty();
    this.baseline = memory.content;
    this.revision = memory.revision;
    this.modifiedAt = memory.modifiedAt;
    if (this.contentArea.value !== memory.content) {
      const caret = this.contentArea.selectionStart;
      this.contentArea.value = memory.content;
      this.contentArea.setSelectionRange(Math.min(caret, memory.content.length), Math.min(caret, memory.content.length));
    }
  }

  private async save(overwrite: boolean): Promise<void> {
    if (this.busy || this.baseline === null) return;
    // The written text is captured now, so the editor stays locked until the write settles.
    this.setBusy(true);
    const content = this.contentArea.value;
    try {
      const saved = await this.options.memory.saveMemory(
        this.options.project.id,
        content,
        this.revision ?? '',
        overwrite ? { overwrite: true } : undefined,
      );
      this.apply(saved);
      new Notice(t('chat.projects.memory.saved'));
      this.close();
    } catch (error) {
      this.setBusy(false);
      if (error instanceof ProjectMemoryConflictError) {
        this.showConflict();
      } else {
        new Notice(t('chat.projects.memory.saveFailed'));
      }
    }
  }

  private async cancelEdits(): Promise<void> {
    if (this.isDirty() && !await this.confirmDiscard()) return;
    if (this.baseline !== null) this.contentArea.value = this.baseline;
    this.clearNotice();
    this.setEditing(false);
  }

  private async confirmDiscard(): Promise<boolean> {
    if (this.confirmingDiscard) return false;
    this.confirmingDiscard = true;
    try {
      return await confirm(this.app, t('chat.projects.memory.discardConfirm'), t('chat.projects.memory.discard'));
    } finally {
      this.confirmingDiscard = false;
    }
  }

  private async recreate(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    try {
      const memory = await this.options.memory.recreateMemory(this.options.project.id);
      this.setBusy(false);
      this.accept(memory);
    } catch {
      this.setBusy(false);
      new Notice(t('chat.projects.memory.saveFailed'));
    }
  }

  /** While a write is in flight, nothing else may reload or write the memory file. */
  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.noticeEl.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
    this.missingEl.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
    this.sync();
  }

  private clearNotice(): void {
    this.noticeEl.empty();
    this.noticeEl.removeClass('claudian-project-memory-notice--visible');
  }

  private showNotice(message: string, role: 'status' | 'alert' = 'status'): HTMLElement {
    this.clearNotice();
    this.noticeEl.addClass('claudian-project-memory-notice--visible');
    const messageEl = this.noticeEl.createEl('p', { cls: 'claudian-project-memory-notice-text', text: message });
    messageEl.setAttribute('role', role);
    return this.noticeEl.createDiv({ cls: 'claudian-project-memory-notice-actions' });
  }

  /** The missing file takes the content's place, with the way to bring it back. */
  private showMissing(): void {
    this.clearNotice();
    this.missingEl.empty();
    const messageEl = this.missingEl.createEl('p', { text: t('chat.projects.memory.missing') });
    messageEl.setAttribute('role', 'alert');
    const recreateButton = this.missingEl.createEl('button', {
      cls: 'mod-cta',
      text: t('chat.projects.memory.recreate'),
      attr: { type: 'button' },
    });
    recreateButton.addEventListener('click', () => { void this.recreate(); });
  }

  /** Another writer changed the file under unsaved edits: take theirs, or keep editing over it. */
  private showChangedOutside(result: ProjectMemoryContent): void {
    const actions = this.showNotice(t('chat.projects.memory.changedOutside'), 'alert');
    const reloadButton = actions.createEl('button', { text: t('chat.projects.memory.reload'), attr: { type: 'button' } });
    reloadButton.addEventListener('click', () => this.accept(result));
    const keepButton = actions.createEl('button', { text: t('chat.projects.memory.keepMine'), attr: { type: 'button' } });
    keepButton.addEventListener('click', () => {
      // Saving now replaces the version the user has seen and declined.
      this.revision = result.revision;
      this.modifiedAt = result.modifiedAt;
      this.dismissedRevision = result.revision;
      this.clearNotice();
      this.sync();
    });
  }

  /** The user's text stays in place; Reload discards it, Overwrite writes it anyway. */
  private showConflict(): void {
    const actions = this.showNotice(t('chat.projects.memory.conflict'), 'alert');
    const reloadButton = actions.createEl('button', { text: t('chat.projects.memory.reload'), attr: { type: 'button' } });
    reloadButton.addEventListener('click', () => {
      this.contentArea.value = this.baseline ?? '';
      void this.load();
    });
    const overwriteButton = actions.createEl('button', {
      cls: 'mod-warning',
      text: t('chat.projects.memory.overwrite'),
      attr: { type: 'button' },
    });
    overwriteButton.addEventListener('click', () => { void this.save(true); });
  }
}

/** Zero-based source lines of ATX headings outside fenced code, in rendered order. */
function headingLines(markdown: string): number[] {
  const lines: number[] = [];
  let fence: string | null = null;
  markdown.split('\n').forEach((text, index) => {
    const marker = FENCE.exec(text)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0].repeat(marker.length);
      else if (marker.startsWith(fence)) fence = null;
      return;
    }
    if (fence === null && ATX_HEADING.test(text)) lines.push(index);
  });
  return lines;
}

/** Whether the memory holds anything beyond headings, such as the untouched template. */
function hasBody(markdown: string): boolean {
  return markdown.split('\n').some(text => text.trim() !== '' && !ATX_HEADING.test(text));
}

function formatRelativeTime(timestamp: number, now: number): string {
  const seconds = Math.round((timestamp - now) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(0, 'second');
  if (abs < 3_600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return format.format(Math.round(seconds / 3_600), 'hour');
  return format.format(Math.round(seconds / 86_400), 'day');
}
