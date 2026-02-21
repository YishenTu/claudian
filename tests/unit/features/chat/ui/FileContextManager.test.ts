import { createMockEl, type MockElement } from '@test/helpers/mockElement';
import { TFile } from 'obsidian';

import { VaultFolderCache } from '@/features/chat/ui/file-context/state/VaultFolderCache';
import type { FileContextCallbacks } from '@/features/chat/ui/FileContext';
import { FileContextManager } from '@/features/chat/ui/FileContext';
import type { ExternalContextFile } from '@/utils/externalContextScanner';

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');
  return {
    ...actual,
    setIcon: jest.fn(),
    Notice: jest.fn(),
  };
});

function createMockTFile(filePath: string): TFile {
  const file = new (TFile as any)(filePath) as TFile;
  (file as any).stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
  return file;
}

let mockVaultPath = '/vault';
jest.mock('@/utils/path', () => {
  const actual = jest.requireActual('@/utils/path');
  return {
    ...actual,
    getVaultPath: jest.fn(() => mockVaultPath),
    isPathWithinVault: jest.fn((candidatePath: string, vaultPath: string) => {
      if (!candidatePath) return false;
      if (!candidatePath.startsWith('/')) return true;
      return candidatePath.startsWith(vaultPath);
    }),
  };
});

const mockScanPaths = jest.fn<ExternalContextFile[], [string[]]>(() => []);
jest.mock('@/utils/externalContextScanner', () => ({
  externalContextScanner: {
    scanPaths: (paths: string[]) => mockScanPaths(paths),
  },
}));


function findByClass(root: MockElement, className: string): MockElement | undefined {
  if (root.hasClass(className)) return root;
  for (const child of root.children) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return undefined;
}

function findAllByClass(root: MockElement, className: string): MockElement[] {
  const results: MockElement[] = [];
  const walk = (node: MockElement) => {
    if (node.hasClass(className)) {
      results.push(node);
    }
    node.children.forEach(walk);
  };
  walk(root);
  return results;
}

function createMockApp(options: {
  files?: string[];
  activeFilePath?: string | null;
  fileCacheByPath?: Map<string, any>;
} = {}) {
  const { files = [], activeFilePath = null, fileCacheByPath = new Map() } = options;
  const fileMap = new Map<string, TFile>();
  files.forEach((filePath) => {
    fileMap.set(filePath, createMockTFile(filePath));
  });

  return {
    vault: {
      on: jest.fn(() => ({ id: 'event-ref' })),
      offref: jest.fn(),
      getAbstractFileByPath: jest.fn((filePath: string) => fileMap.get(filePath) || null),
      getAllLoadedFiles: jest.fn(() => Array.from(fileMap.values())),
      getMarkdownFiles: jest.fn(() => Array.from(fileMap.values())),
    },
    workspace: {
      getActiveFile: jest.fn(() => {
        if (!activeFilePath) return null;
        return fileMap.get(activeFilePath) || createMockTFile(activeFilePath);
      }),
      getLeaf: jest.fn(() => ({
        openFile: jest.fn().mockResolvedValue(undefined),
      })),
    },
    metadataCache: {
      getFileCache: jest.fn((file: TFile) => fileCacheByPath.get(file.path) || null),
    },
  } as any;
}

function createMockCallbacks(options: {
  externalContexts?: string[];
  excludedTags?: string[];
} = {}): FileContextCallbacks {
  const { externalContexts = [], excludedTags = [] } = options;
  return {
    getExcludedTags: jest.fn(() => excludedTags),
    getExternalContexts: jest.fn(() => externalContexts),
  };
}

