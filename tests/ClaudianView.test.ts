/**
 * Tests for ClaudianView - Edited Files Feature
 * TDD: Tests written first, implementation follows
 */

import { createHash } from 'crypto';
import { TFile, WorkspaceLeaf } from 'obsidian';

import { ClaudianView } from '../src/ClaudianView';
import { FileContextManager } from '../src/ui/FileContext';

// Helper to create TFile with path (mock accepts path argument, but TS types don't)
function createTFile(path: string): TFile {
  return new (TFile as any)(path);
}

// Helper to create a mock plugin
function createMockPlugin(settingsOverrides = {}) {
  // Track registered event handlers for vault events
  const vaultEventHandlers: Map<string, ((...args: unknown[]) => void)[]> = new Map();

  return {
    settings: {
      enableBlocklist: true,
      blockedCommands: { unix: [], windows: [] },
      showToolUse: true,
      model: 'haiku',
      thinkingBudget: 'off',
      permissionMode: 'yolo',
      permissions: [],
      excludedTags: [],
      ...settingsOverrides,
    },
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault',
        },
        getAbstractFileByPath: jest.fn(),
        getMarkdownFiles: jest.fn().mockReturnValue([]),
        read: jest.fn().mockResolvedValue('mock file content'),
        on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (!vaultEventHandlers.has(event)) {
            vaultEventHandlers.set(event, []);
          }
          vaultEventHandlers.get(event)!.push(handler);
          return { event, handler };  // Return EventRef-like object
        }),
        offref: jest.fn(),
        // Helper to trigger vault events in tests
        _triggerEvent: (event: string, ...args: any[]) => {
          const handlers = vaultEventHandlers.get(event) || [];
          handlers.forEach(h => h(...args));
        },
        _eventHandlers: vaultEventHandlers,
      },
      workspace: {
        getLeaf: jest.fn().mockReturnValue({
          openFile: jest.fn().mockResolvedValue(undefined),
        }),
        getLeavesOfType: jest.fn().mockReturnValue([]),
        on: jest.fn(),
        getActiveFile: jest.fn().mockReturnValue(null),
      },
      metadataCache: {
        on: jest.fn(),
        getFileCache: jest.fn().mockReturnValue(null),
      },
    },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    agentService: {
      query: jest.fn(),
      cancel: jest.fn(),
      resetSession: jest.fn(),
      setApprovalCallback: jest.fn(),
      setSessionId: jest.fn(),
      getSessionId: jest.fn().mockReturnValue(null),
    },
    service: {
      query: jest.fn(),
      cancel: jest.fn(),
      resetSession: jest.fn(),
    },
    loadConversations: jest.fn().mockResolvedValue([]),
    saveConversations: jest.fn().mockResolvedValue(undefined),
    getConversation: jest.fn().mockReturnValue(null),
    createConversation: jest.fn().mockReturnValue({
      id: 'test-conv',
      title: 'Test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: null,
      messages: [],
    }),
    switchConversation: jest.fn().mockResolvedValue(null),
    updateConversation: jest.fn().mockResolvedValue(undefined),
  } as any;
}

const hashContent = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

// Helper to create a mock WorkspaceLeaf
function createMockLeaf() {
  return new WorkspaceLeaf();
}

// Helper to create mock DOM elements with tracking
function createMockElement(tag = 'div') {
  const children: any[] = [];
  const classList = new Set<string>();
  const attributes = new Map<string, string>();
  const eventListeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const style: Record<string, string> = {};

  const element: any = {
    tagName: tag.toUpperCase(),
    children,
    classList: {
      add: (cls: string) => classList.add(cls),
      remove: (cls: string) => classList.delete(cls),
      contains: (cls: string) => classList.has(cls),
      toggle: (cls: string) => {
        if (classList.has(cls)) classList.delete(cls);
        else classList.add(cls);
      },
    },
    addClass: (cls: string) => classList.add(cls),
    removeClass: (cls: string) => classList.delete(cls),
    hasClass: (cls: string) => classList.has(cls),
    getClasses: () => Array.from(classList),
    style,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name),
    addEventListener: (event: string, handler: (...args: unknown[]) => void) => {
      if (!eventListeners.has(event)) eventListeners.set(event, []);
      eventListeners.get(event)!.push(handler);
    },
    dispatchEvent: (event: { type: string; target?: any; stopPropagation?: () => void }) => {
      const handlers = eventListeners.get(event.type) || [];
      handlers.forEach(h => h(event));
    },
    click: () => element.dispatchEvent({ type: 'click', target: element, stopPropagation: () => {} }),
    empty: () => { children.length = 0; },
    createDiv: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement('div');
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.setText(opts.text);
      children.push(child);
      return child;
    },
    createSpan: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement('span');
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.setText(opts.text);
      children.push(child);
      return child;
    },
    createEl: (tag: string, opts?: { cls?: string; text?: string; type?: string; placeholder?: string }) => {
      const child = createMockElement(tag);
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.setText(opts.text);
      children.push(child);
      return child;
    },
    setText: (text: string) => { element.textContent = text; },
    textContent: '',
    innerHTML: '',
    querySelector: (selector: string) => {
      // Simple selector support for testing
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        return children.find((c: any) => c.hasClass?.(cls));
      }
      return null;
    },
    querySelectorAll: (selector: string) => {
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        return children.filter((c: any) => c.hasClass?.(cls));
      }
      return [];
    },
    closest: (selector: string) => {
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        if (classList.has(cls)) return element;
      }
      return null;
    },
    // For tracking in tests
    _classList: classList,
    _attributes: attributes,
    _eventListeners: eventListeners,
  };

  return element;
}

// Helper to create a FileContextManager for testing
function createFileContextManager(mockPlugin: any) {
  const containerEl = createMockElement('div');
  const inputEl = createMockElement('textarea');
  inputEl.value = '';
  inputEl.selectionStart = 0;
  inputEl.selectionEnd = 0;

  return new FileContextManager(
    mockPlugin.app,
    containerEl,
    inputEl as any,
    {
      getExcludedTags: () => mockPlugin.settings.excludedTags,
      onFileOpen: async () => {},
    }
  );
}

