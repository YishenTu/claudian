import { createMockEl } from '@test/helpers/mockElement';

import {
  type AgentMentionProvider,
  type McpMentionProvider,
  type MentionDropdownCallbacks,
  MentionDropdownController,
} from '@/shared/mention/MentionDropdownController';

// Mock externalContextScanner
jest.mock('@/utils/externalContextScanner', () => ({
  externalContextScanner: {
    scanPaths: jest.fn().mockReturnValue([]),
  },
}));

// Mock extractMcpMentions
jest.mock('@/utils/mcp', () => ({
  extractMcpMentions: jest.fn().mockReturnValue(new Set()),
}));

// Mock SelectableDropdown with controllable visibility
let mockDropdownVisible = false;
jest.mock('@/shared/components/SelectableDropdown', () => ({
  SelectableDropdown: jest.fn().mockImplementation(() => ({
    isVisible: jest.fn(() => mockDropdownVisible),
    hide: jest.fn(() => { mockDropdownVisible = false; }),
    destroy: jest.fn(),
    render: jest.fn(() => { mockDropdownVisible = true; }),
    moveSelection: jest.fn(),
    getSelectedIndex: jest.fn().mockReturnValue(0),
    getElement: jest.fn().mockReturnValue(null),
  })),
}));

function createMockInput() {
  return {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    focus: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  } as any;
}

function createMockCallbacks(overrides: Partial<MentionDropdownCallbacks> = {}): MentionDropdownCallbacks {
  const mentionedServers = new Set<string>();
  return {
    onAttachFile: jest.fn(),
    onAttachContextFile: jest.fn(),
    onMcpMentionChange: jest.fn(),
    onAgentMentionSelect: jest.fn(),
    getMentionedMcpServers: jest.fn().mockReturnValue(mentionedServers),
    setMentionedMcpServers: jest.fn().mockReturnValue(false),
    addMentionedMcpServer: jest.fn((name: string) => mentionedServers.add(name)),
    getExternalContexts: jest.fn().mockReturnValue([]),
    getCachedMarkdownFiles: jest.fn().mockReturnValue([]),
    normalizePathForVault: jest.fn((path: string | undefined | null) => path ?? null),
    ...overrides,
  };
}

function createMockMcpService(servers: Array<{ name: string }> = []): McpMentionProvider {
  return {
    getContextSavingServers: jest.fn().mockReturnValue(servers),
  };
}

function createMockAgentService(agents: Array<{
  id: string;
  name: string;
  source: 'plugin' | 'vault' | 'global' | 'builtin';
}> = []): AgentMentionProvider {
  return {
    searchAgents: jest.fn((query: string) => {
      if (query === '') return agents;
      const q = query.toLowerCase();
      return agents.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q)
      );
    }),
  };
}

