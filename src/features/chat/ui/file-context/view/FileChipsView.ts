import type { ComposerContextTray } from '../../ComposerContextTray';

export interface FileChipsViewCallbacks {
  onRemoveAttachment: (path: string) => void;
  onOpenFile: (path: string) => void;
}

export class FileChipsView {
  private contextTray: ComposerContextTray;
  private callbacks: FileChipsViewCallbacks;

  constructor(contextTray: ComposerContextTray, callbacks: FileChipsViewCallbacks) {
    this.contextTray = contextTray;
    this.callbacks = callbacks;
  }

  destroy(): void {
    this.contextTray.clearItems('current-note');
  }

  renderCurrentNote(filePath: string | null): void {
    if (!filePath) {
      this.contextTray.clearItems('current-note');
      return;
    }

    const normalizedPath = filePath.replace(/\\/g, '/');
    const filename = normalizedPath.split('/').pop() || filePath;
    this.contextTray.setItems('current-note', [{
      id: filePath,
      kind: 'note',
      label: filename,
      icon: 'file-text',
      title: filePath,
      ariaLabel: `Linked note: ${filePath}`,
      onActivate: () => this.callbacks.onOpenFile(filePath),
      onRemove: () => this.callbacks.onRemoveAttachment(filePath),
    }]);
  }
}