describe('FileContextManager - Edited Files Tracking', () => {
  let fileContextManager: FileContextManager;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();
    fileContextManager = createFileContextManager(mockPlugin);
  });

  describe('Tracking edited files from tool results', () => {
    it('should track file when Write tool completes successfully', async () => {
      const rawPath = '/test/vault/notes/test.md';
      const normalizedPath = 'notes/test.md';

      // First call markFileBeingEdited (PreToolUse hook)
      await fileContextManager.markFileBeingEdited('Write', { file_path: rawPath });
      // Then call trackEditedFile (PostToolUse hook)
      await fileContextManager.trackEditedFile('Write', { file_path: rawPath }, false);

      expect((fileContextManager as any).editedFilesThisSession.has(normalizedPath)).toBe(true);
    });

    it('should track file when Edit tool completes successfully', async () => {
      const rawPath = '/test/vault/notes/edited.md';
      const normalizedPath = 'notes/edited.md';

      // Simulate PreToolUse and PostToolUse hooks
      await fileContextManager.markFileBeingEdited('Edit', { file_path: rawPath });
      await fileContextManager.trackEditedFile('Edit', { file_path: rawPath }, false);

      expect((fileContextManager as any).editedFilesThisSession.has(normalizedPath)).toBe(true);
    });

    it('should NOT track file when tool result has error', async () => {
      const rawPath = '/test/vault/notes/error.md';
      const normalizedPath = 'notes/error.md';

      // Simulate a Write tool completing with error
      await fileContextManager.markFileBeingEdited('Write', { file_path: rawPath });
      await fileContextManager.trackEditedFile('Write', { file_path: rawPath }, true);

      expect((fileContextManager as any).editedFilesThisSession.has(normalizedPath)).toBe(false);
    });

    it('should NOT track files from Read tool', async () => {
      const rawPath = '/test/vault/notes/read.md';
      const normalizedPath = 'notes/read.md';

      // Simulate a Read tool completing (should be ignored)
      await fileContextManager.markFileBeingEdited('Read', { file_path: rawPath });
      await fileContextManager.trackEditedFile('Read', { file_path: rawPath }, false);

      expect((fileContextManager as any).editedFilesThisSession.has(normalizedPath)).toBe(false);
    });

    it('should NOT track files from Bash tool', async () => {
      // Simulate a Bash tool completing (should be ignored)
      await fileContextManager.markFileBeingEdited('Bash', { command: 'ls -la' });
      await fileContextManager.trackEditedFile('Bash', { command: 'ls -la' }, false);

      expect((fileContextManager as any).editedFilesThisSession.size).toBe(0);
    });

    it('should track NotebookEdit tool with notebook_path', async () => {
      const notebookPath = '/test/vault/notebook.ipynb';
      const normalizedPath = 'notebook.ipynb';

      // Simulate NotebookEdit tool completing
      await fileContextManager.markFileBeingEdited('NotebookEdit', { notebook_path: notebookPath });
      await fileContextManager.trackEditedFile('NotebookEdit', { notebook_path: notebookPath }, false);

      expect((fileContextManager as any).editedFilesThisSession.has(normalizedPath)).toBe(true);
    });

    it('should normalize absolute paths to vault-relative for tracking and dismissal', async () => {
      const rawPath = '/test/vault/notes/absolute.md';
      const normalizedPath = 'notes/absolute.md';

      await fileContextManager.markFileBeingEdited('Write', { file_path: rawPath });
      await fileContextManager.trackEditedFile('Write', { file_path: rawPath }, false);
      expect((fileContextManager as any).editedFilesThisSession.has(normalizedPath)).toBe(true);

      // Dismiss via private method for testing
      (fileContextManager as any).dismissEditedFile(rawPath);
      expect((fileContextManager as any).editedFilesThisSession.has(normalizedPath)).toBe(false);
    });
  });

  describe('Clearing edited files', () => {
    it('should clear edited files on resetForNewConversation()', async () => {
      // Add some edited files
      (fileContextManager as any).editedFilesThisSession.add('file1.md');
      (fileContextManager as any).editedFilesThisSession.add('file2.md');

      expect((fileContextManager as any).editedFilesThisSession.size).toBe(2);

      // Reset for new conversation
      fileContextManager.resetForNewConversation();

      expect((fileContextManager as any).editedFilesThisSession.size).toBe(0);
    });

    it('should clear edited files on new conversation', async () => {
      (fileContextManager as any).editedFilesThisSession.add('old-file.md');

      // Start new conversation
      fileContextManager.resetForNewConversation();

      expect((fileContextManager as any).editedFilesThisSession.size).toBe(0);
    });

    it('should remove file from edited set when file is focused', async () => {
      const filePath = 'notes/edited.md';
      (fileContextManager as any).editedFilesThisSession.add(filePath);
      (fileContextManager as any).editedFileHashes.set(filePath, {
        originalHash: 'hash-original',
        postEditHash: 'hash-edited',
      });

      expect((fileContextManager as any).editedFilesThisSession.has(filePath)).toBe(true);
      expect((fileContextManager as any).editedFileHashes.has(filePath)).toBe(true);

      // Simulate focusing on the file (via private method)
      (fileContextManager as any).dismissEditedFile(filePath);

      expect((fileContextManager as any).editedFilesThisSession.has(filePath)).toBe(false);
      expect((fileContextManager as any).editedFileHashes.has(filePath)).toBe(false);
    });

    it('should dismiss edited indicator when focusing file', async () => {
      const filePath = 'notes/clicked.md';
      (fileContextManager as any).editedFilesThisSession.add(filePath);

      // After focusing, file should be dismissed
      (fileContextManager as any).dismissEditedFile(filePath);

      expect((fileContextManager as any).isFileEdited(filePath)).toBe(false);
    });
  });
});

describe('ClaudianView - Handling tool results when tool UI is hidden', () => {
  let view: ClaudianView;
  let mockPlugin: any;
  let mockLeaf: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin({ showToolUse: false });
    mockLeaf = createMockLeaf();
    view = new ClaudianView(mockLeaf, mockPlugin);

    // Set up required elements
    (view as any).messagesEl = createMockElement('div');
    (view as any).messagesEl.scrollTop = 0;
    (view as any).messagesEl.scrollHeight = 0;

    // Create a mock file context manager
    const containerEl = createMockElement('div');
    const inputEl = createMockElement('textarea');
    inputEl.value = '';
    (view as any).fileContextManager = new FileContextManager(
      mockPlugin.app,
      containerEl,
      inputEl as any,
      {
        getExcludedTags: () => mockPlugin.settings.excludedTags,
        onFileOpen: async () => {},
      }
    );
  });

  it('should still track edited files from tool_result chunks', async () => {
    const msg: any = { id: 'assistant-1', role: 'assistant', content: '', timestamp: Date.now(), toolCalls: [], contentBlocks: [] };

    await (view as any).handleStreamChunk(
      { type: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: 'notes/hidden.md' } },
      msg
    );
    await (view as any).handleStreamChunk(
      { type: 'tool_result', id: 'tool-1', content: 'ok', isError: false },
      msg
    );

    expect((view as any).fileContextManager.getAttachedFiles().has('notes/hidden.md') ||
           (view as any).fileContextManager['editedFilesThisSession'].has('notes/hidden.md')).toBe(true);
  });
});