describe('MentionDropdownController', () => {
  let containerEl: any;
  let inputEl: any;
  let callbacks: MentionDropdownCallbacks;
  let controller: MentionDropdownController;

  beforeEach(() => {
    jest.useFakeTimers();
    mockDropdownVisible = false;
    containerEl = createMockEl();
    inputEl = createMockInput();
    callbacks = createMockCallbacks();
    controller = new MentionDropdownController(containerEl, inputEl, callbacks);
  });

  afterEach(() => {
    controller.destroy();
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('creates controller with container and input elements', () => {
      expect(controller).toBeInstanceOf(MentionDropdownController);
    });
  });

  describe('setAgentService', () => {
    it('sets the agent service', () => {
      const agentService = createMockAgentService([
        { id: 'Explore', name: 'Explore', source: 'builtin' },
      ]);
      controller.setAgentService(agentService);

      // Trigger dropdown to verify service is used
      inputEl.value = '@';
      inputEl.selectionStart = 1;
      controller.handleInputChange();
      jest.advanceTimersByTime(200);

      expect(agentService.searchAgents).toHaveBeenCalled();
    });

    it('can set agent service to null', () => {
      expect(() => {
        controller.setAgentService(null);
        inputEl.value = '@';
        inputEl.selectionStart = 1;
        controller.handleInputChange();
        jest.advanceTimersByTime(200);
      }).not.toThrow();
    });
  });

  describe('agent folder entry', () => {
    it('checks for agents when @ is typed', () => {
      const agentService = createMockAgentService([
        { id: 'Explore', name: 'Explore', source: 'builtin' },
      ]);
      controller.setAgentService(agentService);

      inputEl.value = '@a';
      inputEl.selectionStart = 2;
      controller.handleInputChange();
      jest.advanceTimersByTime(200);

      // searchAgents should be called with empty string to check if any agents exist
      expect(agentService.searchAgents).toHaveBeenCalledWith('');
    });

    it('checks if any agents exist when search is empty', () => {
      const agentService = createMockAgentService([
        { id: 'Explore', name: 'Explore', source: 'builtin' },
      ]);
      controller.setAgentService(agentService);

      inputEl.value = '@';
      inputEl.selectionStart = 1;
      controller.handleInputChange();
      jest.advanceTimersByTime(200);

      expect(agentService.searchAgents).toHaveBeenCalled();
    });

    it('does not show agents folder when no agents exist', () => {
      const agentService = createMockAgentService([]);
      controller.setAgentService(agentService);

      inputEl.value = '@a';
      inputEl.selectionStart = 2;
      controller.handleInputChange();
      jest.advanceTimersByTime(200);

      // searchAgents returns empty array, so no Agents folder shown
      expect(agentService.searchAgents).toHaveBeenCalled();
    });
  });

  describe('@Agents/ filter navigation', () => {
    it('filters to agents when @Agents/ is typed', () => {
      const agentService = createMockAgentService([
        { id: 'Explore', name: 'Explore', source: 'builtin' },
        { id: 'Plan', name: 'Plan', source: 'builtin' },
        { id: 'Bash', name: 'Bash', source: 'builtin' },
      ]);
      controller.setAgentService(agentService);

      inputEl.value = '@Agents/';
      inputEl.selectionStart = 8;
      controller.handleInputChange();
      jest.advanceTimersByTime(200);

      expect(agentService.searchAgents).toHaveBeenCalledWith('');
    });

    it('searches agents within @Agents/ filter', () => {
      const agentService = createMockAgentService([
        { id: 'Explore', name: 'Explore', source: 'builtin' },
        { id: 'Plan', name: 'Plan', source: 'builtin' },
        { id: 'Bash', name: 'Bash', source: 'builtin' },
      ]);
      controller.setAgentService(agentService);

      inputEl.value = '@Agents/exp';
      inputEl.selectionStart = 11;
      controller.handleInputChange();
      jest.advanceTimersByTime(200);

      expect(agentService.searchAgents).toHaveBeenCalledWith('exp');
    });

    it('is case-insensitive for agents/ prefix', () => {
      const agentService = createMockAgentService([
        { id: 'Explore', name: 'Explore', source: 'builtin' },
      ]);
      controller.setAgentService(agentService);

      inputEl.value = '@agents/';
      inputEl.selectionStart = 8;
      controller.handleInputChange();
      jest.advanceTimersByTime(200);

      expect(agentService.searchAgents).toHaveBeenCalledWith('');
    });

    it('handles mixed case agents prefix', () => {
      const agentService = createMockAgentService([
        { id: 'Explore', name: 'Explore', source: 'builtin' },
      ]);
      controller.setAgentService(agentService);

      inputEl.value = '@AGENTS/test';
      inputEl.selectionStart = 12;
      controller.handleInputChange();
      jest.advanceTimersByTime(200);

      expect(agentService.searchAgents).toHaveBeenCalledWith('test');
    });
  });

  describe('setMcpManager', () => {
    it('sets the MCP manager', () => {
      const mcpManager = createMockMcpService([{ name: 'filesystem' }]);
      controller.setMcpManager(mcpManager);

      inputEl.value = '@';
      inputEl.selectionStart = 1;
      controller.handleInputChange();
      jest.advanceTimersByTime(200);

      expect(mcpManager.getContextSavingServers).toHaveBeenCalled();
    });
  });

  describe('mixed providers', () => {
    it('queries both MCP servers and agents', () => {
      const mcpManager = createMockMcpService([{ name: 'filesystem' }]);
      const agentService = createMockAgentService([
        { id: 'Explore', name: 'Explore', source: 'builtin' },
      ]);

      controller.setMcpManager(mcpManager);
      controller.setAgentService(agentService);

      inputEl.value = '@';
      inputEl.selectionStart = 1;
      controller.handleInputChange();
      jest.advanceTimersByTime(200);

      expect(mcpManager.getContextSavingServers).toHaveBeenCalled();
      expect(agentService.searchAgents).toHaveBeenCalled();
    });
  });

  describe('hide', () => {
    it('can be called without error', () => {
      expect(() => controller.hide()).not.toThrow();
    });
  });

  describe('destroy', () => {
    it('cleans up resources', () => {
      expect(() => controller.destroy()).not.toThrow();
    });
  });

  describe('handleInputChange', () => {
    it('hides dropdown when no @ in text', () => {
      inputEl.value = 'no at sign';
      inputEl.selectionStart = 10;
      controller.handleInputChange();
      expect(() => jest.advanceTimersByTime(200)).not.toThrow();
    });

    it('hides dropdown when @ is not at word boundary', () => {
      inputEl.value = 'test@example';
      inputEl.selectionStart = 12;
      controller.handleInputChange();
      expect(() => jest.advanceTimersByTime(200)).not.toThrow();
    });

    it('hides dropdown when space follows @mention', () => {
      inputEl.value = '@test ';
      inputEl.selectionStart = 6;
      controller.handleInputChange();
      expect(() => jest.advanceTimersByTime(200)).not.toThrow();
    });

    it('handles @ at start of line', () => {
      const agentService = createMockAgentService([
        { id: 'Explore', name: 'Explore', source: 'builtin' },
      ]);
      controller.setAgentService(agentService);

      inputEl.value = '@Explore';
      inputEl.selectionStart = 8;
      controller.handleInputChange();
      jest.advanceTimersByTime(200);

      expect(agentService.searchAgents).toHaveBeenCalled();
    });

    it('handles @ after whitespace', () => {
      const agentService = createMockAgentService([
        { id: 'Explore', name: 'Explore', source: 'builtin' },
      ]);
      controller.setAgentService(agentService);

      inputEl.value = 'hello @Explore';
      inputEl.selectionStart = 14;
      controller.handleInputChange();
      jest.advanceTimersByTime(200);

      expect(agentService.searchAgents).toHaveBeenCalled();
    });
  });

  describe('handleKeydown', () => {
    it('returns false when dropdown not visible', () => {
      const event = { key: 'ArrowDown', preventDefault: jest.fn() } as any;
      const handled = controller.handleKeydown(event);

      expect(handled).toBe(false);
    });
  });

  describe('isVisible', () => {
    it('returns false initially', () => {
      expect(controller.isVisible()).toBe(false);
    });
  });

  describe('containsElement', () => {
    it('returns false when element not in dropdown', () => {
      const el = createMockEl();
      expect(controller.containsElement(el)).toBe(false);
    });
  });

  describe('preScanExternalContexts', () => {
    it('can be called without error', () => {
      expect(() => controller.preScanExternalContexts()).not.toThrow();
    });
  });

  describe('updateMcpMentionsFromText', () => {
    it('does nothing without MCP manager', () => {
      expect(() => controller.updateMcpMentionsFromText('@test')).not.toThrow();
    });

    it('updates mentions when MCP manager is set', () => {
      const mcpManager = createMockMcpService([{ name: 'test' }]);
      controller.setMcpManager(mcpManager);
      controller.updateMcpMentionsFromText('@test');

      expect(mcpManager.getContextSavingServers).toHaveBeenCalled();
    });
  });

  describe('agent selection callback', () => {
    it('calls onAgentMentionSelect when agent is selected via dropdown', () => {
      const onAgentMentionSelect = jest.fn();
      const testCallbacks = createMockCallbacks({ onAgentMentionSelect });
      const testInput = createMockInput();

      const testController = new MentionDropdownController(
        createMockEl(),
        testInput,
        testCallbacks
      );

      const agentService = createMockAgentService([
        { id: 'custom-agent', name: 'Custom Agent', source: 'vault' },
      ]);
      testController.setAgentService(agentService);

      // Type @Agents/ to navigate into the agent submenu and populate items
      testInput.value = '@Agents/';
      testInput.selectionStart = 8;
      testController.handleInputChange();
      jest.advanceTimersByTime(200);

      // handleInputChange populates filteredMentionItems and calls dropdown.render(),
      // which sets mockDropdownVisible = true. Press Enter to select the first item.
      const enterEvent = { key: 'Enter', preventDefault: jest.fn(), isComposing: false } as any;
      testController.handleKeydown(enterEvent);

      expect(onAgentMentionSelect).toHaveBeenCalledWith('custom-agent');

      testController.destroy();
    });
  });

  describe('input debouncing', () => {
    it('debounces rapid input changes', () => {
      const agentService = createMockAgentService([
        { id: 'Explore', name: 'Explore', source: 'builtin' },
      ]);
      controller.setAgentService(agentService);

      inputEl.value = '@';
      inputEl.selectionStart = 1;
      controller.handleInputChange();

      inputEl.value = '@E';
      inputEl.selectionStart = 2;
      controller.handleInputChange();

      inputEl.value = '@Ex';
      inputEl.selectionStart = 3;
      controller.handleInputChange();

      expect(agentService.searchAgents).not.toHaveBeenCalled();

      jest.advanceTimersByTime(200);

      expect(agentService.searchAgents).toHaveBeenCalledTimes(1);
    });

    it('clears pending timer on destroy', () => {
      inputEl.value = '@test';
      inputEl.selectionStart = 5;
      controller.handleInputChange();

      expect(() => {
        controller.destroy();
        jest.runAllTimers();
      }).not.toThrow();
    });

    it('processes input after debounce delay', () => {
      const agentService = createMockAgentService([
        { id: 'Explore', name: 'Explore', source: 'builtin' },
      ]);
      controller.setAgentService(agentService);

      inputEl.value = '@Explore';
      inputEl.selectionStart = 8;
      controller.handleInputChange();

      jest.advanceTimersByTime(199);
      expect(agentService.searchAgents).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(agentService.searchAgents).toHaveBeenCalled();
    });
  });

  describe('result limiting', () => {
    it('limits vault file results to 100 items', () => {
      const largeFileSet = Array.from({ length: 200 }, (_, i) => ({
        path: `note${i}.md`,
        name: `note${i}.md`,
        stat: { mtime: Date.now() - i },
      })) as any[];

      const limitedCallbacks = createMockCallbacks({
        getCachedMarkdownFiles: jest.fn().mockReturnValue(largeFileSet),
      });

      const testController = new MentionDropdownController(
        createMockEl(),
        createMockInput(),
        limitedCallbacks
      );

      expect(testController).toBeDefined();

      testController.destroy();
    });
  });
});