describe('FileContextManager', () => {
  let containerEl: MockElement;
  let inputEl: HTMLTextAreaElement;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockVaultPath = '/vault';
    mockScanPaths.mockReturnValue([]);
    containerEl = createMockEl();
    inputEl = {
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      focus: jest.fn(),
    } as unknown as HTMLTextAreaElement;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('tracks current note send state per session', () => {
    const app = createMockApp();
    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      createMockCallbacks()
    );

    manager.setCurrentNote('notes/alpha.md');
    expect(manager.shouldSendCurrentNote()).toBe(true);
    manager.markCurrentNoteSent();
    expect(manager.shouldSendCurrentNote()).toBe(false);

    manager.resetForLoadedConversation(true);
    manager.setCurrentNote('notes/alpha.md');
    expect(manager.shouldSendCurrentNote()).toBe(false);

    manager.resetForLoadedConversation(false);
    manager.setCurrentNote('notes/beta.md');
    expect(manager.shouldSendCurrentNote()).toBe(true);

    manager.destroy();
  });

  it('should NOT resend current note when loading conversation with existing messages', () => {
    const app = createMockApp();
    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      createMockCallbacks()
    );

    // When loading a conversation that already has messages, the current note
    // should be marked as already sent to avoid re-sending context
    manager.resetForLoadedConversation(true);
    manager.setCurrentNote('notes/restored.md');
    expect(manager.shouldSendCurrentNote()).toBe(false);

    manager.destroy();
  });

  it('should send current note when loading empty conversation', () => {
    const app = createMockApp();
    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      createMockCallbacks()
    );

    // When loading a conversation with no messages, the current note
    // should be sent with the first message
    manager.resetForLoadedConversation(false);
    manager.setCurrentNote('notes/new.md');
    expect(manager.shouldSendCurrentNote()).toBe(true);

    manager.destroy();
  });

  it('renders current note chip and removes on click', () => {
    const app = createMockApp();
    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      createMockCallbacks()
    );

    manager.setCurrentNote('notes/chip.md');

    const indicator = findByClass(containerEl, 'claudian-file-indicator');
    expect(indicator).toBeDefined();
    expect(indicator?.style.display).toBe('flex');

    const removeEl = findByClass(containerEl, 'claudian-file-chip-remove');
    expect(removeEl).toBeDefined();

    removeEl!.click();

    expect(manager.getCurrentNotePath()).toBeNull();
    expect(indicator?.style.display).toBe('none');

    manager.destroy();
  });

  it('auto-attaches active file unless excluded by tag', () => {
    const fileCacheByPath = new Map<string, any>([
      ['notes/private.md', { frontmatter: { tags: ['private'] } }],
    ]);
    const app = createMockApp({
      files: ['notes/private.md', 'notes/public.md'],
      activeFilePath: 'notes/private.md',
      fileCacheByPath,
    });

    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      createMockCallbacks({ excludedTags: ['private'] })
    );

    manager.autoAttachActiveFile();
    expect(manager.getCurrentNotePath()).toBeNull();

    app.workspace.getActiveFile = jest.fn(() => createMockTFile('notes/public.md'));
    manager.autoAttachActiveFile();
    expect(manager.getCurrentNotePath()).toBe('notes/public.md');

    manager.destroy();
  });

  it('shows vault-relative path in @ dropdown and inserts full path on selection', () => {
    const app = createMockApp({
      files: ['clipping/file.md'],
    });
    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      createMockCallbacks()
    );

    inputEl.value = '@file';
    inputEl.selectionStart = 5;
    inputEl.selectionEnd = 5;
    manager.handleInputChange();
    jest.advanceTimersByTime(200);

    const pathEl = findByClass(containerEl, 'claudian-mention-path');
    expect(pathEl?.textContent).toBe('clipping/file.md');

    manager.handleMentionKeydown({ key: 'Enter', preventDefault: jest.fn() } as any);

    // Now inserts full vault-relative path (WYSIWYG)
    expect(inputEl.value).toBe('@clipping/file.md ');
    const attached = manager.getAttachedFiles();
    expect(attached.has('clipping/file.md')).toBe(true);

    manager.destroy();
  });

  it('wires getCachedVaultFolders through VaultFolderCache.getFolders', () => {
    const folder = { name: 'src', path: 'src' } as any;
    const getFoldersSpy = jest
      .spyOn(VaultFolderCache.prototype, 'getFolders')
      .mockReturnValue([folder]);
    const app = createMockApp();
    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      createMockCallbacks()
    );

    inputEl.value = '@src';
    inputEl.selectionStart = 4;
    inputEl.selectionEnd = 4;
    manager.handleInputChange();
    jest.advanceTimersByTime(200);

    expect(getFoldersSpy).toHaveBeenCalled();
    const folderLabel = findByClass(containerEl, 'claudian-mention-name-folder');
    expect(folderLabel?.textContent).toBe('@src/');

    manager.destroy();
    getFoldersSpy.mockRestore();
  });

  it('filters context files and attaches absolute path', () => {
    const app = createMockApp();
    const manager = new FileContextManager(
      app,
      containerEl as any,
      inputEl,
      createMockCallbacks({ externalContexts: ['/external'] })
    );

    const contextFiles: ExternalContextFile[] = [
      {
        path: '/external/src/app.md',
        name: 'app.md',
        relativePath: 'src/app.md',
        contextRoot: '/external',
        mtime: 1000,
      },
    ];
    mockScanPaths.mockReturnValue(contextFiles);

    inputEl.value = '@external/app';
    inputEl.selectionStart = 13;
    inputEl.selectionEnd = 13;
    manager.handleInputChange();
    jest.advanceTimersByTime(200);

    const nameEls = findAllByClass(containerEl, 'claudian-mention-name-context');
    expect(nameEls[0]?.textContent).toBe('src/app.md');

    manager.handleMentionKeydown({ key: 'Enter', preventDefault: jest.fn() } as any);

    // Display shows friendly name, but state stores mapping to absolute path
    expect(inputEl.value).toBe('@external/src/app.md ');
    const attached = manager.getAttachedFiles();
    expect(attached.has('/external/src/app.md')).toBe(true);
    // Check transformation works
    const transformed = manager.transformContextMentions('@external/src/app.md');
    expect(transformed).toBe('/external/src/app.md');

    manager.destroy();
  });

  describe('session lifecycle', () => {
    it('should report session not started initially', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );
      expect(manager.isSessionStarted()).toBe(false);
      manager.destroy();
    });

    it('should report session started after startSession', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );
      manager.startSession();
      expect(manager.isSessionStarted()).toBe(true);
      manager.destroy();
    });

    it('should reset state for new conversation', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );
      manager.setCurrentNote('notes/test.md');
      manager.startSession();

      manager.resetForNewConversation();
      expect(manager.getCurrentNotePath()).toBeNull();
      expect(manager.isSessionStarted()).toBe(false);
      manager.destroy();
    });
  });

  describe('handleFileOpen', () => {
    it('should update current note when session not started', () => {
      const app = createMockApp({ files: ['notes/new.md'] });
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );

      const file = createMockTFile('notes/new.md');
      manager.handleFileOpen(file);
      expect(manager.getCurrentNotePath()).toBe('notes/new.md');
      manager.destroy();
    });

    it('should clear attachments when opening a new file before session starts', () => {
      const app = createMockApp({ files: ['notes/a.md', 'notes/b.md'] });
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );

      manager.setCurrentNote('notes/a.md');
      const fileB = createMockTFile('notes/b.md');
      manager.handleFileOpen(fileB);
      expect(manager.getCurrentNotePath()).toBe('notes/b.md');
      manager.destroy();
    });

    it('should update current note focus indicator when session is started', () => {
      const app = createMockApp({ files: ['notes/a.md', 'notes/b.md'] });
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );

      manager.setCurrentNote('notes/a.md');
      manager.startSession();

      const fileB = createMockTFile('notes/b.md');
      manager.handleFileOpen(fileB);
      // Focus indicator should follow active file even during session
      expect(manager.getCurrentNotePath()).toBe('notes/b.md');
      manager.destroy();
    });

    it('should not clear attachments when switching files after session starts', () => {
      const app = createMockApp({ files: ['notes/a.md', 'notes/b.md'] });
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );

      manager.setCurrentNote('notes/a.md');
      manager.startSession();

      const fileB = createMockTFile('notes/b.md');
      manager.handleFileOpen(fileB);
      // Original attachment (a.md) should remain — don't clear during active session
      expect(manager.getAttachedFiles().has('notes/a.md')).toBe(true);
      manager.destroy();
    });

    it('should not attach file with excluded tag', () => {
      const fileCacheByPath = new Map<string, any>([
        ['notes/secret.md', { frontmatter: { tags: ['private'] } }],
      ]);
      const app = createMockApp({ files: ['notes/secret.md'], fileCacheByPath });
      const manager = new FileContextManager(
        app, containerEl as any, inputEl,
        createMockCallbacks({ excludedTags: ['private'] })
      );

      const file = createMockTFile('notes/secret.md');
      manager.handleFileOpen(file);
      expect(manager.getCurrentNotePath()).toBeNull();
      manager.destroy();
    });
  });

  describe('file rename handling', () => {
    it('should update current note path when file is renamed', () => {
      const app = createMockApp({ files: ['notes/old.md', 'notes/new.md'] });
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );

      manager.setCurrentNote('notes/old.md');
      expect(manager.getCurrentNotePath()).toBe('notes/old.md');

      // Simulate vault rename event
      const renameHandler = (app.vault.on as jest.Mock).mock.calls
        .find((c: any[]) => c[0] === 'rename')?.[1];
      expect(renameHandler).toBeDefined();

      renameHandler(createMockTFile('notes/new.md'), 'notes/old.md');
      expect(manager.getCurrentNotePath()).toBe('notes/new.md');
      manager.destroy();
    });

    it('should update attached files when renamed', () => {
      const app = createMockApp({ files: ['notes/old.md'] });
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );

      manager.setCurrentNote('notes/old.md');

      const renameHandler = (app.vault.on as jest.Mock).mock.calls
        .find((c: any[]) => c[0] === 'rename')?.[1];

      renameHandler(createMockTFile('notes/new.md'), 'notes/old.md');
      expect(manager.getAttachedFiles().has('notes/new.md')).toBe(true);
      expect(manager.getAttachedFiles().has('notes/old.md')).toBe(false);
      manager.destroy();
    });

    it('should not update if renamed file is not attached', () => {
      const app = createMockApp({ files: ['notes/a.md', 'notes/unrelated.md'] });
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );

      manager.setCurrentNote('notes/a.md');

      const renameHandler = (app.vault.on as jest.Mock).mock.calls
        .find((c: any[]) => c[0] === 'rename')?.[1];

      renameHandler(createMockTFile('notes/renamed.md'), 'notes/unrelated.md');
      // Current note should remain unchanged
      expect(manager.getCurrentNotePath()).toBe('notes/a.md');
      manager.destroy();
    });
  });

  describe('file delete handling', () => {
    it('should clear current note when file is deleted', () => {
      const app = createMockApp({ files: ['notes/doomed.md'] });
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );

      manager.setCurrentNote('notes/doomed.md');

      const deleteHandler = (app.vault.on as jest.Mock).mock.calls
        .find((c: any[]) => c[0] === 'delete')?.[1];
      expect(deleteHandler).toBeDefined();

      deleteHandler(createMockTFile('notes/doomed.md'));
      expect(manager.getCurrentNotePath()).toBeNull();
      manager.destroy();
    });

    it('should remove deleted file from attached files', () => {
      const app = createMockApp({ files: ['notes/a.md'] });
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );

      manager.setCurrentNote('notes/a.md');
      expect(manager.getAttachedFiles().has('notes/a.md')).toBe(true);

      const deleteHandler = (app.vault.on as jest.Mock).mock.calls
        .find((c: any[]) => c[0] === 'delete')?.[1];

      deleteHandler(createMockTFile('notes/a.md'));
      expect(manager.getAttachedFiles().has('notes/a.md')).toBe(false);
      manager.destroy();
    });

    it('should not update if deleted file is not attached', () => {
      const app = createMockApp({ files: ['notes/a.md', 'notes/other.md'] });
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );

      manager.setCurrentNote('notes/a.md');

      const deleteHandler = (app.vault.on as jest.Mock).mock.calls
        .find((c: any[]) => c[0] === 'delete')?.[1];

      deleteHandler(createMockTFile('notes/other.md'));
      expect(manager.getCurrentNotePath()).toBe('notes/a.md');
      manager.destroy();
    });
  });

  describe('hasExcludedTag edge cases', () => {
    it('should exclude file with inline tags (not just frontmatter)', () => {
      const fileCacheByPath = new Map<string, any>([
        ['notes/tagged.md', {
          tags: [{ tag: '#system', position: { start: { line: 5, col: 0 }, end: { line: 5, col: 7 } } }],
        }],
      ]);
      const app = createMockApp({
        files: ['notes/tagged.md'],
        activeFilePath: 'notes/tagged.md',
        fileCacheByPath,
      });

      const manager = new FileContextManager(
        app, containerEl as any, inputEl,
        createMockCallbacks({ excludedTags: ['system'] })
      );

      manager.autoAttachActiveFile();
      expect(manager.getCurrentNotePath()).toBeNull();
      manager.destroy();
    });

    it('should exclude file with string frontmatter tag (not array)', () => {
      const fileCacheByPath = new Map<string, any>([
        ['notes/single-tag.md', { frontmatter: { tags: 'private' } }],
      ]);
      const app = createMockApp({
        files: ['notes/single-tag.md'],
        activeFilePath: 'notes/single-tag.md',
        fileCacheByPath,
      });

      const manager = new FileContextManager(
        app, containerEl as any, inputEl,
        createMockCallbacks({ excludedTags: ['private'] })
      );

      manager.autoAttachActiveFile();
      expect(manager.getCurrentNotePath()).toBeNull();
      manager.destroy();
    });

    it('should handle tags with # prefix in cache', () => {
      const fileCacheByPath = new Map<string, any>([
        ['notes/hash-tag.md', { frontmatter: { tags: ['#draft'] } }],
      ]);
      const app = createMockApp({
        files: ['notes/hash-tag.md'],
        activeFilePath: 'notes/hash-tag.md',
        fileCacheByPath,
      });

      const manager = new FileContextManager(
        app, containerEl as any, inputEl,
        createMockCallbacks({ excludedTags: ['draft'] })
      );

      manager.autoAttachActiveFile();
      expect(manager.getCurrentNotePath()).toBeNull();
      manager.destroy();
    });
  });

  describe('cache dirty marking', () => {
    it('should not throw when marking file cache dirty', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );
      expect(() => manager.markFileCacheDirty()).not.toThrow();
      manager.destroy();
    });

    it('should not throw when marking folder cache dirty', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );
      expect(() => manager.markFolderCacheDirty()).not.toThrow();
      manager.destroy();
    });
  });

  describe('MCP and agent support', () => {
    it('should expose getMentionedMcpServers', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );
      const servers = manager.getMentionedMcpServers();
      expect(servers).toBeInstanceOf(Set);
      expect(servers.size).toBe(0);
      manager.destroy();
    });

    it('should clear MCP mentions', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );
      // Should not throw
      manager.clearMcpMentions();
      expect(manager.getMentionedMcpServers().size).toBe(0);
      manager.destroy();
    });

    it('should set onMcpMentionChange callback without error', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );
      const callback = jest.fn();
      expect(() => manager.setOnMcpMentionChange(callback)).not.toThrow();
      manager.destroy();
    });

    it('should setMcpManager without error', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );
      expect(() => manager.setMcpManager(null)).not.toThrow();
      manager.destroy();
    });

    it('should setAgentService without error', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );
      expect(() => manager.setAgentService(null)).not.toThrow();
      manager.destroy();
    });

    it('should preScanExternalContexts without error', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );
      expect(() => manager.preScanExternalContexts()).not.toThrow();
      manager.destroy();
    });
  });

  describe('mention dropdown delegation', () => {
    it('should report isMentionDropdownVisible as false initially', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );
      expect(manager.isMentionDropdownVisible()).toBe(false);
      manager.destroy();
    });

    it('should hideMentionDropdown without error', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );
      expect(() => manager.hideMentionDropdown()).not.toThrow();
      manager.destroy();
    });

    it('should containsElement return false for unrelated node', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );
      const unrelatedNode = createMockEl() as unknown as Node;
      expect(manager.containsElement(unrelatedNode)).toBe(false);
      manager.destroy();
    });
  });

  describe('destroy', () => {
    it('should clean up event listeners', () => {
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );

      manager.destroy();
      expect(app.vault.offref).toHaveBeenCalledTimes(2);
    });
  });

  describe('onOpenFile callback', () => {
    it('should show Notice when file not found in vault', async () => {
      const { Notice: NoticeMock } = jest.requireMock('obsidian');
      const app = createMockApp();
      const manager = new FileContextManager(
        app, containerEl as any, inputEl, createMockCallbacks()
      );

      const chipsView = (manager as any).chipsView;
      const openCallback = chipsView.callbacks.onOpenFile;
      expect(openCallback).toBeDefined();

      await openCallback('notes/missing.md');
      expect(NoticeMock).toHaveBeenCalledWith(expect.stringContaining('Could not open file'));
      manager.destroy();
    });
  });
});