describe('FileContextManager - File Chip Click Handlers', () => {
  let fileContextManager: FileContextManager;
  let mockPlugin: any;
  let mockOpenFile: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenFile = jest.fn().mockResolvedValue(undefined);
    mockPlugin = createMockPlugin();
    mockPlugin.app.workspace.getLeaf = jest.fn().mockReturnValue({
      openFile: mockOpenFile,
    });
    mockPlugin.app.openWithDefaultApp = jest.fn().mockResolvedValue(undefined);
    fileContextManager = createFileContextManager(mockPlugin);
  });

  describe('Opening files on chip click', () => {
    it('should open file in new tab when chip is clicked', async () => {
      const filePath = 'notes/test.md';
      const mockFile = createTFile(filePath);

      mockPlugin.app.vault.getAbstractFileByPath.mockReturnValue(mockFile);

      // Simulate opening file from chip click (via private method)
      await (fileContextManager as any).openFileFromChip(filePath);

      expect(mockPlugin.app.vault.getAbstractFileByPath).toHaveBeenCalledWith(filePath);
      expect(mockPlugin.app.workspace.getLeaf).toHaveBeenCalledWith('tab');
      expect(mockOpenFile).toHaveBeenCalledWith(mockFile);
    });

    it('should NOT open file if file does not exist in vault', async () => {
      const filePath = 'notes/nonexistent.md';

      mockPlugin.app.vault.getAbstractFileByPath.mockReturnValue(null);

      await (fileContextManager as any).openFileFromChip(filePath);

      expect(mockPlugin.app.vault.getAbstractFileByPath).toHaveBeenCalledWith(filePath);
      expect(mockOpenFile).not.toHaveBeenCalled();
      expect(mockPlugin.app.openWithDefaultApp).not.toHaveBeenCalled();
    });

    it('should open vault file in Obsidian even if non-markdown', async () => {
      const filePath = 'assets/image.png';
      const mockFile = createTFile(filePath);

      mockPlugin.app.vault.getAbstractFileByPath.mockReturnValue(mockFile);

      await (fileContextManager as any).openFileFromChip(filePath);

      expect(mockOpenFile).toHaveBeenCalledWith(mockFile);
      expect(mockPlugin.app.openWithDefaultApp).not.toHaveBeenCalled();
    });

    it('should open external absolute path with default app and dismiss chip', async () => {
      const filePath = '/external/file.pdf';

      mockPlugin.app.vault.getAbstractFileByPath.mockReturnValue(null);
      (fileContextManager as any).editedFilesThisSession.add(filePath);

      await (fileContextManager as any).openFileFromChip(filePath);

      expect(mockPlugin.app.openWithDefaultApp).toHaveBeenCalledWith(filePath);
      expect(mockOpenFile).not.toHaveBeenCalled();
      expect((fileContextManager as any).editedFilesThisSession.has(filePath)).toBe(false);
    });

    it('should fall back to default app when openFile fails', async () => {
      const filePath = 'assets/image.png';
      const mockFile = createTFile(filePath);

      mockPlugin.app.vault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockPlugin.app.workspace.getLeaf = jest.fn().mockReturnValue({
        openFile: jest.fn().mockRejectedValue(new Error('open failed')),
      });
      (fileContextManager as any).editedFilesThisSession.add(filePath);

      await (fileContextManager as any).openFileFromChip(filePath);

      expect(mockPlugin.app.openWithDefaultApp).toHaveBeenCalledWith('/test/vault/assets/image.png');
      expect((fileContextManager as any).editedFilesThisSession.has(filePath)).toBe(false);
    });
  });

  describe('Edited class on chips', () => {
    it('should return true when file is in editedFilesThisSession', () => {
      const filePath = 'edited.md';
      (fileContextManager as any).editedFilesThisSession.add(filePath);

      const isEdited = (fileContextManager as any).isFileEdited(filePath);

      expect(isEdited).toBe(true);
    });

    it('should return false when file is NOT in editedFilesThisSession', () => {
      const filePath = 'not-edited.md';

      const isEdited = (fileContextManager as any).isFileEdited(filePath);

      expect(isEdited).toBe(false);
    });
  });
});

describe('FileContextManager - Edited Files Section', () => {
  let fileContextManager: FileContextManager;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();
    fileContextManager = createFileContextManager(mockPlugin);
  });

  describe('Visibility logic', () => {
    it('should return non-attached edited files only', () => {
      // File is edited but NOT attached
      (fileContextManager as any).editedFilesThisSession.add('edited1.md');
      (fileContextManager as any).editedFilesThisSession.add('edited2.md');
      // This file is both edited AND attached
      (fileContextManager as any).editedFilesThisSession.add('attached.md');
      (fileContextManager as any).attachedFiles.add('attached.md');

      const nonAttached = (fileContextManager as any).getNonAttachedEditedFiles();

      expect(nonAttached).toHaveLength(2);
      expect(nonAttached).toContain('edited1.md');
      expect(nonAttached).toContain('edited2.md');
      expect(nonAttached).not.toContain('attached.md');
    });

    it('should return empty array when all edited files are attached', () => {
      (fileContextManager as any).editedFilesThisSession.add('file.md');
      (fileContextManager as any).attachedFiles.add('file.md');

      const nonAttached = (fileContextManager as any).getNonAttachedEditedFiles();

      expect(nonAttached).toHaveLength(0);
    });

    it('should return empty array when no files are edited', () => {
      const nonAttached = (fileContextManager as any).getNonAttachedEditedFiles();

      expect(nonAttached).toHaveLength(0);
    });

    it('should show edited files section when has non-attached edited files', () => {
      (fileContextManager as any).editedFilesThisSession.add('edited.md');

      const shouldShow = (fileContextManager as any).shouldShowEditedFilesSection();

      expect(shouldShow).toBe(true);
    });

    it('should NOT show edited files section when all edited files are attached', () => {
      (fileContextManager as any).editedFilesThisSession.add('attached.md');
      (fileContextManager as any).attachedFiles.add('attached.md');

      const shouldShow = (fileContextManager as any).shouldShowEditedFilesSection();

      expect(shouldShow).toBe(false);
    });

    it('should NOT show edited files section when no files are edited', () => {
      const shouldShow = (fileContextManager as any).shouldShowEditedFilesSection();

      expect(shouldShow).toBe(false);
    });
  });

  describe('UI refresh on attachment changes', () => {
    it('should hide edited section when an edited file becomes attached', () => {
      (fileContextManager as any).editedFilesThisSession.add('notes/edited.md');

      (fileContextManager as any).updateEditedFilesIndicator();
      expect((fileContextManager as any).editedFilesIndicatorEl.style.display).toBe('flex');

      (fileContextManager as any).attachedFiles.add('notes/edited.md');
      (fileContextManager as any).updateFileIndicator();

      expect((fileContextManager as any).editedFilesIndicatorEl.style.display).toBe('none');
    });

    it('should show edited section when an edited attached file is removed', () => {
      (fileContextManager as any).editedFilesThisSession.add('notes/edited.md');
      (fileContextManager as any).attachedFiles.add('notes/edited.md');

      (fileContextManager as any).updateFileIndicator();
      expect((fileContextManager as any).editedFilesIndicatorEl.style.display).toBe('none');

      (fileContextManager as any).attachedFiles.delete('notes/edited.md');
      (fileContextManager as any).updateFileIndicator();

      expect((fileContextManager as any).editedFilesIndicatorEl.style.display).toBe('flex');
    });
  });
});

describe('ClaudianView - Conversation boundaries', () => {
  it('should clear edited files when switching conversations', async () => {
    const mockPlugin = createMockPlugin();
    mockPlugin.agentService.getSessionId = jest.fn().mockReturnValue(null);
    mockPlugin.switchConversation = jest.fn().mockResolvedValue({
      id: 'conv-2',
      messages: [],
      sessionId: null,
    });

    const view = new ClaudianView(createMockLeaf(), mockPlugin);
    (view as any).messagesEl = createMockElement('div');
    (view as any).currentConversationId = 'conv-1';
    (view as any).messages = [];

    // Create a mock file context manager
    const containerEl = createMockElement('div');
    const inputEl = createMockElement('textarea');
    inputEl.value = '';
    (view as any).inputEl = inputEl;
    (view as any).fileContextManager = new FileContextManager(
      mockPlugin.app,
      containerEl,
      inputEl as any,
      {
        getExcludedTags: () => mockPlugin.settings.excludedTags,
        onFileOpen: async () => {},
      }
    );
    ((view as any).fileContextManager as any).editedFilesThisSession.add('notes/old.md');

    await (view as any).onConversationSelect('conv-2');

    expect(((view as any).fileContextManager as any).editedFilesThisSession.size).toBe(0);
  });
});

