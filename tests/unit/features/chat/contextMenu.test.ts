import { createMockEl } from '@test/helpers/mockElement';
import { Notice, TFile } from 'obsidian';

import { VIEW_TYPE_CLAUDIAN } from '@/core/types';
import {
  addFileToChat,
  addSelectionToChat,
  registerContextMenus,
  registerEditorMenu,
  registerFileMenu,
} from '@/features/chat/contextMenu';

function createMockTFile(path: string): TFile {
  return new (TFile as any)(path) as TFile;
}

// Clear Notice mock between tests
beforeEach(() => {
  (Notice as jest.Mock).mockClear();
});

function createMockFileContextManager(options: { addFileReturns?: boolean } = {}) {
  return {
    addFile: jest.fn().mockReturnValue(options.addFileReturns ?? true),
  };
}

function createMockInputEl() {
  const el = createMockEl('textarea');
  el.value = '';
  return el;
}

function createMockTabManager(options: {
  hasActiveTab?: boolean;
  hasFileContextManager?: boolean;
  inputValue?: string;
} = {}) {
  const inputEl = createMockInputEl();
  if (options.inputValue) {
    inputEl.value = options.inputValue;
  }

  const fileContextManager = options.hasFileContextManager !== false
    ? createMockFileContextManager()
    : null;

  const activeTab = options.hasActiveTab !== false ? {
    ui: { fileContextManager },
    dom: { inputEl },
  } : null;

  return {
    getActiveTab: jest.fn().mockReturnValue(activeTab),
    _activeTab: activeTab,
  };
}

function createMockClaudianView(options: {
  hasTabManager?: boolean;
  tabManagerOptions?: Parameters<typeof createMockTabManager>[0];
} = {}) {
  const tabManager = options.hasTabManager !== false
    ? createMockTabManager(options.tabManagerOptions)
    : null;

  return {
    getTabManager: jest.fn().mockReturnValue(tabManager),
    _tabManager: tabManager,
  };
}

function createMockApp(options: {
  hasClaudianView?: boolean;
  claudianViewOptions?: Parameters<typeof createMockClaudianView>[0];
} = {}) {
  const claudianView = options.hasClaudianView !== false
    ? createMockClaudianView(options.claudianViewOptions)
    : null;

  const leaves = claudianView ? [{
    view: claudianView,
  }] : [];

  return {
    workspace: {
      getLeavesOfType: jest.fn().mockImplementation((type: string) => {
        if (type === VIEW_TYPE_CLAUDIAN) {
          return leaves;
        }
        return [];
      }),
      on: jest.fn().mockReturnValue({ id: 'event-ref' }),
    },
  };
}

function createMockEditor(selection: string = '') {
  return {
    getSelection: jest.fn().mockReturnValue(selection),
  };
}

function createMockPlugin(app: any) {
  return {
    app,
    registerEvent: jest.fn(),
  };
}

