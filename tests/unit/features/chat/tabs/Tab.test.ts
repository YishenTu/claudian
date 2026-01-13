/**
 * Tests for Tab - Individual tab state and lifecycle management.
 */

import {
  createTab,
  destroyTab,
  activateTab,
  deactivateTab,
  initializeTabService,
  wireTabInputEvents,
  getTabTitle,
  type TabCreateOptions,
} from '@/features/chat/tabs/Tab';
import type { TabData } from '@/features/chat/tabs/types';
import { ChatState } from '@/features/chat/state/ChatState';

// Mock ClaudianService
jest.mock('@/core/agent', () => ({
  ClaudianService: jest.fn().mockImplementation(() => ({
    loadCCPermissions: jest.fn().mockResolvedValue(undefined),
    preWarm: jest.fn().mockResolvedValue(undefined),
    closePersistentQuery: jest.fn(),
  })),
}));

// Mock SlashCommandManager
jest.mock('@/core/commands', () => ({
  SlashCommandManager: jest.fn().mockImplementation(() => ({
    setCommands: jest.fn(),
  })),
}));

// Helper to create mock DOM element
function createMockElement(): any {
  const style: Record<string, string> = {};
  const classList = new Set<string>();
  const children: any[] = [];
  const eventListeners: Map<string, Function[]> = new Map();

  const el: any = {
    style,
    classList: {
      add: (cls: string) => classList.add(cls),
      remove: (cls: string) => classList.delete(cls),
      contains: (cls: string) => classList.has(cls),
    },
    empty: () => { children.length = 0; },
    createDiv: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) child.classList.add(opts.cls);
      children.push(child);
      return child;
    },
    createEl: (tag: string, opts?: { cls?: string; attr?: Record<string, string> }) => {
      const child = createMockElement();
      child.tagName = tag.toUpperCase();
      if (opts?.cls) child.classList.add(opts.cls);
      children.push(child);
      return child;
    },
    querySelector: jest.fn().mockReturnValue(null),
    insertBefore: jest.fn(),
    remove: jest.fn(),
    addEventListener: (event: string, handler: Function) => {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, []);
      }
      eventListeners.get(event)!.push(handler);
    },
    removeEventListener: (event: string, handler: Function) => {
      const handlers = eventListeners.get(event);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index > -1) handlers.splice(index, 1);
      }
    },
    getEventListeners: () => eventListeners,
    value: '',
  };

  return el;
}

// Helper to create mock plugin
function createMockPlugin(overrides: Record<string, any> = {}): any {
  return {
    app: {
      vault: {
        adapter: { basePath: '/test/vault' },
      },
    },
    settings: {
      excludedTags: [],
      model: 'claude-sonnet-4-5',
      thinkingBudget: 'low',
      permissionMode: 'yolo',
      slashCommands: [],
      keyboardNavigation: {
        scrollUpKey: 'k',
        scrollDownKey: 'j',
        focusInputKey: 'i',
      },
      persistentExternalContextPaths: [],
    },
    mcpService: { getMcpServers: jest.fn().mockReturnValue([]) },
    getConversationById: jest.fn().mockReturnValue(null),
    saveSettings: jest.fn().mockResolvedValue(undefined),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue({}),
    ...overrides,
  };
}

// Helper to create mock MCP manager
function createMockMcpManager(): any {
  return {
    getMcpServers: jest.fn().mockReturnValue([]),
  };
}

// Helper to create TabCreateOptions
function createMockOptions(overrides: Partial<TabCreateOptions> = {}): TabCreateOptions {
  return {
    plugin: createMockPlugin(),
    mcpManager: createMockMcpManager(),
    containerEl: createMockElement(),
    ...overrides,
  };
}