describe('FileContextManager - Excluded Tags', () => {
  let fileContextManager: FileContextManager;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin({ excludedTags: ['system', 'private'] });
    fileContextManager = createFileContextManager(mockPlugin);
  });

  describe('hasExcludedTag', () => {
    it('should return false when excludedTags is empty', () => {
      mockPlugin.settings.excludedTags = [];
      const file = createTFile('notes/test.md');

      const result = (fileContextManager as any).hasExcludedTag(file);

      expect(result).toBe(false);
    });

    it('should return false when file has no cache', () => {
      mockPlugin.app.metadataCache.getFileCache.mockReturnValue(null);
      const file = createTFile('notes/test.md');

      const result = (fileContextManager as any).hasExcludedTag(file);

      expect(result).toBe(false);
    });

    it('should return false when file has no tags', () => {
      mockPlugin.app.metadataCache.getFileCache.mockReturnValue({});
      const file = createTFile('notes/test.md');

      const result = (fileContextManager as any).hasExcludedTag(file);

      expect(result).toBe(false);
    });

    it('should detect excluded tag in frontmatter tags array', () => {
      mockPlugin.app.metadataCache.getFileCache.mockReturnValue({
        frontmatter: { tags: ['system', 'notes'] },
      });
      const file = createTFile('notes/test.md');

      const result = (fileContextManager as any).hasExcludedTag(file);

      expect(result).toBe(true);
    });

    it('should detect excluded tag in frontmatter tags string', () => {
      mockPlugin.app.metadataCache.getFileCache.mockReturnValue({
        frontmatter: { tags: 'system' },
      });
      const file = createTFile('notes/test.md');

      const result = (fileContextManager as any).hasExcludedTag(file);

      expect(result).toBe(true);
    });

    it('should detect excluded tag in inline tags', () => {
      mockPlugin.app.metadataCache.getFileCache.mockReturnValue({
        tags: [{ tag: '#system', position: { start: { line: 5 } } }],
      });
      const file = createTFile('notes/test.md');

      const result = (fileContextManager as any).hasExcludedTag(file);

      expect(result).toBe(true);
    });

    it('should handle tags with # prefix in frontmatter', () => {
      mockPlugin.app.metadataCache.getFileCache.mockReturnValue({
        frontmatter: { tags: ['#system'] },
      });
      const file = createTFile('notes/test.md');

      const result = (fileContextManager as any).hasExcludedTag(file);

      expect(result).toBe(true);
    });

    it('should return false when file has non-excluded tags only', () => {
      mockPlugin.app.metadataCache.getFileCache.mockReturnValue({
        frontmatter: { tags: ['notes', 'journal'] },
        tags: [{ tag: '#todo' }],
      });
      const file = createTFile('notes/test.md');

      const result = (fileContextManager as any).hasExcludedTag(file);

      expect(result).toBe(false);
    });

    it('should match any of multiple excluded tags', () => {
      mockPlugin.app.metadataCache.getFileCache.mockReturnValue({
        frontmatter: { tags: ['private'] },  // 'private' is in excludedTags
      });
      const file = createTFile('notes/secret.md');

      const result = (fileContextManager as any).hasExcludedTag(file);

      expect(result).toBe(true);
    });
  });

  describe('Auto-attach exclusion', () => {
    it('should NOT auto-attach file with excluded tag on file-open', () => {
      mockPlugin.app.metadataCache.getFileCache.mockReturnValue({
        frontmatter: { tags: ['system'] },
      });
      const file = createTFile('notes/system-file.md');

      // Simulate the check that happens during file-open
      const hasExcluded = (fileContextManager as any).hasExcludedTag(file);

      expect(hasExcluded).toBe(true);
      // File should NOT be added to attachedFiles
    });

    it('should auto-attach file without excluded tags', () => {
      mockPlugin.app.metadataCache.getFileCache.mockReturnValue({
        frontmatter: { tags: ['notes'] },
      });
      const file = createTFile('notes/normal-file.md');

      const hasExcluded = (fileContextManager as any).hasExcludedTag(file);

      expect(hasExcluded).toBe(false);
      // File CAN be added to attachedFiles
    });
  });
});

