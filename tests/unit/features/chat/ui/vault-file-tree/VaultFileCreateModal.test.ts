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

import { showVaultFileCreateModal } from '@/features/chat/ui/vault-file-tree/VaultFileCreateModal';

function createFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.name = path.split('/').pop() ?? '';
  file.basename = file.name.replace(/\.[^.]+$/, '');
  file.extension = file.name.includes('.') ? file.name.split('.').pop() ?? '' : '';
  return file;
}

function createFolder(path: string, isRoot = false): TFolder {
  const folder = new TFolder();
  folder.path = path;
  folder.name = path.split('/').pop() ?? '';
  folder.isRoot = jest.fn(() => isRoot);
  return folder;
}

function createApp(existingFiles: readonly TAbstractFile[] = []) {
  const files = new Map(existingFiles.map(file => [file.path, file]));
  const openFile = jest.fn().mockResolvedValue(undefined);
  const createdNote = createFile('created.md');
  return {
    app: {
      vault: {
        create: jest.fn().mockResolvedValue(createdNote),
        createFolder: jest.fn().mockResolvedValue(createFolder('created')),
        getAbstractFileByPath: jest.fn((path: string) => files.get(path) ?? null),
        getAllLoadedFiles: jest.fn(() => [...files.values()]),
      },
      workspace: {
        getLeaf: jest.fn(() => ({ openFile })),
      },
    },
    createdNote,
    files,
    openFile,
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
  await Promise.resolve();
}

describe('VaultFileCreateModal', () => {
  beforeEach(() => {
    lastModalInstance = null;
    createdButtons = [];
    createdTextComponents = [];
    mockNotice.mockReset();
  });

  it('creates and opens a Markdown note in the vault root', async () => {
    const root = createFolder('/', true);
    const { app, createdNote, openFile } = createApp();

    showVaultFileCreateModal(app as never, root, 'note');
    expect(createdTextComponents[0].getValue()).toBe('Untitled');
    createdTextComponents[0].setValue('Roadmap');
    getButton('Create').clickHandler();
    await flushPromises();

    expect(app.vault.create).toHaveBeenCalledWith('Roadmap.md', '');
    expect(app.workspace.getLeaf).toHaveBeenCalledWith(false);
    expect(openFile).toHaveBeenCalledWith(createdNote);
    expect(lastModalInstance.close).toHaveBeenCalledTimes(1);
  });

  it('chooses an available default note name and avoids duplicating the extension', async () => {
    const root = createFolder('/', true);
    const existing = createFile('untitled.md');
    const { app } = createApp([existing]);

    showVaultFileCreateModal(app as never, root, 'note');
    expect(createdTextComponents[0].getValue()).toBe('Untitled 1');
    createdTextComponents[0].setValue('README.md');
    getButton('Create').clickHandler();
    await flushPromises();

    expect(app.vault.create).toHaveBeenCalledWith('README.md', '');
  });

  it('creates a folder inside the selected parent folder', async () => {
    const parent = createFolder('Projects');
    const { app } = createApp([parent]);

    showVaultFileCreateModal(app as never, parent, 'folder');
    createdTextComponents[0].setValue('Archive');
    getButton('Create').clickHandler();
    await flushPromises();

    expect(app.vault.createFolder).toHaveBeenCalledWith('Projects/Archive');
    expect(app.workspace.getLeaf).not.toHaveBeenCalled();
    expect(lastModalInstance.close).toHaveBeenCalledTimes(1);
  });

  it('uses the current parent path when the folder moves while the modal is open', async () => {
    const parent = createFolder('Projects');
    const { app, files } = createApp([parent]);

    showVaultFileCreateModal(app as never, parent, 'folder');
    files.delete('Projects');
    parent.path = 'Archive';
    parent.name = 'Archive';
    files.set(parent.path, parent);
    createdTextComponents[0].setValue('Drafts');
    getButton('Create').clickHandler();
    await flushPromises();

    expect(app.vault.createFolder).toHaveBeenCalledWith('Archive/Drafts');
  });

  it('rejects a replacement folder that reuses the original parent path', async () => {
    const parent = createFolder('Projects');
    const { app, files } = createApp([parent]);

    showVaultFileCreateModal(app as never, parent, 'folder');
    files.set(parent.path, createFolder('Projects'));
    createdTextComponents[0].setValue('Archive');
    getButton('Create').clickHandler();
    await flushPromises();

    expect(app.vault.createFolder).not.toHaveBeenCalled();
    expect(lastModalInstance.close).not.toHaveBeenCalled();
    expect(mockNotice).toHaveBeenCalledWith('Destination folder is no longer available');
  });

  it('keeps the modal open when the destination already exists', async () => {
    const parent = createFolder('Projects');
    const existing = createFolder('Projects/archive');
    const { app } = createApp([parent, existing]);

    showVaultFileCreateModal(app as never, parent, 'folder');
    createdTextComponents[0].setValue('Archive');
    getButton('Create').clickHandler();
    await flushPromises();

    expect(app.vault.createFolder).not.toHaveBeenCalled();
    expect(lastModalInstance.close).not.toHaveBeenCalled();
    expect(mockNotice).toHaveBeenCalledWith('A file or folder named "Archive" already exists');
  });

  it('rejects a dot-prefixed folder name before creating a hidden vault item', async () => {
    const parent = createFolder('Projects');
    const { app } = createApp([parent]);

    showVaultFileCreateModal(app as never, parent, 'folder');
    createdTextComponents[0].setValue('.archive');
    getButton('Create').clickHandler();
    await flushPromises();

    expect(app.vault.createFolder).not.toHaveBeenCalled();
    expect(lastModalInstance.close).not.toHaveBeenCalled();
    expect(mockNotice).toHaveBeenCalledWith('Name cannot start with "."');
  });

  it('reports create failures and restores the controls for retry', async () => {
    const parent = createFolder('Projects');
    const { app } = createApp([parent]);
    app.vault.create.mockRejectedValueOnce(new Error('disk failure'));

    showVaultFileCreateModal(app as never, parent, 'note');
    createdTextComponents[0].setValue('Roadmap');
    const createButton = getButton('Create');
    createButton.clickHandler();
    await flushPromises();

    expect(lastModalInstance.close).not.toHaveBeenCalled();
    expect(createdTextComponents[0].inputEl.disabled).toBe(false);
    expect(createButton.buttonEl.disabled).toBe(false);
    expect(mockNotice).toHaveBeenCalledWith('Failed to create note');
  });
});
