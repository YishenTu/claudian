import { setIcon } from 'obsidian';

export interface FileChipsViewCallbacks {
  onRemoveAttachment: (path: string) => void;
  onOpenFile: (path: string) => void;
}

export class FileChipsView {
  private containerEl: HTMLElement;
  private callbacks: FileChipsViewCallbacks;
  private fileIndicatorEl: HTMLElement;

  constructor(containerEl: HTMLElement, callbacks: FileChipsViewCallbacks) {
    this.containerEl = containerEl;
    this.callbacks = callbacks;

    const firstChild = this.containerEl.firstChild;
    this.fileIndicatorEl = this.containerEl.createDiv({ cls: 'claudian-file-indicator' });
    if (firstChild) {
      this.containerEl.insertBefore(this.fileIndicatorEl, firstChild);
    }
  }

  destroy(): void {
    this.fileIndicatorEl.remove();
  }

  /**
   * Render a single current note (legacy support).
   */
  renderCurrentNote(filePath: string | null): void {
    if (filePath) {
      this.renderFiles([filePath]);
    } else {
      this.renderFiles([]);
    }
  }

  /**
   * Render multiple attached files as chips.
   */
  renderFiles(filePaths: string[]): void {
    this.fileIndicatorEl.empty();

    if (filePaths.length === 0) {
      this.fileIndicatorEl.style.display = 'none';
      return;
    }

    this.fileIndicatorEl.style.display = 'flex';

    for (const filePath of filePaths) {
      this.renderFileChip(filePath, () => {
        this.callbacks.onRemoveAttachment(filePath);
      });
    }
  }

  /**
   * Add a single file chip to the existing chips.
   */
  addFileChip(filePath: string): void {
    // Check if chip already exists
    const existingChip = this.fileIndicatorEl.querySelector(
      `[data-file-path="${CSS.escape(filePath)}"]`
    );
    if (existingChip) return;

    this.fileIndicatorEl.style.display = 'flex';
    this.renderFileChip(filePath, () => {
      this.callbacks.onRemoveAttachment(filePath);
    });
  }

  /**
   * Remove a single file chip.
   */
  removeFileChip(filePath: string): void {
    const chip = this.fileIndicatorEl.querySelector(
      `[data-file-path="${CSS.escape(filePath)}"]`
    );
    if (chip) {
      chip.remove();
    }

    // Hide indicator if no chips left
    if (this.fileIndicatorEl.children.length === 0) {
      this.fileIndicatorEl.style.display = 'none';
    }
  }

  private renderFileChip(filePath: string, onRemove: () => void): void {
    const chipEl = this.fileIndicatorEl.createDiv({ cls: 'claudian-file-chip' });
    chipEl.setAttribute('data-file-path', filePath);

    const iconEl = chipEl.createSpan({ cls: 'claudian-file-chip-icon' });
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const iconName = this.getIconForExtension(ext);
    setIcon(iconEl, iconName);

    const normalizedPath = filePath.replace(/\\/g, '/');
    const filename = normalizedPath.split('/').pop() || filePath;
    const nameEl = chipEl.createSpan({ cls: 'claudian-file-chip-name' });
    nameEl.setText(filename);
    nameEl.setAttribute('title', filePath);

    const removeEl = chipEl.createSpan({ cls: 'claudian-file-chip-remove' });
    removeEl.setText('\u00D7');
    removeEl.setAttribute('aria-label', 'Remove');

    chipEl.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.claudian-file-chip-remove')) {
        this.callbacks.onOpenFile(filePath);
      }
    });

    removeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      onRemove();
    });
  }

  /**
   * Get appropriate icon based on file extension.
   */
  private getIconForExtension(ext: string): string {
    switch (ext) {
      case 'md':
        return 'file-text';
      case 'pdf':
        return 'file-text';
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'webp':
      case 'svg':
        return 'image';
      case 'mp3':
      case 'wav':
      case 'ogg':
        return 'music';
      case 'mp4':
      case 'webm':
        return 'video';
      case 'js':
      case 'ts':
      case 'py':
      case 'java':
      case 'c':
      case 'cpp':
      case 'rs':
      case 'go':
        return 'file-code';
      case 'json':
      case 'yaml':
      case 'yml':
      case 'xml':
        return 'file-json';
      case 'canvas':
        return 'layout-dashboard';
      default:
        return 'file';
    }
  }
}