describe('FileContextManager - File Hash Tracking', () => {
  let fileContextManager: FileContextManager;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();
    fileContextManager = createFileContextManager(mockPlugin);
  });

  describe('markFileBeingEdited', () => {
    it('should mark file as being edited and capture original hash', async () => {
      const filePath = 'notes/test.md';
      const mockFile = createTFile(filePath);
      mockPlugin.app.vault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockPlugin.app.vault.read.mockResolvedValue('original content');

      await fileContextManager.markFileBeingEdited('Write', { file_path: filePath });

      expect((fileContextManager as any).filesBeingEdited.has(filePath)).toBe(true);
      expect((fileContextManager as any).editedFileHashes.has(filePath)).toBe(true);
      const hashState = (fileContextManager as any).editedFileHashes.get(filePath);
      expect(hashState.originalHash).not.toBeNull();
    });

    it('should NOT mark file for non-edit tools', async () => {
      const filePath = 'notes/test.md';

      await fileContextManager.markFileBeingEdited('Read', { file_path: filePath });

      expect((fileContextManager as any).filesBeingEdited.has(filePath)).toBe(false);
    });

    it('should capture null originalHash for new files', async () => {
      const filePath = 'notes/new-file.md';
      mockPlugin.app.vault.getAbstractFileByPath.mockReturnValue(null);

      await fileContextManager.markFileBeingEdited('Write', { file_path: filePath });

      const hashState = (fileContextManager as any).editedFileHashes.get(filePath);
      expect(hashState.originalHash).toBeNull();
    });
  });

  describe('trackEditedFile with hash tracking', () => {
    it('should store post-edit hash after successful edit', async () => {
      const filePath = 'notes/test.md';
      const mockFile = createTFile(filePath);
      mockPlugin.app.vault.getAbstractFileByPath.mockReturnValue(mockFile);
      mockPlugin.app.vault.read
        .mockResolvedValueOnce('original content')  // For markFileBeingEdited
        .mockResolvedValueOnce('new content');      // For trackEditedFile

      await fileContextManager.markFileBeingEdited('Write', { file_path: filePath });
      await fileContextManager.trackEditedFile('Write', { file_path: filePath }, false);

      const hashState = (fileContextManager as any).editedFileHashes.get(filePath);
      expect(hashState.postEditHash).not.toBe('');
    });

    it('should remove tracking if content reverts to original', async () => {
      const filePath = 'notes/test.md';
      const mockFile = createTFile(filePath);
      mockPlugin.app.vault.getAbstractFileByPath.mockReturnValue(mockFile);
      // Same content for both reads = revert to original
      mockPlugin.app.vault.read.mockResolvedValue('same content');

      await fileContextManager.markFileBeingEdited('Write', { file_path: filePath });
      await fileContextManager.trackEditedFile('Write', { file_path: filePath }, false);

      // File should not be tracked because content matches original
      expect((fileContextManager as any).editedFilesThisSession.has(filePath)).toBe(false);
    });

    it('should unmark filesBeingEdited on error', async () => {
      const filePath = 'notes/error.md';

      await fileContextManager.markFileBeingEdited('Write', { file_path: filePath });
      expect((fileContextManager as any).filesBeingEdited.has(filePath)).toBe(true);

      await fileContextManager.trackEditedFile('Write', { file_path: filePath }, true);
      expect((fileContextManager as any).filesBeingEdited.has(filePath)).toBe(false);
    });

    it('should refresh baseline on sequential edits', async () => {
      const filePath = 'notes/sequence.md';
      const computeSpy = jest
        .spyOn(fileContextManager as any, 'computeFileHash')
        .mockResolvedValueOnce('hash-original-1') // mark #1
        .mockResolvedValueOnce('hash-post-1')     // track #1
        .mockResolvedValueOnce('hash-original-2') // mark #2
        .mockResolvedValueOnce('hash-post-2');    // track #2

      await fileContextManager.markFileBeingEdited('Write', { file_path: filePath });
      await fileContextManager.trackEditedFile('Write', { file_path: filePath }, false);

      const firstState = (fileContextManager as any).editedFileHashes.get(filePath);
      expect(firstState.originalHash).toBe('hash-original-1');
      expect(firstState.postEditHash).toBe('hash-post-1');

      await fileContextManager.markFileBeingEdited('Write', { file_path: filePath });
      await fileContextManager.trackEditedFile('Write', { file_path: filePath }, false);

      const secondState = (fileContextManager as any).editedFileHashes.get(filePath);
      expect(secondState.originalHash).toBe('hash-original-2');
      expect(secondState.postEditHash).toBe('hash-post-2');

      computeSpy.mockRestore();
    });
  });

  describe('File deletion handling', () => {
    it('should remove chip when file is deleted', async () => {
      const filePath = 'notes/deleted.md';

      // Manually add to edited files
      (fileContextManager as any).editedFilesThisSession.add(filePath);
      (fileContextManager as any).editedFileHashes.set(filePath, {
        originalHash: 'hash1',
        postEditHash: 'hash2',
      });

      // Trigger delete event
      (fileContextManager as any).handleFileDeleted(filePath);

      expect((fileContextManager as any).editedFilesThisSession.has(filePath)).toBe(false);
      expect((fileContextManager as any).editedFileHashes.has(filePath)).toBe(false);
    });

    it('should ignore delete for non-tracked files', () => {
      const filePath = 'notes/not-tracked.md';

      // This should not throw
      (fileContextManager as any).handleFileDeleted(filePath);

      expect((fileContextManager as any).editedFilesThisSession.size).toBe(0);
    });
  });

  describe('cancelFileEdit', () => {
    it('should clean up state when permission is denied', () => {
      const filePath = 'notes/cancel.md';

      (fileContextManager as any).filesBeingEdited.add(filePath);
      (fileContextManager as any).editedFileHashes.set(filePath, {
        originalHash: 'hash1',
        postEditHash: '',
      });

      fileContextManager.cancelFileEdit('Write', { file_path: filePath });

      expect((fileContextManager as any).filesBeingEdited.has(filePath)).toBe(false);
      expect((fileContextManager as any).editedFileHashes.has(filePath)).toBe(false);
    });
  });

  describe('File rename handling', () => {
    it('should update path when file is renamed', () => {
      const oldPath = 'notes/old-name.md';
      const newPath = 'notes/new-name.md';

      // Add file to tracking
      (fileContextManager as any).editedFilesThisSession.add(oldPath);
      (fileContextManager as any).editedFileHashes.set(oldPath, {
        originalHash: 'hash1',
        postEditHash: 'hash2',
      });

      // Trigger rename
      (fileContextManager as any).handleFileRenamed(oldPath, newPath);

      expect((fileContextManager as any).editedFilesThisSession.has(oldPath)).toBe(false);
      expect((fileContextManager as any).editedFilesThisSession.has(newPath)).toBe(true);
      expect((fileContextManager as any).editedFileHashes.has(oldPath)).toBe(false);
      expect((fileContextManager as any).editedFileHashes.has(newPath)).toBe(true);
    });
  });

  describe('File revert detection', () => {
    it('should remove chip when content reverts to original', async () => {
      const filePath = 'notes/reverted.md';
      const mockFile = createTFile(filePath);
      mockPlugin.app.vault.getAbstractFileByPath.mockReturnValue(mockFile);

      // Setup: file was edited
      (fileContextManager as any).editedFilesThisSession.add(filePath);
      (fileContextManager as any).editedFileHashes.set(filePath, {
        originalHash: hashContent('original content'),
        postEditHash: hashContent('new content'),
      });

      // Simulate file content reverting to original
      mockPlugin.app.vault.read.mockResolvedValue('original content');

      await (fileContextManager as any).handleFileModified(mockFile);

      expect((fileContextManager as any).editedFilesThisSession.has(filePath)).toBe(false);
    });

    it('should keep chip when content differs from both original and edit', async () => {
      const filePath = 'notes/modified.md';
      const mockFile = createTFile(filePath);
      mockPlugin.app.vault.getAbstractFileByPath.mockReturnValue(mockFile);

      // Setup: file was edited
      (fileContextManager as any).editedFilesThisSession.add(filePath);
      (fileContextManager as any).editedFileHashes.set(filePath, {
        originalHash: hashContent('original content'),
        postEditHash: hashContent('new content'),
      });

      // Simulate file content changed to something else entirely
      mockPlugin.app.vault.read.mockResolvedValue('completely different content');

      await (fileContextManager as any).handleFileModified(mockFile);

      // Chip should stay (conservative approach)
      expect((fileContextManager as any).editedFilesThisSession.has(filePath)).toBe(true);
    });

    it('should keep chip when only middle content changes with same length and boundaries', async () => {
      const filePath = 'notes/boundary-change.md';
      const mockFile = createTFile(filePath);
      mockPlugin.app.vault.getAbstractFileByPath.mockReturnValue(mockFile);

      const originalContent = 'A'.repeat(100) + '1234567890' + 'B'.repeat(100);
      const changedContent = 'A'.repeat(100) + 'abcdefghij' + 'B'.repeat(100); // Same length, different middle

      (fileContextManager as any).editedFilesThisSession.add(filePath);
      (fileContextManager as any).editedFileHashes.set(filePath, {
        originalHash: hashContent(originalContent),
        postEditHash: hashContent(changedContent),
      });

      mockPlugin.app.vault.read.mockResolvedValue(changedContent);

      await (fileContextManager as any).handleFileModified(mockFile);

      expect((fileContextManager as any).editedFilesThisSession.has(filePath)).toBe(true);
    });

    it('should ignore modify events while file is being edited', async () => {
      const filePath = 'notes/being-edited.md';
      const mockFile = createTFile(filePath);
      mockPlugin.app.vault.getAbstractFileByPath.mockReturnValue(mockFile);

      // Setup: file is being edited by Claude
      (fileContextManager as any).editedFilesThisSession.add(filePath);
      (fileContextManager as any).filesBeingEdited.add(filePath);
      (fileContextManager as any).editedFileHashes.set(filePath, {
        originalHash: hashContent('original content'),
        postEditHash: '',
      });

      // This should be ignored because file is being edited
      await (fileContextManager as any).handleFileModified(mockFile);

      // Chip should still be there
      expect((fileContextManager as any).editedFilesThisSession.has(filePath)).toBe(true);
    });
  });

  describe('Session cleanup', () => {
    it('should clear all hash state on resetForNewConversation', () => {
      // Setup some state
      (fileContextManager as any).editedFilesThisSession.add('file1.md');
      (fileContextManager as any).editedFileHashes.set('file1.md', {
        originalHash: 'hash1',
        postEditHash: 'hash2',
      });
      (fileContextManager as any).filesBeingEdited.add('file2.md');

      fileContextManager.resetForNewConversation();

      expect((fileContextManager as any).editedFilesThisSession.size).toBe(0);
      expect((fileContextManager as any).editedFileHashes.size).toBe(0);
      expect((fileContextManager as any).filesBeingEdited.size).toBe(0);
    });

    it('should clear all hash state on resetForLoadedConversation', () => {
      // Setup some state
      (fileContextManager as any).editedFilesThisSession.add('file1.md');
      (fileContextManager as any).editedFileHashes.set('file1.md', {
        originalHash: 'hash1',
        postEditHash: 'hash2',
      });

      fileContextManager.resetForLoadedConversation(true);

      expect((fileContextManager as any).editedFilesThisSession.size).toBe(0);
      expect((fileContextManager as any).editedFileHashes.size).toBe(0);
    });
  });

  describe('destroy cleanup', () => {
    it('should unregister vault event listeners', () => {
      fileContextManager.destroy();

      expect(mockPlugin.app.vault.offref).toHaveBeenCalledTimes(3);
    });
  });
});

