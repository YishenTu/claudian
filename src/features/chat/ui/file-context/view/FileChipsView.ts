import type { ComposerContextTray } from '../../ComposerContextTray';

export interface FileChipsViewCallbacks {
  onRemoveAttachment: (path: string) => void;
  onRemoveFolder: (path: string) => void;
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
    this.contextTray.clearItems('vault-context');
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

  renderAttachments(
    filePaths: readonly string[],
    folderPaths: readonly string[],
    currentNotePath: string | null,
  ): void {
    const items = [
      ...filePaths
        .filter(path => path !== currentNotePath)
        .map(path => this.createFileItem(path)),
      ...folderPaths.map(path => this.createFolderItem(path)),
    ];
    this.contextTray.setItems('vault-context', items);
  }

  private createFileItem(filePath: string) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const filename = normalizedPath.split('/').pop() || filePath;
    return {
      id: `file:${filePath}`,
      kind: 'file' as const,
      label: filename,
      icon: 'file-text',
      title: filePath,
      ariaLabel: `Attached note: ${filePath}`,
      onActivate: () => this.callbacks.onOpenFile(filePath),
      onRemove: () => this.callbacks.onRemoveAttachment(filePath),
    };
  }

  private createFolderItem(folderPath: string) {
    const normalizedPath = folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const folderName = normalizedPath.split('/').pop() || folderPath;
    return {
      id: `folder:${folderPath}`,
      kind: 'folder' as const,
      label: `${folderName}/`,
      icon: 'folder',
      title: folderPath,
      ariaLabel: `Attached folder: ${folderPath}`,
      onRemove: () => this.callbacks.onRemoveFolder(folderPath),
    };
  }
}