describe('contextMenu', () => {
  describe('addFileToChat', () => {
    it('should add file to chat context', () => {
      const app = createMockApp();
      const file = createMockTFile('notes/test.md');

      const result = addFileToChat(app as any, file);

      expect(result).toBe(true);
      expect(Notice).toHaveBeenCalledWith(expect.stringContaining('Added'));
    });

    it('should show notice when file already in context', () => {
      const app = createMockApp({
        claudianViewOptions: {
          tabManagerOptions: {},
        },
      });
      const tabManager = app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0].view._tabManager;
      tabManager._activeTab.ui.fileContextManager.addFile.mockReturnValue(false);

      const file = createMockTFile('notes/test.md');
      const result = addFileToChat(app as any, file);

      expect(result).toBe(false);
      expect(Notice).toHaveBeenCalledWith(expect.stringContaining('already in'));
    });

    it('should show notice when Claudian not open', () => {
      const app = createMockApp({ hasClaudianView: false });
      const file = createMockTFile('notes/test.md');

      const result = addFileToChat(app as any, file);

      expect(result).toBe(false);
      expect(Notice).toHaveBeenCalledWith('Please open Claudian chat first');
    });

    it('should show notice when tab manager not ready', () => {
      const app = createMockApp({
        claudianViewOptions: { hasTabManager: false },
      });
      const file = createMockTFile('notes/test.md');

      const result = addFileToChat(app as any, file);

      expect(result).toBe(false);
      expect(Notice).toHaveBeenCalledWith('Chat not ready');
    });

    it('should show notice when no active tab', () => {
      const app = createMockApp({
        claudianViewOptions: {
          tabManagerOptions: { hasActiveTab: false },
        },
      });
      const file = createMockTFile('notes/test.md');

      const result = addFileToChat(app as any, file);

      expect(result).toBe(false);
      expect(Notice).toHaveBeenCalledWith('No active chat tab');
    });

    it('should show notice when file context not available', () => {
      const app = createMockApp({
        claudianViewOptions: {
          tabManagerOptions: { hasFileContextManager: false },
        },
      });
      const file = createMockTFile('notes/test.md');

      const result = addFileToChat(app as any, file);

      expect(result).toBe(false);
      expect(Notice).toHaveBeenCalledWith('File context not available');
    });
  });

  describe('addSelectionToChat', () => {
    it('should add selected text to chat input', () => {
      const app = createMockApp();
      const editor = createMockEditor('Selected text here');
      const file = createMockTFile('notes/test.md');

      const result = addSelectionToChat(app as any, editor as any, file);

      expect(result).toBe(true);
      const tabManager = app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0].view._tabManager;
      expect(tabManager._activeTab.dom.inputEl.value).toContain('Selected text here');
      expect(Notice).toHaveBeenCalledWith('Selection added to chat input');
    });

    it('should wrap selection in XML tags with filename', () => {
      const app = createMockApp();
      const editor = createMockEditor('Selected text');
      const file = createMockTFile('notes/myfile.md');

      addSelectionToChat(app as any, editor as any, file);

      const tabManager = app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0].view._tabManager;
      const inputValue = tabManager._activeTab.dom.inputEl.value;
      expect(inputValue).toContain('<selection from="myfile">');
      expect(inputValue).toContain('</selection>');
    });

    it('should use "selection" as fallback when no file', () => {
      const app = createMockApp();
      const editor = createMockEditor('Selected text');

      addSelectionToChat(app as any, editor as any, null);

      const tabManager = app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0].view._tabManager;
      const inputValue = tabManager._activeTab.dom.inputEl.value;
      expect(inputValue).toContain('<selection from="selection">');
    });

    it('should append to existing input content', () => {
      const app = createMockApp({
        claudianViewOptions: {
          tabManagerOptions: { inputValue: 'Existing content' },
        },
      });
      const editor = createMockEditor('New selection');
      const file = createMockTFile('test.md');

      addSelectionToChat(app as any, editor as any, file);

      const tabManager = app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0].view._tabManager;
      const inputValue = tabManager._activeTab.dom.inputEl.value;
      expect(inputValue).toContain('Existing content');
      expect(inputValue).toContain('New selection');
    });

    it('should show notice when no text selected', () => {
      const app = createMockApp();
      const editor = createMockEditor('');

      const result = addSelectionToChat(app as any, editor as any, null);

      expect(result).toBe(false);
      expect(Notice).toHaveBeenCalledWith('No text selected');
    });

    it('should show notice when only whitespace selected', () => {
      const app = createMockApp();
      const editor = createMockEditor('   \n\t  ');

      const result = addSelectionToChat(app as any, editor as any, null);

      expect(result).toBe(false);
      expect(Notice).toHaveBeenCalledWith('No text selected');
    });

    it('should show notice when Claudian not open', () => {
      const app = createMockApp({ hasClaudianView: false });
      const editor = createMockEditor('Selected text');

      const result = addSelectionToChat(app as any, editor as any, null);

      expect(result).toBe(false);
      expect(Notice).toHaveBeenCalledWith('Please open Claudian chat first');
    });
  });

  describe('registerFileMenu', () => {
    it('should register file-menu event', () => {
      const app = createMockApp();
      const plugin = createMockPlugin(app);

      registerFileMenu(plugin as any);

      expect(plugin.registerEvent).toHaveBeenCalled();
      expect(app.workspace.on).toHaveBeenCalledWith('file-menu', expect.any(Function));
    });

    it('should add menu item for TFile', () => {
      const app = createMockApp();
      const plugin = createMockPlugin(app);

      registerFileMenu(plugin as any);

      // Get the callback registered with workspace.on
      const onCall = app.workspace.on.mock.calls.find((c: any[]) => c[0] === 'file-menu');
      const callback = onCall[1];

      const menuItem = {
        setTitle: jest.fn().mockReturnThis(),
        setIcon: jest.fn().mockReturnThis(),
        onClick: jest.fn().mockReturnThis(),
      };
      const menu = {
        addItem: jest.fn().mockImplementation((cb) => cb(menuItem)),
      };
      const file = createMockTFile('test.md');

      callback(menu, file);

      expect(menu.addItem).toHaveBeenCalled();
      expect(menuItem.setTitle).toHaveBeenCalledWith('Add to Claudian chat');
      expect(menuItem.setIcon).toHaveBeenCalledWith('message-square-plus');
    });

    it('should not add menu item for non-TFile', () => {
      const app = createMockApp();
      const plugin = createMockPlugin(app);

      registerFileMenu(plugin as any);

      const onCall = app.workspace.on.mock.calls.find((c: any[]) => c[0] === 'file-menu');
      const callback = onCall[1];

      const menu = {
        addItem: jest.fn(),
      };
      const folder = { path: 'folder', name: 'folder' }; // Not a TFile

      callback(menu, folder);

      expect(menu.addItem).not.toHaveBeenCalled();
    });
  });

  describe('registerEditorMenu', () => {
    it('should register editor-menu event', () => {
      const app = createMockApp();
      const plugin = createMockPlugin(app);

      registerEditorMenu(plugin as any);

      expect(plugin.registerEvent).toHaveBeenCalled();
      expect(app.workspace.on).toHaveBeenCalledWith('editor-menu', expect.any(Function));
    });

    it('should add selection menu item', () => {
      const app = createMockApp();
      const plugin = createMockPlugin(app);

      registerEditorMenu(plugin as any);

      const onCall = app.workspace.on.mock.calls.find((c: any[]) => c[0] === 'editor-menu');
      const callback = onCall[1];

      const menuItems: any[] = [];
      const menu = {
        addItem: jest.fn().mockImplementation((cb) => {
          const item = {
            setTitle: jest.fn().mockReturnThis(),
            setIcon: jest.fn().mockReturnThis(),
            onClick: jest.fn().mockReturnThis(),
          };
          cb(item);
          menuItems.push(item);
        }),
      };
      const editor = createMockEditor('text');
      const info = { file: null };

      callback(menu, editor, info);

      expect(menuItems.length).toBeGreaterThan(0);
      expect(menuItems[0].setTitle).toHaveBeenCalledWith('Add selection to Claudian');
    });

    it('should add file menu item when file is present', () => {
      const app = createMockApp();
      const plugin = createMockPlugin(app);

      registerEditorMenu(plugin as any);

      const onCall = app.workspace.on.mock.calls.find((c: any[]) => c[0] === 'editor-menu');
      const callback = onCall[1];

      const menuItems: any[] = [];
      const menu = {
        addItem: jest.fn().mockImplementation((cb) => {
          const item = {
            setTitle: jest.fn().mockReturnThis(),
            setIcon: jest.fn().mockReturnThis(),
            onClick: jest.fn().mockReturnThis(),
          };
          cb(item);
          menuItems.push(item);
        }),
      };
      const editor = createMockEditor('text');
      const file = createMockTFile('test.md');
      const info = { file };

      callback(menu, editor, info);

      // Should have both selection and file menu items
      expect(menuItems.length).toBe(2);
      expect(menuItems[1].setTitle).toHaveBeenCalledWith('Add file to Claudian chat');
    });
  });

  describe('registerContextMenus', () => {
    it('should register both file and editor menus', () => {
      const app = createMockApp();
      const plugin = createMockPlugin(app);

      registerContextMenus(plugin as any);

      expect(plugin.registerEvent).toHaveBeenCalledTimes(2);
      expect(app.workspace.on).toHaveBeenCalledWith('file-menu', expect.any(Function));
      expect(app.workspace.on).toHaveBeenCalledWith('editor-menu', expect.any(Function));
    });
  });
});