describe('FileContextManager - Border indicator sync with @ mentions', () => {
  let fileContextManager: FileContextManager;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();
    fileContextManager = createFileContextManager(mockPlugin);
  });

  it('should remove border from attached file when file is deleted', () => {
    const filePath = 'notes/attached.md';

    // File is both attached and edited
    (fileContextManager as any).attachedFiles.add(filePath);
    (fileContextManager as any).editedFilesThisSession.add(filePath);
    (fileContextManager as any).editedFileHashes.set(filePath, {
      originalHash: 'hash1',
      postEditHash: 'hash2',
    });

    // Verify file is marked as edited
    expect((fileContextManager as any).isFileEdited(filePath)).toBe(true);

    // Trigger delete
    (fileContextManager as any).handleFileDeleted(filePath);

    // File should no longer be marked as edited
    expect((fileContextManager as any).isFileEdited(filePath)).toBe(false);
  });

  it('should update border indicator path when attached file is renamed', () => {
    const oldPath = 'notes/old.md';
    const newPath = 'notes/new.md';

    // File is both attached and edited
    (fileContextManager as any).attachedFiles.add(oldPath);
    (fileContextManager as any).editedFilesThisSession.add(oldPath);

    // Trigger rename
    (fileContextManager as any).handleFileRenamed(oldPath, newPath);

    // Old path should not be edited, new path should be
    expect((fileContextManager as any).isFileEdited(oldPath)).toBe(false);
    expect((fileContextManager as any).isFileEdited(newPath)).toBe(true);
  });
});

describe('FileContextManager - Attached Files Persistence', () => {
  let fileContextManager: FileContextManager;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();
    fileContextManager = createFileContextManager(mockPlugin);
  });

  describe('setAttachedFiles', () => {
    it('should set attached files from array', () => {
      const files = ['notes/file1.md', 'notes/file2.md', 'docs/readme.md'];

      fileContextManager.setAttachedFiles(files);

      expect(fileContextManager.getAttachedFiles().size).toBe(3);
      expect(fileContextManager.getAttachedFiles().has('notes/file1.md')).toBe(true);
      expect(fileContextManager.getAttachedFiles().has('notes/file2.md')).toBe(true);
      expect(fileContextManager.getAttachedFiles().has('docs/readme.md')).toBe(true);
    });

    it('should clear existing attached files before setting new ones', () => {
      // First set some files
      (fileContextManager as any).attachedFiles.add('old/file.md');

      // Now set new files
      fileContextManager.setAttachedFiles(['new/file.md']);

      expect(fileContextManager.getAttachedFiles().size).toBe(1);
      expect(fileContextManager.getAttachedFiles().has('old/file.md')).toBe(false);
      expect(fileContextManager.getAttachedFiles().has('new/file.md')).toBe(true);
    });

    it('should also update lastSentFiles to prevent re-sending', () => {
      const files = ['notes/file1.md', 'notes/file2.md'];

      fileContextManager.setAttachedFiles(files);

      // Files should be marked as "sent" so hasFilesChanged returns false
      expect(fileContextManager.hasFilesChanged()).toBe(false);
    });

    it('should handle empty array', () => {
      // Start with some files
      (fileContextManager as any).attachedFiles.add('file.md');

      fileContextManager.setAttachedFiles([]);

      expect(fileContextManager.getAttachedFiles().size).toBe(0);
    });
  });

  describe('hasFilesChanged', () => {
    it('should return true when files have been added', () => {
      (fileContextManager as any).attachedFiles.add('new-file.md');

      expect(fileContextManager.hasFilesChanged()).toBe(true);
    });

    it('should return false when no files have changed', () => {
      // Set and mark as sent
      fileContextManager.setAttachedFiles(['file.md']);

      expect(fileContextManager.hasFilesChanged()).toBe(false);
    });

    it('should return true when files have been removed', () => {
      // Set files and mark as sent
      fileContextManager.setAttachedFiles(['file1.md', 'file2.md']);
      fileContextManager.markFilesSent();

      // Remove one
      (fileContextManager as any).attachedFiles.delete('file1.md');

      expect(fileContextManager.hasFilesChanged()).toBe(true);
    });

    it('should return true when different files are attached', () => {
      // Set files and mark as sent
      fileContextManager.setAttachedFiles(['file1.md']);
      fileContextManager.markFilesSent();

      // Replace with different file
      (fileContextManager as any).attachedFiles.clear();
      (fileContextManager as any).attachedFiles.add('file2.md');

      expect(fileContextManager.hasFilesChanged()).toBe(true);
    });
  });

  describe('markFilesSent', () => {
    it('should sync lastSentFiles with attachedFiles', () => {
      (fileContextManager as any).attachedFiles.add('file1.md');
      (fileContextManager as any).attachedFiles.add('file2.md');

      fileContextManager.markFilesSent();

      expect(fileContextManager.hasFilesChanged()).toBe(false);

      // Adding a new file should show change
      (fileContextManager as any).attachedFiles.add('file3.md');
      expect(fileContextManager.hasFilesChanged()).toBe(true);
    });
  });
});

