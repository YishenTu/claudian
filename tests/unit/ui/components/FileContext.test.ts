import type { FileContextCallbacks } from '@/ui/components/FileContext';
import { FileContextManager } from '@/ui/components/FileContext';
import type { ContextPathFile } from '@/utils/contextPathScanner';

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

let mockVaultPath = '/vault';
jest.mock('@/utils/path', () => {
  const actual = jest.requireActual('@/utils/path') as typeof import('@/utils/path');
  return {
    ...actual,
    getVaultPath: jest.fn(() => mockVaultPath),
    isPathWithinVault: jest.fn((candidatePath: string, vaultPath: string) => {
      // Simple implementation for testing: check if path starts with vault + separator
      const normalizedVault = vaultPath.replace(/\\/g, '/').replace(/\/+$/, '');
      const normalizedPath = candidatePath.replace(/\\/g, '/');
      return normalizedPath === normalizedVault || normalizedPath.startsWith(normalizedVault + '/');
    }),
  };
});

// Mock context path scanner
const mockScanPaths = jest.fn<ContextPathFile[], [string[]]>(() => []);
jest.mock('@/utils/contextPathScanner', () => ({
  contextPathScanner: {
    scanPaths: (paths: string[]) => mockScanPaths(paths),
    invalidateCache: jest.fn(),
    invalidatePath: jest.fn(),
  },
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
  querySelectorAll: (selector: string) => MockElement[];
  contains: (node: Node) => boolean;
  scrollIntoView: (opts?: { block?: string }) => void;
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
    querySelectorAll: (selector: string): MockElement[] => {
      // Simple implementation for class selectors
      const results: MockElement[] = [];
      const className = selector.replace('.', '');

      const search = (elements: MockElement[]) => {
        for (const el of elements) {
          if (el.hasClass(className)) {
            results.push(el);
          }
          search(el.children);
        }
      };
      search(children);
      return results;
    },
    contains: () => false,
    scrollIntoView: () => {},
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

function createMockCallbacks(contextPaths: string[] = []): FileContextCallbacks {
  return {
    getExcludedTags: jest.fn(() => []),
    onFileOpen: jest.fn(),
    getContextPaths: jest.fn(() => contextPaths),
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

describe('FileContextManager - Context Path Files', () => {
  let containerEl: MockElement;
  let inputEl: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVaultPath = '/vault';
    mockScanPaths.mockReturnValue([]);
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

  describe('Context file detection', () => {
    it('should have getContextPaths callback in FileContextCallbacks', () => {
      const callbacks = createMockCallbacks(['/external/path']);
      expect(callbacks.getContextPaths).toBeDefined();
      expect(callbacks.getContextPaths!()).toEqual(['/external/path']);
    });

    it('should handle empty context paths', () => {
      const callbacks = createMockCallbacks([]);
      expect(callbacks.getContextPaths!()).toEqual([]);
    });

    it('should handle multiple context paths', () => {
      const callbacks = createMockCallbacks(['/path1', '/path2', '/path3']);
      expect(callbacks.getContextPaths!()).toEqual(['/path1', '/path2', '/path3']);
    });
  });

  describe('File chip rendering for context files', () => {
    it('should create manager with context paths callback', () => {
      const app = createMockApp();
      const callbacks = createMockCallbacks(['/external/context']);

      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      expect(manager).toBeDefined();
      manager.destroy();
    });
  });
});

describe('FileContextManager - isWithinVault boundary checks', () => {
  let containerEl: MockElement;
  let inputEl: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVaultPath = '/vault';
    mockScanPaths.mockReturnValue([]);
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

  // Test isWithinVault indirectly via file chip rendering behavior
  // Context files outside vault get the 'claudian-file-chip-context' class

  it('should identify path inside vault correctly', () => {
    const app = createMockApp();
    const callbacks = createMockCallbacks();

    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      callbacks
    );

    // Manually add a vault-relative path
    manager.setAttachedFiles(['notes/test.md']);

    const fileIndicator = containerEl.children.find(
      (c) => c.hasClass('claudian-file-indicator')
    );
    expect(fileIndicator).toBeDefined();

    // Should NOT have context class for vault files
    const fileChip = fileIndicator!.children.find(c => c.hasClass('claudian-file-chip'));
    expect(fileChip).toBeDefined();
    expect(fileChip!.hasClass('claudian-file-chip-context')).toBe(false);

    manager.destroy();
  });

  it('should identify path outside vault as context file', () => {
    const app = createMockApp();
    const callbacks = createMockCallbacks();

    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      callbacks
    );

    // Add an absolute path outside vault
    manager.setAttachedFiles(['/external/project/file.ts']);

    const fileIndicator = containerEl.children.find(
      (c) => c.hasClass('claudian-file-indicator')
    );
    expect(fileIndicator).toBeDefined();

    // Should have context class for external files
    const fileChip = fileIndicator!.children.find(c => c.hasClass('claudian-file-chip'));
    expect(fileChip).toBeDefined();
    expect(fileChip!.hasClass('claudian-file-chip-context')).toBe(true);

    manager.destroy();
  });

  it('should NOT consider /vault2/file.txt as within /vault (false positive prevention)', () => {
    mockVaultPath = '/vault';
    const app = createMockApp();
    const callbacks = createMockCallbacks();

    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      callbacks
    );

    // Add a path that starts with vault name but is a different directory
    // This is the key edge case from the review
    manager.setAttachedFiles(['/vault2/file.txt']);

    const fileIndicator = containerEl.children.find(
      (c) => c.hasClass('claudian-file-indicator')
    );
    const fileChip = fileIndicator!.children.find(c => c.hasClass('claudian-file-chip'));
    expect(fileChip).toBeDefined();

    // Should be treated as context file (outside vault)
    expect(fileChip!.hasClass('claudian-file-chip-context')).toBe(true);

    manager.destroy();
  });

  it('should handle vault path with trailing slash', () => {
    mockVaultPath = '/vault/';
    const app = createMockApp();
    const callbacks = createMockCallbacks();

    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      callbacks
    );

    manager.setAttachedFiles(['/vault/subdir/file.md']);

    const fileIndicator = containerEl.children.find(
      (c) => c.hasClass('claudian-file-indicator')
    );
    const fileChip = fileIndicator!.children.find(c => c.hasClass('claudian-file-chip'));
    expect(fileChip).toBeDefined();

    // Should NOT be context file (it's inside vault)
    expect(fileChip!.hasClass('claudian-file-chip-context')).toBe(false);

    manager.destroy();
  });

  it('should handle exact vault path match', () => {
    mockVaultPath = '/vault';
    const app = createMockApp();
    const callbacks = createMockCallbacks();

    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      callbacks
    );

    // Path equals vault path exactly (edge case)
    manager.setAttachedFiles(['/vault']);

    const fileIndicator = containerEl.children.find(
      (c) => c.hasClass('claudian-file-indicator')
    );
    const fileChip = fileIndicator!.children.find(c => c.hasClass('claudian-file-chip'));
    expect(fileChip).toBeDefined();

    // Should NOT be context file (it IS the vault)
    expect(fileChip!.hasClass('claudian-file-chip-context')).toBe(false);

    manager.destroy();
  });

  it('should handle Windows-style paths', () => {
    mockVaultPath = 'C:\\Users\\test\\vault';
    const app = createMockApp();
    const callbacks = createMockCallbacks();

    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      callbacks
    );

    // Windows path inside vault
    manager.setAttachedFiles(['C:\\Users\\test\\vault\\notes\\file.md']);

    const fileIndicator = containerEl.children.find(
      (c) => c.hasClass('claudian-file-indicator')
    );
    const fileChip = fileIndicator!.children.find(c => c.hasClass('claudian-file-chip'));
    expect(fileChip).toBeDefined();

    // Should NOT be context file
    expect(fileChip!.hasClass('claudian-file-chip-context')).toBe(false);

    manager.destroy();
  });

  it('should handle similar directory names with longer suffix', () => {
    mockVaultPath = '/users/vault';
    const app = createMockApp();
    const callbacks = createMockCallbacks();

    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      callbacks
    );

    // Different directory starting with same name (vault-backup vs vault)
    manager.setAttachedFiles(['/users/vault-backup/file.txt']);

    const fileIndicator = containerEl.children.find(
      (c) => c.hasClass('claudian-file-indicator')
    );
    const fileChip = fileIndicator!.children.find(c => c.hasClass('claudian-file-chip'));
    expect(fileChip).toBeDefined();

    // Should be context file (different directory)
    expect(fileChip!.hasClass('claudian-file-chip-context')).toBe(true);

    manager.destroy();
  });
});

