/** @jest-environment jsdom */

import { createMockEl } from '@test/helpers/MockElement';
import type { TAbstractFile } from 'obsidian';

let lastModalInstance: any;
let createdButtons: any[] = [];
let createdTextComponents: any[] = [];
const mockNotice = jest.fn();

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');

  class MockModal {
    app: any;
    modalEl = createMockEl();
    contentEl = createMockEl();
    setTitle = jest.fn();
    close = jest.fn(() => this.onClose());

    constructor(app: any) {
      this.app = app;
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      lastModalInstance = this;
    }

    open(): void {
      this.onOpen();
    }

    onOpen(): void {
      // Overridden by subclass
    }

    onClose(): void {
      // Overridden by subclass
    }
  }

  class MockTextComponent {
    inputEl = document.createElement('input');

    constructor() {
      createdTextComponents.push(this);
    }

    getValue(): string {
      return this.inputEl.value;
    }

    setDisabled(disabled: boolean): this {
      this.inputEl.disabled = disabled;
      return this;
    }

    setValue(value: string): this {
      this.inputEl.value = value;
      return this;
    }
  }

  class MockButtonComponent {
    buttonEl = document.createElement('button');
    clickHandler: (() => void) | null = null;
    text = '';

    constructor() {
      createdButtons.push(this);
    }

    onClick(handler: () => void): this {
      this.clickHandler = handler;
      return this;
    }

    setButtonText(text: string): this {
      this.text = text;
      return this;
    }

    setCta(): this {
      return this;
    }

    setDisabled(disabled: boolean): this {
      this.buttonEl.disabled = disabled;
      return this;
    }
  }

  class MockSetting {
    constructor(_containerEl: unknown) {}

    setName(_name: string): this {
      return this;
    }

    addText(callback: (component: MockTextComponent) => void): this {
      callback(new MockTextComponent());
      return this;
    }

    addButton(callback: (component: MockButtonComponent) => void): this {
      callback(new MockButtonComponent());
      return this;
    }
  }

  return {
    ...actual,
    Modal: MockModal,
    Notice: mockNotice,
    Setting: MockSetting,
  };
});

import { TFile, TFolder } from 'obsidian';

import { showVaultFileRenameModal } from '@/features/chat/ui/vault-file-tree/VaultFileRenameModal';

function createFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.split('/').pop() ?? '';
  file.basename = file.name.replace(/\.[^.]+$/, '');
  file.extension = file.name.includes('.') ? file.name.split('.').pop() ?? '' : '';
  return file;
}

function createFolder(path: string): TFolder {
  const folder = new TFolder();
  folder.path = path;
  folder.name = path.split('/').pop() ?? '';
  return folder;
}

function createApp(existingFiles: readonly TAbstractFile[] = []) {
  const files = new Map(existingFiles.map(file => [file.path, file]));
  return {
    fileManager: {
      renameFile: jest.fn().mockResolvedValue(undefined),
    },
    files,
    vault: {
      getAbstractFileByPath: jest.fn((path: string) => files.get(path) ?? null),
      getAllLoadedFiles: jest.fn(() => [...files.values()]),
    },
  };
}

