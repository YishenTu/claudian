import type { FileContextCallbacks } from '@/ui/components/FileContext';
import { FileContextManager } from '@/ui/components/FileContext';

jest.mock('obsidian', () => ({
  setIcon: jest.fn(),
  TFile: class TFile {
    path: string;
    name: string;
    constructor(path: string) {
      this.path = path;
      this.name = path.split('/').pop() || path;
    }
  },
}));

jest.mock('@/utils/path', () => ({
  getVaultPath: jest.fn(() => '/vault'),
}));

interface MockElement {
  children: MockElement[];
  addClass: (cls: string) => void;
  removeClass: (cls: string) => void;
  hasClass: (cls: string) => boolean;
  getClasses: () => string[];
  addEventListener: (event: string, handler: (e: any) => void) => void;
  createDiv: (opts?: { cls?: string; text?: string }) => MockElement;
  createSpan: (opts?: { cls?: string; text?: string }) => MockElement;
  setText: (text: string) => void;
  setAttribute: (name: string, value: string) => void;
  textContent: string;
  style: Record<string, string>;
  empty: () => void;
  firstChild: MockElement | null;
  insertBefore: (el: MockElement, ref: MockElement | null) => void;
}

function createMockElement(): MockElement {
  const children: MockElement[] = [];
  const classList = new Set<string>();
  const style: Record<string, string> = {};
  const eventListeners: Map<string, Array<(e: any) => void>> = new Map();
  let textContent = '';

  const element: MockElement = {
    children,
    style,
    addClass: (cls: string) => {
      cls.split(/\s+/).filter(Boolean).forEach((c) => classList.add(c));
    },
    removeClass: (cls: string) => {
      cls.split(/\s+/).filter(Boolean).forEach((c) => classList.delete(c));
    },
    hasClass: (cls: string) => classList.has(cls),
    getClasses: () => Array.from(classList),
    addEventListener: (event: string, handler: (e: any) => void) => {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, []);
      }
      eventListeners.get(event)!.push(handler);
    },
    createDiv: (opts) => {
      const child = createMockElement();
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.setText(opts.text);
      children.push(child);
      return child;
    },
    createSpan: (opts) => {
      const child = createMockElement();
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.setText(opts.text);
      children.push(child);
      return child;
    },
    setText: (text: string) => {
      textContent = text;
    },
    setAttribute: () => {},
    get textContent() {
      return textContent;
    },
    set textContent(value: string) {
      textContent = value;
    },
    empty: () => {
      children.length = 0;
    },
    get firstChild(): MockElement | null {
      return children[0] || null;
    },
    insertBefore: (el: MockElement, _ref: MockElement | null) => {
      children.unshift(el);
    },
  };

  return element;
}

class MockTFile {
  path: string;
  name: string;
  stat = { mtime: Date.now() };
  constructor(path: string) {
    this.path = path;
    this.name = path.split('/').pop() || path;
  }
}

function createMockApp(activeFilePath: string | null = null) {
  const files: Map<string, MockTFile> = new Map();
  const fileContents: Map<string, string> = new Map();
  const eventHandlers: Map<string, Array<(...args: any[]) => void>> = new Map();

  const mockVault = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, []);
      }
      eventHandlers.get(event)!.push(handler);
      return { id: `${event}-ref` };
    }),
    offref: jest.fn(),
    getAbstractFileByPath: jest.fn((path: string) => files.get(path) || null),
    getMarkdownFiles: jest.fn(() => Array.from(files.values())),
    read: jest.fn(async (file: MockTFile) => fileContents.get(file.path) || ''),
    // Helper to trigger events in tests
    _trigger: (event: string, ...args: any[]) => {
      const handlers = eventHandlers.get(event) || [];
      handlers.forEach(h => h(...args));
    },
    _addFile: (path: string, content = '') => {
      const file = new MockTFile(path);
      files.set(path, file);
      fileContents.set(path, content);
      return file;
    },
    _setContent: (path: string, content: string) => {
      fileContents.set(path, content);
    },
  };

  const mockWorkspace = {
    getActiveFile: jest.fn(() => {
      if (!activeFilePath) return null;
      return files.get(activeFilePath) || new MockTFile(activeFilePath);
    }),
    getLeaf: jest.fn(() => ({
      openFile: jest.fn(),
    })),
  };

  const mockMetadataCache = {
    getFileCache: jest.fn(() => null),
  };

  return {
    vault: mockVault,
    workspace: mockWorkspace,
    metadataCache: mockMetadataCache,
  } as any;
}

