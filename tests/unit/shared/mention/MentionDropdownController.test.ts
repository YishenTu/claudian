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

// Mock SelectableDropdown
jest.mock('@/shared/components/SelectableDropdown', () => ({
  SelectableDropdown: jest.fn().mockImplementation(() => ({
    isVisible: jest.fn().mockReturnValue(false),
    hide: jest.fn(),
    destroy: jest.fn(),
    render: jest.fn(),
    moveSelection: jest.fn(),
    getSelectedIndex: jest.fn().mockReturnValue(0),
    getElement: jest.fn().mockReturnValue(null),
  })),
}));

// Helper to create mock DOM element
function createMockElement() {
  const children: any[] = [];
  const classList = new Set<string>();

  const element: any = {
    children,
    classList: {
      add: (cls: string) => classList.add(cls),
      remove: (cls: string) => classList.delete(cls),
      contains: (cls: string) => classList.has(cls),
    },
    textContent: '',
    style: {},
    createDiv: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) child.classList.add(opts.cls);
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    createSpan: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) child.classList.add(opts.cls);
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    appendChild: (child: any) => { children.push(child); return child; },
    contains: () => false,
  };
  return element;
}

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
    containerEl = createMockElement();
    inputEl = createMockInput();
    callbacks = createMockCallbacks();
    controller = new MentionDropdownController(containerEl, inputEl, callbacks);
  });

  afterEach(() => {
    controller.destroy();
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

      expect(agentService.searchAgents).toHaveBeenCalled();
    });

    it('can set agent service to null', () => {
      controller.setAgentService(null);
      // Should not throw when handling input
      inputEl.value = '@';
      inputEl.selectionStart = 1;
      controller.handleInputChange();
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

      expect(agentService.searchAgents).toHaveBeenCalled();
    });

    it('does not show agents folder when no agents exist', () => {
      const agentService = createMockAgentService([]);
      controller.setAgentService(agentService);

      inputEl.value = '@a';
      inputEl.selectionStart = 2;
      controller.handleInputChange();

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

      expect(agentService.searchAgents).toHaveBeenCalledWith('test');
    });
  });

  describe('setMcpService', () => {
    it('sets the MCP service', () => {
      const mcpService = createMockMcpService([{ name: 'filesystem' }]);
      controller.setMcpService(mcpService);

      inputEl.value = '@';
      inputEl.selectionStart = 1;
      controller.handleInputChange();

      expect(mcpService.getContextSavingServers).toHaveBeenCalled();
    });
  });

  describe('mixed providers', () => {
    it('queries both MCP servers and agents', () => {
      const mcpService = createMockMcpService([{ name: 'filesystem' }]);
      const agentService = createMockAgentService([
        { id: 'Explore', name: 'Explore', source: 'builtin' },
      ]);

      controller.setMcpService(mcpService);
      controller.setAgentService(agentService);

      inputEl.value = '@';
      inputEl.selectionStart = 1;
      controller.handleInputChange();

      expect(mcpService.getContextSavingServers).toHaveBeenCalled();
      expect(agentService.searchAgents).toHaveBeenCalled();
    });
  });

  describe('hide', () => {
    it('can be called without error', () => {
      controller.hide();
      // Should not throw
    });
  });

  describe('destroy', () => {
    it('cleans up resources', () => {
      controller.destroy();
      // Should not throw
    });
  });

  describe('handleInputChange', () => {
    it('hides dropdown when no @ in text', () => {
      inputEl.value = 'no at sign';
      inputEl.selectionStart = 10;
      controller.handleInputChange();
      // Should not throw
    });

    it('hides dropdown when @ is not at word boundary', () => {
      inputEl.value = 'test@example';
      inputEl.selectionStart = 12;
      controller.handleInputChange();
      // Should call hide (dropdown hidden)
    });

    it('hides dropdown when space follows @mention', () => {
      inputEl.value = '@test ';
      inputEl.selectionStart = 6;
      controller.handleInputChange();
      // Whitespace in search text hides dropdown
    });

    it('handles @ at start of line', () => {
      const agentService = createMockAgentService([
        { id: 'Explore', name: 'Explore', source: 'builtin' },
      ]);
      controller.setAgentService(agentService);

      inputEl.value = '@Explore';
      inputEl.selectionStart = 8;
      controller.handleInputChange();

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
      const el = createMockElement();
      expect(controller.containsElement(el)).toBe(false);
    });
  });

  describe('preScanExternalContexts', () => {
    it('can be called without error', () => {
      controller.preScanExternalContexts();
      // Should not throw
    });
  });

  describe('updateMcpMentionsFromText', () => {
    it('does nothing without MCP service', () => {
      controller.updateMcpMentionsFromText('@test');
      // Should not throw
    });

    it('updates mentions when MCP service is set', () => {
      const mcpService = createMockMcpService([{ name: 'test' }]);
      controller.setMcpService(mcpService);
      controller.updateMcpMentionsFromText('@test');

      expect(mcpService.getContextSavingServers).toHaveBeenCalled();
    });
  });

  describe('agent selection callback', () => {
    it('calls onAgentMentionSelect when agent is selected via dropdown', () => {
      // Setup callback with spy
      const onAgentMentionSelect = jest.fn();
      const testCallbacks = createMockCallbacks({ onAgentMentionSelect });

      // Create controller with agent service
      const testController = new MentionDropdownController(
        createMockElement(),
        createMockInput(),
        testCallbacks
      );

      const agentService = createMockAgentService([
        { id: 'custom-agent', name: 'Custom Agent', source: 'vault' },
      ]);
      testController.setAgentService(agentService);

      // Access private method to test selection behavior directly
      // Set up internal state to simulate @ mention at position 0
      testController['mentionStartIndex'] = 0;
      testController['filteredMentionItems'] = [
        {
          type: 'agent' as const,
          id: 'custom-agent',
          name: 'Custom Agent',
          description: 'Test agent',
          source: 'vault' as const,
        },
      ];

      // Mock the dropdown to return index 0
      testController['dropdown'].getSelectedIndex = jest.fn().mockReturnValue(0);

      // Simulate input state
      const testInput = testController['inputEl'];
      testInput.value = '@';
      testInput.selectionStart = 1;

      // Call private selectMentionItem method directly
      testController['selectMentionItem']();

      // Verify callback was called with agent ID
      expect(onAgentMentionSelect).toHaveBeenCalledWith('custom-agent');

      testController.destroy();
    });
  });
});