function getButton(text: string): any {
  const button = createdButtons.find(candidate => candidate.text === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('VaultFileRenameModal', () => {
  beforeEach(() => {
    lastModalInstance = null;
    createdButtons = [];
    createdTextComponents = [];
    mockNotice.mockReset();
  });

  it('renames a file within its current folder through Obsidian FileManager', async () => {
    const file = createFile('Projects/Plan.md');
    const app = createApp([file]);

    showVaultFileRenameModal(app as never, file);

    expect(createdTextComponents[0].getValue()).toBe('Plan');
    createdTextComponents[0].setValue('Roadmap');
    getButton('Rename').clickHandler();
    await flushPromises();

    expect(app.fileManager.renameFile).toHaveBeenCalledWith(file, 'Projects/Roadmap.md');
    expect(lastModalInstance.close).toHaveBeenCalledTimes(1);
  });

  it('renames a folder without treating the operation as a move', async () => {
    const folder = createFolder('Projects/Drafts');
    const app = createApp([folder]);

    showVaultFileRenameModal(app as never, folder);
    createdTextComponents[0].setValue('Archive');
    getButton('Rename').clickHandler();
    await flushPromises();

    expect(app.fileManager.renameFile).toHaveBeenCalledWith(folder, 'Projects/Archive');
  });

  it('preserves the Markdown extension during a case-only rename', async () => {
    const file = createFile('Projects/Plan.md');
    const app = createApp([file]);

    showVaultFileRenameModal(app as never, file);
    createdTextComponents[0].setValue('plan');
    getButton('Rename').clickHandler();
    await flushPromises();

    expect(app.fileManager.renameFile).toHaveBeenCalledWith(file, 'Projects/plan.md');
  });

  it('uses the current parent path when the file moves while the modal is open', async () => {
    const file = createFile('Projects/Plan.md');
    const app = createApp([file]);

    showVaultFileRenameModal(app as never, file);
    app.files.delete('Projects/Plan.md');
    file.path = 'Archive/Plan.md';
    app.files.set(file.path, file);
    createdTextComponents[0].setValue('Roadmap');
    getButton('Rename').clickHandler();
    await flushPromises();

    expect(app.fileManager.renameFile).toHaveBeenCalledWith(file, 'Archive/Roadmap.md');
  });

  it('rejects a replacement file that reuses the original target path', async () => {
    const file = createFile('Projects/Plan.md');
    const app = createApp([file]);

    showVaultFileRenameModal(app as never, file);
    app.files.set(file.path, createFile('Projects/Plan.md'));
    createdTextComponents[0].setValue('Roadmap');
    getButton('Rename').clickHandler();
    await flushPromises();

    expect(app.fileManager.renameFile).not.toHaveBeenCalled();
    expect(lastModalInstance.close).not.toHaveBeenCalled();
    expect(mockNotice).toHaveBeenCalledWith('File is no longer available');
  });

  it.each(['', '   ', '.', '..', '.archive', '../Archive', 'Nested/Archive', 'Nested\\Archive'])(
    'rejects an invalid new name: %p',
    async (newName) => {
      const file = createFile('Projects/Plan.md');
      const app = createApp([file]);

      showVaultFileRenameModal(app as never, file);
      createdTextComponents[0].setValue(newName);
      getButton('Rename').clickHandler();
      await flushPromises();

      expect(app.fileManager.renameFile).not.toHaveBeenCalled();
      expect(lastModalInstance.close).not.toHaveBeenCalled();
      expect(mockNotice).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the modal open when the destination already exists', async () => {
    const file = createFile('Projects/Plan.md');
    const existing = createFile('Projects/roadmap.md');
    const app = createApp([file, existing]);

    showVaultFileRenameModal(app as never, file);
    createdTextComponents[0].setValue('Roadmap');
    getButton('Rename').clickHandler();
    await flushPromises();

    expect(app.fileManager.renameFile).not.toHaveBeenCalled();
    expect(lastModalInstance.close).not.toHaveBeenCalled();
    expect(mockNotice).toHaveBeenCalledWith('A file or folder named "Roadmap.md" already exists');
  });

  it('reports rename failures and restores the controls for retry', async () => {
    const file = createFile('Projects/Plan.md');
    const app = createApp([file]);
    app.fileManager.renameFile.mockRejectedValueOnce(new Error('disk failure'));

    showVaultFileRenameModal(app as never, file);
    createdTextComponents[0].setValue('Roadmap.md');
    const renameButton = getButton('Rename');
    renameButton.clickHandler();
    await flushPromises();

    expect(lastModalInstance.close).not.toHaveBeenCalled();
    expect(createdTextComponents[0].inputEl.disabled).toBe(false);
    expect(renameButton.buttonEl.disabled).toBe(false);
    expect(mockNotice).toHaveBeenCalledWith('Failed to rename "Plan.md"');
  });
});
