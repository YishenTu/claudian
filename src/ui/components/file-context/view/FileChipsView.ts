/**
 * Renders file chips and edited file chips.
 */

import { setIcon } from 'obsidian';

export interface FileChipsViewCallbacks {
  onRemoveAttachment: (path: string) => void;
  onOpenFile: (path: string) => Promise<void>;
  isContextFile: (path: string) => boolean;
  isFileEdited: (path: string) => boolean;
}

export class FileChipsView {
  private containerEl: HTMLElement;
  private callbacks: FileChipsViewCallbacks;
  private fileIndicatorEl: HTMLElement;
  private editedFilesIndicatorEl: HTMLElement;

  constructor(containerEl: HTMLElement, callbacks: FileChipsViewCallbacks) {
    this.containerEl = containerEl;
    this.callbacks = callbacks;

    const firstChild = this.containerEl.firstChild;
    this.editedFilesIndicatorEl = this.containerEl.createDiv({ cls: 'claudian-edited-files-indicator' });
    this.fileIndicatorEl = this.containerEl.createDiv({ cls: 'claudian-file-indicator' });
    if (firstChild) {
      this.containerEl.insertBefore(this.editedFilesIndicatorEl, firstChild);
      this.containerEl.insertBefore(this.fileIndicatorEl, firstChild);
    }
  }

  destroy(): void {
    this.fileIndicatorEl.remove();
    this.editedFilesIndicatorEl.remove();
  }

  renderAttachments(attachedFiles: Set<string>): void {
    this.fileIndicatorEl.empty();

    if (attachedFiles.size === 0) {
      this.fileIndicatorEl.style.display = 'none';
      return;
    }

    this.fileIndicatorEl.style.display = 'flex';

    for (const filePath of attachedFiles) {
      this.renderFileChip(filePath, () => {
        this.callbacks.onRemoveAttachment(filePath);
      });
    }
  }

  renderEditedFiles(editedFiles: string[], planModeActive: boolean): void {
    this.editedFilesIndicatorEl.empty();

    if (planModeActive || editedFiles.length === 0) {
      this.editedFilesIndicatorEl.style.display = 'none';
      return;
    }

    this.editedFilesIndicatorEl.style.display = 'flex';

    const label = this.editedFilesIndicatorEl.createSpan({ cls: 'claudian-edited-label' });
    label.setText('Edited:');

    for (const path of editedFiles) {
      this.renderEditedFileChip(path);
    }
  }

  private renderFileChip(filePath: string, onRemove: () => void): void {
    const chipEl = this.fileIndicatorEl.createDiv({ cls: 'claudian-file-chip' });

    const isContextFile = this.callbacks.isContextFile(filePath);
    if (isContextFile) {
      chipEl.addClass('claudian-file-chip-context');
    }

    if (this.callbacks.isFileEdited(filePath)) {
      chipEl.addClass('claudian-file-chip-edited');
    }

    const iconEl = chipEl.createSpan({ cls: 'claudian-file-chip-icon' });
    setIcon(iconEl, isContextFile ? 'folder-open' : 'file-text');

    const normalizedPath = filePath.replace(/\\/g, '/');
    const filename = normalizedPath.split('/').pop() || filePath;
    const nameEl = chipEl.createSpan({ cls: 'claudian-file-chip-name' });
    nameEl.setText(filename);
    nameEl.setAttribute('title', filePath);

    const removeEl = chipEl.createSpan({ cls: 'claudian-file-chip-remove' });
    removeEl.setText('\u00D7');
    removeEl.setAttribute('aria-label', 'Remove');

    chipEl.addEventListener('click', async (e) => {
      if ((e.target as HTMLElement).closest('.claudian-file-chip-remove')) return;
      try {
        await this.callbacks.onOpenFile(filePath);
      } catch (error) {
        console.error('Failed to open file:', error);
      }
    });

    removeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      onRemove();
    });
  }

  private renderEditedFileChip(filePath: string): void {
    const chipEl = this.editedFilesIndicatorEl.createDiv({
      cls: 'claudian-file-chip claudian-file-chip-edited',
    });

    const iconEl = chipEl.createSpan({ cls: 'claudian-file-chip-icon' });
    setIcon(iconEl, 'file-text');

    const normalizedPath = filePath.replace(/\\/g, '/');
    const filename = normalizedPath.split('/').pop() || filePath;
    const nameEl = chipEl.createSpan({ cls: 'claudian-file-chip-name' });
    nameEl.setText(filename);
    nameEl.setAttribute('title', filePath);

    chipEl.addEventListener('click', async () => {
      try {
        await this.callbacks.onOpenFile(filePath);
      } catch (error) {
        console.error('Failed to open file:', error);
      }
    });
  }
}