describe('Tab - Creation', () => {
  describe('createTab', () => {
    it('should create a new tab with unique ID', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      expect(tab.id).toBeDefined();
      expect(tab.id).toMatch(/^tab-/);
    });

    it('should use provided tab ID when specified', () => {
      const options = createMockOptions({ tabId: 'custom-tab-id' });
      const tab = createTab(options);

      expect(tab.id).toBe('custom-tab-id');
    });

    it('should initialize with null conversationId when no conversation provided', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      expect(tab.conversationId).toBeNull();
    });

    it('should set conversationId when conversation is provided', () => {
      const options = createMockOptions({
        conversation: {
          id: 'conv-123',
          title: 'Test Conversation',
          messages: [],
          sessionId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });
      const tab = createTab(options);

      expect(tab.conversationId).toBe('conv-123');
    });

    it('should create tab with lazy-initialized service (null)', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      expect(tab.service).toBeNull();
      expect(tab.serviceInitialized).toBe(false);
    });

    it('should create ChatState with callbacks', () => {
      const onStreamingChanged = jest.fn();
      const onAttentionChanged = jest.fn();
      const onConversationIdChanged = jest.fn();

      const options = createMockOptions({
        onStreamingChanged,
        onAttentionChanged,
        onConversationIdChanged,
      });
      const tab = createTab(options);

      expect(tab.state).toBeInstanceOf(ChatState);
    });

    it('should create DOM structure with hidden content', () => {
      const containerEl = createMockElement();
      const options = createMockOptions({ containerEl });
      const tab = createTab(options);

      expect(tab.dom.contentEl).toBeDefined();
      expect(tab.dom.contentEl.style.display).toBe('none');
      expect(tab.dom.messagesEl).toBeDefined();
      expect(tab.dom.inputEl).toBeDefined();
    });

    it('should initialize empty eventCleanups array', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      expect(tab.dom.eventCleanups).toEqual([]);
    });

    it('should initialize all controllers as null', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      expect(tab.controllers.selectionController).toBeNull();
      expect(tab.controllers.conversationController).toBeNull();
      expect(tab.controllers.streamController).toBeNull();
      expect(tab.controllers.inputController).toBeNull();
      expect(tab.controllers.navigationController).toBeNull();
    });
  });
});

describe('Tab - Service Initialization', () => {
  describe('initializeTabService', () => {
    it('should not reinitialize if already initialized', async () => {
      const options = createMockOptions();
      const tab = createTab(options);
      tab.serviceInitialized = true;
      tab.service = {} as any;

      await initializeTabService(tab, options.plugin, options.mcpManager);

      // Service should not be replaced
      expect(tab.service).toEqual({});
    });

    it('should create ClaudianService on first initialization', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      await initializeTabService(tab, options.plugin, options.mcpManager);

      expect(tab.service).toBeDefined();
      expect(tab.serviceInitialized).toBe(true);
    });

    it('should handle loadCCPermissions errors gracefully', async () => {
      const { ClaudianService } = require('@/core/agent');
      ClaudianService.mockImplementationOnce(() => ({
        loadCCPermissions: jest.fn().mockRejectedValue(new Error('Permission load failed')),
        preWarm: jest.fn().mockResolvedValue(undefined),
      }));

      const options = createMockOptions();
      const tab = createTab(options);

      // Should not throw
      await expect(initializeTabService(tab, options.plugin, options.mcpManager))
        .resolves.not.toThrow();

      expect(tab.serviceInitialized).toBe(true);
    });

    it('should pre-warm when conversation has sessionId', async () => {
      const mockPreWarm = jest.fn().mockResolvedValue(undefined);
      const { ClaudianService } = require('@/core/agent');
      ClaudianService.mockImplementationOnce(() => ({
        loadCCPermissions: jest.fn().mockResolvedValue(undefined),
        preWarm: mockPreWarm,
      }));

      const plugin = createMockPlugin({
        getConversationById: jest.fn().mockReturnValue({
          id: 'conv-123',
          sessionId: 'session-456',
        }),
      });

      const options = createMockOptions({ plugin });
      const tab = createTab(options);
      tab.conversationId = 'conv-123';

      await initializeTabService(tab, plugin, options.mcpManager);

      expect(mockPreWarm).toHaveBeenCalledWith('session-456');
    });
  });
});

describe('Tab - Activation/Deactivation', () => {
  describe('activateTab', () => {
    it('should show tab content', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      activateTab(tab);

      expect(tab.dom.contentEl.style.display).toBe('flex');
    });
  });

  describe('deactivateTab', () => {
    it('should hide tab content', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // First activate, then deactivate
      activateTab(tab);
      deactivateTab(tab);

      expect(tab.dom.contentEl.style.display).toBe('none');
    });
  });
});

describe('Tab - Event Wiring', () => {
  describe('wireTabInputEvents', () => {
    it('should register event listeners on input element', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Initialize minimal controllers needed
      tab.controllers.inputController = {
        sendMessage: jest.fn(),
        cancelStreaming: jest.fn(),
      } as any;
      tab.controllers.selectionController = {
        showHighlight: jest.fn(),
      } as any;

      wireTabInputEvents(tab);

      // Check that event listeners were added
      const listeners = tab.dom.inputEl.getEventListeners();
      expect(listeners.get('keydown')).toBeDefined();
      expect(listeners.get('input')).toBeDefined();
      expect(listeners.get('focus')).toBeDefined();
    });

    it('should store cleanup functions for memory management', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      // Initialize minimal controllers
      tab.controllers.inputController = { sendMessage: jest.fn() } as any;
      tab.controllers.selectionController = { showHighlight: jest.fn() } as any;

      wireTabInputEvents(tab);

      expect(tab.dom.eventCleanups.length).toBe(3); // keydown, input, focus
    });
  });
});