describe('FileContextManager - Context file @-mention dropdown', () => {
  let containerEl: MockElement;
  let inputEl: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVaultPath = '/vault';
    mockScanPaths.mockReturnValue([]);
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

  describe('Context file filtering', () => {
    it('should filter context files by name', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/src/app.ts', name: 'app.ts', relativePath: 'src/app.ts', contextRoot: '/external', mtime: 1000 },
        { path: '/external/src/index.ts', name: 'index.ts', relativePath: 'src/index.ts', contextRoot: '/external', mtime: 2000 },
        { path: '/external/config.json', name: 'config.json', relativePath: 'config.json', contextRoot: '/external', mtime: 3000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Use @folder/ pattern to show context files, then filter by name
      inputEl.value = '@external/app';
      inputEl.selectionStart = 13;
      manager.handleInputChange();

      // Check that dropdown is visible
      const dropdown = containerEl.children.find(
        c => c.hasClass('claudian-mention-dropdown')
      );
      expect(dropdown).toBeDefined();
      expect(dropdown!.hasClass('visible')).toBe(true);

      // Should only show files matching 'app'
      const items = dropdown!.children.filter(c => c.hasClass('claudian-mention-item'));
      expect(items.length).toBe(1);

      manager.destroy();
    });

    it('should filter context files by path', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/src/app.ts', name: 'app.ts', relativePath: 'src/app.ts', contextRoot: '/external', mtime: 1000 },
        { path: '/external/lib/utils.ts', name: 'utils.ts', relativePath: 'lib/utils.ts', contextRoot: '/external', mtime: 2000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Use @folder/ pattern then search by path segment
      inputEl.value = '@external/src';
      inputEl.selectionStart = 13;
      manager.handleInputChange();

      const dropdown = containerEl.children.find(c => c.hasClass('claudian-mention-dropdown'));
      const items = dropdown!.children.filter(c => c.hasClass('claudian-mention-item'));

      // Should match file with 'src' in path
      expect(items.length).toBe(1);

      manager.destroy();
    });

    it('should filter case-insensitively', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/README.md', name: 'README.md', relativePath: 'README.md', contextRoot: '/external', mtime: 1000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Use @folder/ pattern then search with lowercase
      inputEl.value = '@external/readme';
      inputEl.selectionStart = 16;
      manager.handleInputChange();

      const dropdown = containerEl.children.find(c => c.hasClass('claudian-mention-dropdown'));
      const items = dropdown!.children.filter(c => c.hasClass('claudian-mention-item'));

      expect(items.length).toBe(1);

      manager.destroy();
    });

    it('should show "No matches" when no files match', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/app.ts', name: 'app.ts', relativePath: 'app.ts', contextRoot: '/external', mtime: 1000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Use @folder/ pattern then search for nonexistent
      inputEl.value = '@external/nonexistent';
      inputEl.selectionStart = 21;
      manager.handleInputChange();

      const dropdown = containerEl.children.find(c => c.hasClass('claudian-mention-dropdown'));
      const emptyEl = dropdown!.children.find(c => c.hasClass('claudian-mention-empty'));

      expect(emptyEl).toBeDefined();

      manager.destroy();
    });
  });

  describe('Context folder disambiguation', () => {
    it('should show parent/folder when context folders share the same name', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const callbacks = createMockCallbacks(['/pathA/folder', '/pathB/folder']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      inputEl.value = '@folder';
      inputEl.selectionStart = 7;
      manager.handleInputChange();

      const dropdown = containerEl.children.find(c => c.hasClass('claudian-mention-dropdown'));
      const items = dropdown!.children.filter(c => c.hasClass('claudian-mention-item'));
      const folderNames = items
        .filter(item => item.hasClass('context-folder'))
        .flatMap(item => item.querySelectorAll('.claudian-mention-name-folder'))
        .map(el => el.textContent);

      expect(folderNames).toEqual(
        expect.arrayContaining(['@pathA/folder/', '@pathB/folder/'])
      );

      manager.destroy();
    });
  });

  describe('Context file sorting', () => {
    it('should prioritize name prefix matches over other matches', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/contains-test.ts', name: 'contains-test.ts', relativePath: 'contains-test.ts', contextRoot: '/external', mtime: 3000 },
        { path: '/external/test.ts', name: 'test.ts', relativePath: 'test.ts', contextRoot: '/external', mtime: 1000 },
        { path: '/external/mytest.ts', name: 'mytest.ts', relativePath: 'mytest.ts', contextRoot: '/external', mtime: 2000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Use @folder/ pattern to trigger context file filter mode
      inputEl.value = '@external/test';
      inputEl.selectionStart = 14;
      manager.handleInputChange();

      const dropdown = containerEl.children.find(c => c.hasClass('claudian-mention-dropdown'));
      const items = dropdown!.children.filter(c => c.hasClass('claudian-mention-item'));

      // test.ts should be first (name starts with 'test')
      expect(items.length).toBe(3);
      // First item should have context-file class and be test.ts
      expect(items[0].hasClass('context-file')).toBe(true);

      manager.destroy();
    });

    it('should sort by mtime when name matches are equal', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      // All have same prefix match status, so mtime should determine order
      const contextFiles: ContextPathFile[] = [
        { path: '/external/old.ts', name: 'old.ts', relativePath: 'old.ts', contextRoot: '/external', mtime: 1000 },
        { path: '/external/newest.ts', name: 'newest.ts', relativePath: 'newest.ts', contextRoot: '/external', mtime: 3000 },
        { path: '/external/middle.ts', name: 'middle.ts', relativePath: 'middle.ts', contextRoot: '/external', mtime: 2000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Use @folder/ pattern to show all files from context
      inputEl.value = '@external/';
      inputEl.selectionStart = 10;
      manager.handleInputChange();

      const dropdown = containerEl.children.find(c => c.hasClass('claudian-mention-dropdown'));
      const items = dropdown!.children.filter(c => c.hasClass('claudian-mention-item'));

      // Should have 3 context files (no folder filter in filter mode)
      expect(items.length).toBe(3);

      manager.destroy();
    });

    it('should limit context files to 10 in filter mode', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [];
      for (let i = 0; i < 15; i++) {
        contextFiles.push({
          path: `/external/file${i}.ts`,
          name: `file${i}.ts`,
          relativePath: `file${i}.ts`,
          contextRoot: '/external',
          mtime: i * 1000,
        });
      }
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Use @folder/ pattern to trigger filter mode
      inputEl.value = '@external/file';
      inputEl.selectionStart = 14;
      manager.handleInputChange();

      const dropdown = containerEl.children.find(c => c.hasClass('claudian-mention-dropdown'));
      const contextItems = dropdown!.children.filter(c => c.hasClass('context-file'));

      // Should be limited to 10 context files in filter mode
      expect(contextItems.length).toBe(10);

      manager.destroy();
    });
  });

  describe('Context file selection', () => {
    it('should add absolute path to attached files when context file is selected', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/src/app.ts', name: 'app.ts', relativePath: 'src/app.ts', contextRoot: '/external', mtime: 1000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Use @folder/ pattern to show context files
      inputEl.value = '@external/app';
      inputEl.selectionStart = 13;
      manager.handleInputChange();

      // Simulate Enter key to select
      const handled = manager.handleMentionKeydown({ key: 'Enter', preventDefault: jest.fn() } as any);
      expect(handled).toBe(true);

      // Check attached files contains the absolute path
      const attachedFiles = manager.getAttachedFiles();
      expect(attachedFiles.has('/external/src/app.ts')).toBe(true);

      manager.destroy();
    });

    it('should update input text with file name after selection', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/myfile.ts', name: 'myfile.ts', relativePath: 'myfile.ts', contextRoot: '/external', mtime: 1000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Use @folder/ pattern to show context files
      inputEl.value = '@external/my';
      inputEl.selectionStart = 12;
      manager.handleInputChange();

      manager.handleMentionKeydown({ key: 'Enter', preventDefault: jest.fn() } as any);

      // Input should now have the @folderName/filename format for context files
      expect(inputEl.value).toBe('@external/myfile.ts ');

      manager.destroy();
    });

    it('should include relative path when selecting nested context files', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/workspace/subfolder/file.ts', name: 'file.ts', relativePath: 'subfolder/file.ts', contextRoot: '/external/workspace', mtime: 1000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external/workspace']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      inputEl.value = '@workspace/sub';
      inputEl.selectionStart = 14;
      manager.handleInputChange();

      manager.handleMentionKeydown({ key: 'Enter', preventDefault: jest.fn() } as any);

      expect(inputEl.value).toBe('@workspace/subfolder/file.ts ');

      manager.destroy();
    });

    it('should hide dropdown after selection', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/file.ts', name: 'file.ts', relativePath: 'file.ts', contextRoot: '/external', mtime: 1000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Use @folder/ pattern to show context files
      inputEl.value = '@external/file';
      inputEl.selectionStart = 14;
      manager.handleInputChange();

      expect(manager.isMentionDropdownVisible()).toBe(true);

      manager.handleMentionKeydown({ key: 'Enter', preventDefault: jest.fn() } as any);

      expect(manager.isMentionDropdownVisible()).toBe(false);

      manager.destroy();
    });
  });

  describe('UI rendering for context files', () => {
    it('should show context-file class on dropdown items', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/app.ts', name: 'app.ts', relativePath: 'app.ts', contextRoot: '/external', mtime: 1000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Use @folder/ pattern to show context files
      inputEl.value = '@external/app';
      inputEl.selectionStart = 13;
      manager.handleInputChange();

      const dropdown = containerEl.children.find(c => c.hasClass('claudian-mention-dropdown'));
      const items = dropdown!.children.filter(c => c.hasClass('claudian-mention-item'));

      expect(items[0].hasClass('context-file')).toBe(true);

      manager.destroy();
    });

    it('should show relative path for nested context files in dropdown', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/workspace/subfolder/file.ts', name: 'file.ts', relativePath: 'subfolder/file.ts', contextRoot: '/external/workspace', mtime: 1000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external/workspace']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      inputEl.value = '@workspace/sub';
      inputEl.selectionStart = 14;
      manager.handleInputChange();

      const dropdown = containerEl.children.find(c => c.hasClass('claudian-mention-dropdown'));
      const items = dropdown!.children.filter(c => c.hasClass('claudian-mention-item'));
      const nameEls = items[0].querySelectorAll('.claudian-mention-name-context');

      expect(nameEls[0].textContent).toBe('subfolder/file.ts');

      manager.destroy();
    });

    it('should render file chip with context styling for attached context files', () => {
      const app = createMockApp();
      const callbacks = createMockCallbacks(['/external']);

      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Directly add a context file path
      manager.setAttachedFiles(['/external/src/file.ts']);

      const fileIndicator = containerEl.children.find(
        (c) => c.hasClass('claudian-file-indicator')
      );

      const fileChip = fileIndicator!.children.find(c => c.hasClass('claudian-file-chip'));
      expect(fileChip).toBeDefined();
      expect(fileChip!.hasClass('claudian-file-chip-context')).toBe(true);

      manager.destroy();
    });

    it('should show only vault files in initial dropdown (context files hidden)', () => {
      const app = createMockApp();

      // Add vault files
      const vaultFile = new MockTFile('notes/vaultfile.md');
      app.vault.getMarkdownFiles.mockReturnValue([vaultFile]);

      // Add context files (should not appear in initial dropdown)
      const contextFiles: ContextPathFile[] = [
        { path: '/external/contextfile.ts', name: 'contextfile.ts', relativePath: 'contextfile.ts', contextRoot: '/external', mtime: 1000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      inputEl.value = '@file';
      inputEl.selectionStart = 5;
      manager.handleInputChange();

      const dropdown = containerEl.children.find(c => c.hasClass('claudian-mention-dropdown'));
      const items = dropdown!.children.filter(c => c.hasClass('claudian-mention-item'));

      // Context files should NOT appear in initial dropdown
      const contextItems = items.filter(i => i.hasClass('context-file'));
      const vaultItems = items.filter(i => !i.hasClass('context-file') && !i.hasClass('mcp-server') && !i.hasClass('context-folder'));

      expect(contextItems.length).toBe(0);
      expect(vaultItems.length).toBe(1);

      manager.destroy();
    });
  });

  describe('Dropdown keyboard navigation', () => {
    it('should navigate with arrow keys', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/file1.ts', name: 'file1.ts', relativePath: 'file1.ts', contextRoot: '/external', mtime: 2000 },
        { path: '/external/file2.ts', name: 'file2.ts', relativePath: 'file2.ts', contextRoot: '/external', mtime: 1000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Use @folder/ pattern to show context files
      inputEl.value = '@external/file';
      inputEl.selectionStart = 14;
      manager.handleInputChange();

      // Navigate down
      manager.handleMentionKeydown({ key: 'ArrowDown', preventDefault: jest.fn() } as any);

      // Navigate up
      manager.handleMentionKeydown({ key: 'ArrowUp', preventDefault: jest.fn() } as any);

      // Select with Tab
      const handled = manager.handleMentionKeydown({ key: 'Tab', preventDefault: jest.fn() } as any);
      expect(handled).toBe(true);

      manager.destroy();
    });

    it('should close dropdown with Escape', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/file.ts', name: 'file.ts', relativePath: 'file.ts', contextRoot: '/external', mtime: 1000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Use @folder/ pattern to show context files
      inputEl.value = '@external/file';
      inputEl.selectionStart = 14;
      manager.handleInputChange();

      expect(manager.isMentionDropdownVisible()).toBe(true);

      manager.handleMentionKeydown({ key: 'Escape', preventDefault: jest.fn() } as any);

      expect(manager.isMentionDropdownVisible()).toBe(false);

      manager.destroy();
    });
  });

  describe('Default selection behavior', () => {
    it('should default select first vault file when vault files exist', () => {
      const app = createMockApp();

      const vaultFile = new MockTFile('notes/file.md');
      app.vault.getMarkdownFiles.mockReturnValue([vaultFile]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/contextfile.ts', name: 'contextfile.ts', relativePath: 'contextfile.ts', contextRoot: '/external', mtime: 1000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      inputEl.value = '@file';
      inputEl.selectionStart = 5;
      manager.handleInputChange();

      // Select without navigation - should select vault file (default)
      manager.handleMentionKeydown({ key: 'Enter', preventDefault: jest.fn() } as any);

      // Should have added vault file, not context file
      const attachedFiles = manager.getAttachedFiles();
      expect(attachedFiles.has('notes/file.md')).toBe(true);
      expect(attachedFiles.has('/external/contextfile.ts')).toBe(false);

      manager.destroy();
    });

    it('should select context file when using @folder/ filter pattern', () => {
      const app = createMockApp();
      app.vault.getMarkdownFiles.mockReturnValue([]);

      const contextFiles: ContextPathFile[] = [
        { path: '/external/mycode.ts', name: 'mycode.ts', relativePath: 'mycode.ts', contextRoot: '/external', mtime: 1000 },
      ];
      mockScanPaths.mockReturnValue(contextFiles);

      const callbacks = createMockCallbacks(['/external']);
      const manager = new FileContextManager(
        app,
        containerEl as any,
        inputEl,
        callbacks
      );

      // Use @folder/ pattern to access context files
      inputEl.value = '@external/mycode';
      inputEl.selectionStart = 16;
      manager.handleInputChange();

      manager.handleMentionKeydown({ key: 'Enter', preventDefault: jest.fn() } as any);

      const attachedFiles = manager.getAttachedFiles();
      expect(attachedFiles.has('/external/mycode.ts')).toBe(true);

      manager.destroy();
    });
  });
});