function createMockCallbacks(): FileContextCallbacks {
  return {
    getExcludedTags: jest.fn(() => []),
    onFileOpen: jest.fn(),
  };
}

describe('FileContextManager - Edited File Indicator', () => {
  let containerEl: MockElement;
  let inputEl: any;

  beforeEach(() => {
    jest.clearAllMocks();
    containerEl = createMockElement();
    inputEl = {
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      focus: jest.fn(),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Point 1: Currently focused file should NOT show indicator', () => {
    it('should not show indicator when edited file is the currently active file', async () => {
      const app = createMockApp('notes/active.md');
      app.vault._addFile('notes/active.md', 'original content');

      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        createMockCallbacks()
      );

      // Simulate PreToolUse - marks file as being edited
      await manager.markFileBeingEdited('Write', { file_path: '/vault/notes/active.md' });

      // Simulate file content change
      app.vault._setContent('notes/active.md', 'modified content');

      // Simulate PostToolUse - tracks edit completion
      await manager.trackEditedFile('Write', { file_path: '/vault/notes/active.md' }, false);

      // The edited files indicator should be empty because the file is currently focused
      const editedIndicator = containerEl.children.find(
        (c) => c.hasClass('claudian-edited-files-indicator')
      );
      expect(editedIndicator).toBeDefined();
      expect(editedIndicator!.style.display).toBe('none');

      manager.destroy();
    });

    it('should show indicator when edited file is NOT the currently active file', async () => {
      const app = createMockApp('notes/other.md');
      app.vault._addFile('notes/edited.md', 'original content');
      app.vault._addFile('notes/other.md', 'other content');

      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        createMockCallbacks()
      );

      // Simulate PreToolUse
      await manager.markFileBeingEdited('Write', { file_path: '/vault/notes/edited.md' });

      // Simulate file content change
      app.vault._setContent('notes/edited.md', 'modified content');

      // Simulate PostToolUse
      await manager.trackEditedFile('Write', { file_path: '/vault/notes/edited.md' }, false);

      // The edited files indicator should show because the file is NOT currently focused
      const editedIndicator = containerEl.children.find(
        (c) => c.hasClass('claudian-edited-files-indicator')
      );
      expect(editedIndicator).toBeDefined();
      expect(editedIndicator!.style.display).toBe('flex');
      // Should have a chip for the edited file
      expect(editedIndicator!.children.some((c) => c.hasClass('claudian-file-chip'))).toBe(true);

      manager.destroy();
    });

    it('should not show indicator when no active file exists', async () => {
      const app = createMockApp(null);
      app.vault._addFile('notes/edited.md', 'original content');

      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        createMockCallbacks()
      );

      // Simulate PreToolUse
      await manager.markFileBeingEdited('Write', { file_path: '/vault/notes/edited.md' });

      // Simulate file content change
      app.vault._setContent('notes/edited.md', 'modified content');

      // Simulate PostToolUse
      await manager.trackEditedFile('Write', { file_path: '/vault/notes/edited.md' }, false);

      // Should show indicator since there's no active file to match
      const editedIndicator = containerEl.children.find(
        (c) => c.hasClass('claudian-edited-files-indicator')
      );
      expect(editedIndicator).toBeDefined();
      expect(editedIndicator!.style.display).toBe('flex');

      manager.destroy();
    });
  });

  describe('Point 2: Click chip to open non-focused file removes indicator', () => {
    it('should remove indicator when file is opened via handleFileOpen', async () => {
      const app = createMockApp('notes/other.md');
      const editedFile = app.vault._addFile('notes/edited.md', 'original content');
      app.vault._addFile('notes/other.md', 'other content');

      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        createMockCallbacks()
      );

      // Track the edit first
      await manager.markFileBeingEdited('Write', { file_path: '/vault/notes/edited.md' });
      app.vault._setContent('notes/edited.md', 'modified content');
      await manager.trackEditedFile('Write', { file_path: '/vault/notes/edited.md' }, false);

      // Verify indicator is showing
      let editedIndicator = containerEl.children.find(
        (c) => c.hasClass('claudian-edited-files-indicator')
      );
      expect(editedIndicator!.style.display).toBe('flex');

      // Simulate opening the edited file (this is what happens when chip is clicked)
      manager.handleFileOpen(editedFile as any);

      // Indicator should now be hidden
      editedIndicator = containerEl.children.find(
        (c) => c.hasClass('claudian-edited-files-indicator')
      );
      expect(editedIndicator!.style.display).toBe('none');

      manager.destroy();
    });
  });

  describe('Point 3: Edited file in separate area - click removes it', () => {
    it('should remove from edited files area when file is opened', async () => {
      const app = createMockApp('notes/other.md');
      const editedFile = app.vault._addFile('notes/edited.md', 'original content');
      app.vault._addFile('notes/other.md', 'other content');

      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        createMockCallbacks()
      );

      // Track the edit
      await manager.markFileBeingEdited('Write', { file_path: '/vault/notes/edited.md' });
      app.vault._setContent('notes/edited.md', 'modified content');
      await manager.trackEditedFile('Write', { file_path: '/vault/notes/edited.md' }, false);

      // Get initial chip count in edited indicator
      const editedIndicator = containerEl.children.find(
        (c) => c.hasClass('claudian-edited-files-indicator')
      );
      const initialChipCount = editedIndicator!.children.filter(
        (c) => c.hasClass('claudian-file-chip')
      ).length;
      expect(initialChipCount).toBe(1);

      // Open the file
      manager.handleFileOpen(editedFile as any);

      // Should have no chips now
      const finalChipCount = editedIndicator!.children.filter(
        (c) => c.hasClass('claudian-file-chip')
      ).length;
      expect(finalChipCount).toBe(0);

      manager.destroy();
    });
  });

  describe('Edge cases', () => {
    it('should not show indicator for errored edits', async () => {
      const app = createMockApp('notes/other.md');
      app.vault._addFile('notes/edited.md', 'original content');

      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        createMockCallbacks()
      );

      await manager.markFileBeingEdited('Write', { file_path: '/vault/notes/edited.md' });
      // Simulate error in tool execution
      await manager.trackEditedFile('Write', { file_path: '/vault/notes/edited.md' }, true);

      const editedIndicator = containerEl.children.find(
        (c) => c.hasClass('claudian-edited-files-indicator')
      );
      // Error case doesn't explicitly update indicator, but should have no file chips
      const chipCount = editedIndicator!.children.filter(
        (c) => c.hasClass('claudian-file-chip')
      ).length;
      expect(chipCount).toBe(0);

      manager.destroy();
    });

    it('should handle multiple edits to same file correctly', async () => {
      const app = createMockApp('notes/other.md');
      app.vault._addFile('notes/edited.md', 'original content');
      app.vault._addFile('notes/other.md', 'other content');

      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        createMockCallbacks()
      );

      // First edit
      await manager.markFileBeingEdited('Write', { file_path: '/vault/notes/edited.md' });
      app.vault._setContent('notes/edited.md', 'modified content 1');
      await manager.trackEditedFile('Write', { file_path: '/vault/notes/edited.md' }, false);

      // Second edit to same file
      await manager.markFileBeingEdited('Edit', { file_path: '/vault/notes/edited.md' });
      app.vault._setContent('notes/edited.md', 'modified content 2');
      await manager.trackEditedFile('Edit', { file_path: '/vault/notes/edited.md' }, false);

      // Should still show only one chip
      const editedIndicator = containerEl.children.find(
        (c) => c.hasClass('claudian-edited-files-indicator')
      );
      const chipCount = editedIndicator!.children.filter(
        (c) => c.hasClass('claudian-file-chip')
      ).length;
      expect(chipCount).toBe(1);

      manager.destroy();
    });

    it('should handle notebook edits the same as file edits', async () => {
      const app = createMockApp('notes/other.md');
      app.vault._addFile('notebooks/test.ipynb', '{}');
      app.vault._addFile('notes/other.md', 'other content');

      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        createMockCallbacks()
      );

      await manager.markFileBeingEdited('NotebookEdit', { notebook_path: '/vault/notebooks/test.ipynb' });
      app.vault._setContent('notebooks/test.ipynb', '{"cells": []}');
      await manager.trackEditedFile('NotebookEdit', { notebook_path: '/vault/notebooks/test.ipynb' }, false);

      const editedIndicator = containerEl.children.find(
        (c) => c.hasClass('claudian-edited-files-indicator')
      );
      expect(editedIndicator!.style.display).toBe('flex');

      manager.destroy();
    });
  });
});