describe('Tab - Destruction', () => {
  describe('destroyTab', () => {
    it('should be an async function', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      const result = destroyTab(tab);

      expect(result).toBeInstanceOf(Promise);
      await result; // Should resolve without error
    });

    it('should call cleanup functions for event listeners', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      const cleanup1 = jest.fn();
      const cleanup2 = jest.fn();
      tab.dom.eventCleanups = [cleanup1, cleanup2];

      await destroyTab(tab);

      expect(cleanup1).toHaveBeenCalled();
      expect(cleanup2).toHaveBeenCalled();
    });

    it('should clear eventCleanups array after cleanup', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      tab.dom.eventCleanups = [jest.fn(), jest.fn()];

      await destroyTab(tab);

      expect(tab.dom.eventCleanups.length).toBe(0);
    });

    it('should close service persistent query', async () => {
      const mockClosePersistentQuery = jest.fn();
      const options = createMockOptions();
      const tab = createTab(options);

      tab.service = {
        closePersistentQuery: mockClosePersistentQuery,
      } as any;

      await destroyTab(tab);

      expect(mockClosePersistentQuery).toHaveBeenCalledWith('tab closed');
      expect(tab.service).toBeNull();
    });

    it('should remove DOM element', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      await destroyTab(tab);

      expect(tab.dom.contentEl.remove).toHaveBeenCalled();
    });

    it('should cleanup async subagents', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      const orphanAllActive = jest.fn();
      tab.services.asyncSubagentManager = { orphanAllActive } as any;

      await destroyTab(tab);

      expect(orphanAllActive).toHaveBeenCalled();
    });

    it('should cleanup UI components', async () => {
      const options = createMockOptions();
      const tab = createTab(options);

      const destroyFileContext = jest.fn();
      const destroySlashDropdown = jest.fn();
      const destroyInstructionMode = jest.fn();
      const cancelInstructionRefine = jest.fn();
      const cancelTitleGeneration = jest.fn();
      const destroyTodoPanel = jest.fn();

      tab.ui.fileContextManager = { destroy: destroyFileContext } as any;
      tab.ui.slashCommandDropdown = { destroy: destroySlashDropdown } as any;
      tab.ui.instructionModeManager = { destroy: destroyInstructionMode } as any;
      tab.services.instructionRefineService = { cancel: cancelInstructionRefine } as any;
      tab.services.titleGenerationService = { cancel: cancelTitleGeneration } as any;
      tab.ui.todoPanel = { destroy: destroyTodoPanel } as any;

      await destroyTab(tab);

      expect(destroyFileContext).toHaveBeenCalled();
      expect(destroySlashDropdown).toHaveBeenCalled();
      expect(destroyInstructionMode).toHaveBeenCalled();
      expect(cancelInstructionRefine).toHaveBeenCalled();
      expect(cancelTitleGeneration).toHaveBeenCalled();
      expect(destroyTodoPanel).toHaveBeenCalled();
    });
  });
});

describe('Tab - Title', () => {
  describe('getTabTitle', () => {
    it('should return "New Chat" for tab without conversation', () => {
      const options = createMockOptions();
      const tab = createTab(options);

      const title = getTabTitle(tab, options.plugin);

      expect(title).toBe('New Chat');
    });

    it('should return conversation title when available', () => {
      const plugin = createMockPlugin({
        getConversationById: jest.fn().mockReturnValue({
          id: 'conv-123',
          title: 'My Conversation',
        }),
      });

      const options = createMockOptions({ plugin });
      const tab = createTab(options);
      tab.conversationId = 'conv-123';

      const title = getTabTitle(tab, plugin);

      expect(title).toBe('My Conversation');
    });

    it('should return "New Chat" when conversation has no title', () => {
      const plugin = createMockPlugin({
        getConversationById: jest.fn().mockReturnValue({
          id: 'conv-123',
          title: null,
        }),
      });

      const options = createMockOptions({ plugin });
      const tab = createTab(options);
      tab.conversationId = 'conv-123';

      const title = getTabTitle(tab, plugin);

      expect(title).toBe('New Chat');
    });
  });
});