describe('FileContextManager - @ Mention Dropdown', () => {
  let fileContextManager: FileContextManager;
  let mockPlugin: any;
  let inputEl: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();

    // Create input element with mock methods
    inputEl = createMockElement('textarea');
    inputEl.value = '';
    inputEl.selectionStart = 0;
    inputEl.selectionEnd = 0;
    inputEl.focus = jest.fn();  // Add focus method for selectMentionItem

    const containerEl = createMockElement('div');

    fileContextManager = new FileContextManager(
      mockPlugin.app,
      containerEl,
      inputEl as any,
      {
        getExcludedTags: () => mockPlugin.settings.excludedTags,
        onFileOpen: async () => {},
      }
    );
  });

  describe('handleInputChange - whitespace detection', () => {
    it('should hide dropdown when text after @ contains space', () => {
      inputEl.value = '@file ';
      inputEl.selectionStart = 6;

      fileContextManager.handleInputChange();

      expect(fileContextManager.isMentionDropdownVisible()).toBe(false);
    });

    it('should hide dropdown when text after @ contains tab', () => {
      inputEl.value = '@file\t';
      inputEl.selectionStart = 6;

      fileContextManager.handleInputChange();

      expect(fileContextManager.isMentionDropdownVisible()).toBe(false);
    });

    it('should hide dropdown when text after @ contains newline', () => {
      inputEl.value = '@file\nmore text';
      inputEl.selectionStart = 6;

      fileContextManager.handleInputChange();

      expect(fileContextManager.isMentionDropdownVisible()).toBe(false);
    });

    it('should keep dropdown open when typing continuous text', () => {
      // Mock the markdown files
      mockPlugin.app.vault.getMarkdownFiles.mockReturnValue([
        createTFile('notes/test.md'),
      ]);

      inputEl.value = '@test';
      inputEl.selectionStart = 5;

      fileContextManager.handleInputChange();

      // Dropdown should be showing (or at least mentionStartIndex set)
      expect((fileContextManager as any).mentionStartIndex).toBe(0);
    });

    it('should hide dropdown when @ is mid-word (not triggered)', () => {
      inputEl.value = 'email@test';
      inputEl.selectionStart = 10;

      fileContextManager.handleInputChange();

      expect(fileContextManager.isMentionDropdownVisible()).toBe(false);
    });

    it('should trigger dropdown when @ is at start', () => {
      mockPlugin.app.vault.getMarkdownFiles.mockReturnValue([]);
      inputEl.value = '@';
      inputEl.selectionStart = 1;

      fileContextManager.handleInputChange();

      expect((fileContextManager as any).mentionStartIndex).toBe(0);
    });

    it('should trigger dropdown when @ follows whitespace', () => {
      mockPlugin.app.vault.getMarkdownFiles.mockReturnValue([]);
      inputEl.value = 'hello @';
      inputEl.selectionStart = 7;

      fileContextManager.handleInputChange();

      expect((fileContextManager as any).mentionStartIndex).toBe(6);
    });
  });

  describe('handleMentionKeydown', () => {
    it('should return false when dropdown is not visible', () => {
      const event = { key: 'Enter', preventDefault: jest.fn() } as any;

      const handled = fileContextManager.handleMentionKeydown(event);

      expect(handled).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('should handle Escape to close dropdown', () => {
      // Make dropdown visible
      (fileContextManager as any).mentionDropdown = createMockElement('div');
      (fileContextManager as any).mentionDropdown.addClass('visible');

      const event = { key: 'Escape', preventDefault: jest.fn() } as any;

      const handled = fileContextManager.handleMentionKeydown(event);

      expect(handled).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(fileContextManager.isMentionDropdownVisible()).toBe(false);
    });

    it('should handle ArrowDown navigation', () => {
      (fileContextManager as any).mentionDropdown = createMockElement('div');
      (fileContextManager as any).mentionDropdown.addClass('visible');
      (fileContextManager as any).filteredFiles = [createTFile('a.md'), createTFile('b.md')];
      (fileContextManager as any).selectedMentionIndex = 0;

      const event = { key: 'ArrowDown', preventDefault: jest.fn() } as any;

      const handled = fileContextManager.handleMentionKeydown(event);

      expect(handled).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('should handle ArrowUp navigation', () => {
      (fileContextManager as any).mentionDropdown = createMockElement('div');
      (fileContextManager as any).mentionDropdown.addClass('visible');
      (fileContextManager as any).filteredFiles = [createTFile('a.md'), createTFile('b.md')];
      (fileContextManager as any).selectedMentionIndex = 1;

      const event = { key: 'ArrowUp', preventDefault: jest.fn() } as any;

      const handled = fileContextManager.handleMentionKeydown(event);

      expect(handled).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('should handle Tab for selection', () => {
      (fileContextManager as any).mentionDropdown = createMockElement('div');
      (fileContextManager as any).mentionDropdown.addClass('visible');
      (fileContextManager as any).filteredFiles = [createTFile('file.md')];

      const event = { key: 'Tab', preventDefault: jest.fn() } as any;

      const handled = fileContextManager.handleMentionKeydown(event);

      expect(handled).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
    });
  });
});

describe('FileContextManager - Session State', () => {
  let fileContextManager: FileContextManager;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();
    fileContextManager = createFileContextManager(mockPlugin);
  });

  describe('session lifecycle', () => {
    it('should start with session not started', () => {
      expect(fileContextManager.isSessionStarted()).toBe(false);
    });

    it('should mark session as started', () => {
      fileContextManager.startSession();

      expect(fileContextManager.isSessionStarted()).toBe(true);
    });

    it('should reset session on new conversation', () => {
      fileContextManager.startSession();
      (fileContextManager as any).attachedFiles.add('file.md');

      fileContextManager.resetForNewConversation();

      expect(fileContextManager.isSessionStarted()).toBe(false);
      expect(fileContextManager.getAttachedFiles().size).toBe(0);
    });

    it('should set session started based on message history', () => {
      fileContextManager.resetForLoadedConversation(true);
      expect(fileContextManager.isSessionStarted()).toBe(true);

      fileContextManager.resetForLoadedConversation(false);
      expect(fileContextManager.isSessionStarted()).toBe(false);
    });
  });
});

describe('ClaudianView - Message Queue', () => {
  let view: ClaudianView;
  let mockPlugin: any;
  let mockLeaf: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();
    mockLeaf = createMockLeaf();
    view = new ClaudianView(mockLeaf, mockPlugin);

    // Set up required elements
    (view as any).messagesEl = createMockElement('div');
    (view as any).messagesEl.scrollTop = 0;
    (view as any).messagesEl.scrollHeight = 0;

    const inputEl = createMockElement('textarea');
    inputEl.value = '';
    (view as any).inputEl = inputEl;

    const containerEl = createMockElement('div');
    (view as any).queueIndicatorEl = containerEl.createDiv({ cls: 'claudian-queue-indicator' });
    (view as any).queueIndicatorEl.style = { display: 'none' };

    // Create mock image context manager
    (view as any).imageContextManager = {
      hasImages: jest.fn().mockReturnValue(false),
      getAttachedImages: jest.fn().mockReturnValue([]),
      clearImages: jest.fn(),
      setImages: jest.fn(),
    };

    // Create mock file context manager
    (view as any).fileContextManager = {
      startSession: jest.fn(),
      resetForNewConversation: jest.fn(),
      autoAttachActiveFile: jest.fn(),
      resetForLoadedConversation: jest.fn(),
      setAttachedFiles: jest.fn(),
      getAttachedFiles: jest.fn().mockReturnValue(new Set()),
      hasFilesChanged: jest.fn().mockReturnValue(false),
      markFilesSent: jest.fn(),
    };

    // Initialize messages and conversation
    (view as any).messages = [];
    (view as any).currentConversationId = 'test-conv';
  });

  describe('Queuing messages while streaming', () => {
    it('should queue message when isStreaming is true', () => {
      (view as any).isStreaming = true;
      (view as any).inputEl.value = 'queued message';

      (view as any).sendMessage();

      expect((view as any).queuedMessage).toEqual({
        content: 'queued message',
        images: undefined,
        editorContext: null,
      });
      expect((view as any).inputEl.value).toBe('');
    });

    it('should queue message with images when streaming', () => {
      (view as any).isStreaming = true;
      (view as any).inputEl.value = 'queued with images';
      const mockImages = [{ id: 'img1', name: 'test.png' }];
      (view as any).imageContextManager.hasImages.mockReturnValue(true);
      (view as any).imageContextManager.getAttachedImages.mockReturnValue(mockImages);

      (view as any).sendMessage();

      expect((view as any).queuedMessage).toEqual({
        content: 'queued with images',
        images: mockImages,
        editorContext: null,
      });
      expect((view as any).imageContextManager.clearImages).toHaveBeenCalled();
    });

    it('should append new message to existing queued message', () => {
      (view as any).isStreaming = true;
      (view as any).inputEl.value = 'first message';
      (view as any).sendMessage();

      (view as any).inputEl.value = 'second message';
      (view as any).sendMessage();

      expect((view as any).queuedMessage.content).toBe('first message\n\nsecond message');
    });

    it('should merge images when appending to queue', () => {
      (view as any).isStreaming = true;

      // First message with image
      (view as any).inputEl.value = 'first';
      (view as any).imageContextManager.hasImages.mockReturnValue(true);
      (view as any).imageContextManager.getAttachedImages.mockReturnValue([{ id: 'img1' }]);
      (view as any).sendMessage();

      // Second message with another image
      (view as any).inputEl.value = 'second';
      (view as any).imageContextManager.hasImages.mockReturnValue(true);
      (view as any).imageContextManager.getAttachedImages.mockReturnValue([{ id: 'img2' }]);
      (view as any).sendMessage();

      expect((view as any).queuedMessage.images).toHaveLength(2);
      expect((view as any).queuedMessage.images[0].id).toBe('img1');
      expect((view as any).queuedMessage.images[1].id).toBe('img2');
    });

    it('should not queue empty message', () => {
      (view as any).isStreaming = true;
      (view as any).inputEl.value = '';
      (view as any).imageContextManager.hasImages.mockReturnValue(false);

      (view as any).sendMessage();

      expect((view as any).queuedMessage).toBeNull();
    });
  });

  describe('Queue indicator UI', () => {
    it('should show queue indicator when message is queued', () => {
      (view as any).queuedMessage = { content: 'test message', images: undefined };

      (view as any).updateQueueIndicator();

      expect((view as any).queueIndicatorEl.style.display).toBe('block');
      expect((view as any).queueIndicatorEl.textContent).toContain('⌙ Queued: test message');
      expect((view as any).queueIndicatorEl.textContent).not.toContain('[images]');
    });

    it('should hide queue indicator when no message is queued', () => {
      (view as any).queuedMessage = null;

      (view as any).updateQueueIndicator();

      expect((view as any).queueIndicatorEl.style.display).toBe('none');
    });

    it('should truncate long message preview in indicator', () => {
      const longMessage = 'a'.repeat(100);
      (view as any).queuedMessage = { content: longMessage, images: undefined };

      (view as any).updateQueueIndicator();

      expect((view as any).queueIndicatorEl.textContent).toContain('...');
      expect((view as any).queueIndicatorEl.textContent.length).toBeLessThan(60);
    });

    it('should include [images] when queue message has images', () => {
      const mockImages = [{ id: 'img1', name: 'test.png' }];
      (view as any).queuedMessage = { content: 'queued content', images: mockImages };

      (view as any).updateQueueIndicator();

      expect((view as any).queueIndicatorEl.textContent).toContain('queued content');
      expect((view as any).queueIndicatorEl.textContent).toContain('[images]');
    });

    it('should show [images] when queue message has only images', () => {
      const mockImages = [{ id: 'img1', name: 'test.png' }];
      (view as any).queuedMessage = { content: '', images: mockImages };

      (view as any).updateQueueIndicator();

      expect((view as any).queueIndicatorEl.textContent).toBe('⌙ Queued: [images]');
    });
  });

  describe('Clearing queued message', () => {
    it('should clear queued message and update indicator', () => {
      (view as any).queuedMessage = { content: 'test', images: undefined };

      (view as any).clearQueuedMessage();

      expect((view as any).queuedMessage).toBeNull();
      expect((view as any).queueIndicatorEl.style.display).toBe('none');
    });
  });

  describe('Processing queued message', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should process queued message by setting input and triggering send', () => {
      (view as any).queuedMessage = { content: 'queued content', images: undefined };
      const sendMessageSpy = jest.spyOn(view as any, 'sendMessage').mockImplementation(() => {});

      (view as any).processQueuedMessage();
      jest.runAllTimers();

      expect((view as any).inputEl.value).toBe('queued content');
      expect((view as any).queuedMessage).toBeNull();
      expect(sendMessageSpy).toHaveBeenCalled();
    });

    it('should restore images when processing queued message', () => {
      const mockImages = [{ id: 'img1', name: 'test.png' }];
      (view as any).queuedMessage = { content: 'with images', images: mockImages };
      jest.spyOn(view as any, 'sendMessage').mockImplementation(() => {});

      (view as any).processQueuedMessage();
      jest.runAllTimers();

      expect((view as any).imageContextManager.setImages).toHaveBeenCalledWith(mockImages);
    });

    it('should do nothing when no message is queued', () => {
      (view as any).queuedMessage = null;
      const sendMessageSpy = jest.spyOn(view as any, 'sendMessage').mockImplementation(() => {});

      (view as any).processQueuedMessage();
      jest.runAllTimers();

      expect(sendMessageSpy).not.toHaveBeenCalled();
    });
  });

  describe('Queue cleared on conversation changes', () => {
    it('should clear queue on new conversation', async () => {
      (view as any).queuedMessage = { content: 'test', images: undefined };
      (view as any).isStreaming = false;
      (view as any).welcomeEl = null;

      await (view as any).createNewConversation();

      expect((view as any).queuedMessage).toBeNull();
    });

    it('should clear queue on conversation switch', async () => {
      (view as any).queuedMessage = { content: 'test', images: undefined };
      (view as any).isStreaming = false;
      (view as any).currentConversationId = 'conv-1';
      mockPlugin.switchConversation.mockResolvedValue({
        id: 'conv-2',
        messages: [],
        sessionId: null,
      });

      await (view as any).onConversationSelect('conv-2');

      expect((view as any).queuedMessage).toBeNull();
    });

    it('should clear queue on cancel (Escape)', () => {
      (view as any).queuedMessage = { content: 'test', images: undefined };
      (view as any).isStreaming = true;
      const mockThinkingEl = createMockElement('div');
      mockThinkingEl.remove = jest.fn();
      (view as any).thinkingEl = mockThinkingEl;

      (view as any).cancelStreaming();

      expect((view as any).queuedMessage).toBeNull();
    });
  });
});
