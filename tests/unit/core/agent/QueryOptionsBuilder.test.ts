import type { QueryOptionsContext } from '@/core/agent/QueryOptionsBuilder';
import { QueryOptionsBuilder } from '@/core/agent/QueryOptionsBuilder';
import type { PersistentQueryConfig } from '@/core/agent/types';
import type { ClaudianSettings } from '@/core/types';

// Create a mock MCP server manager
function createMockMcpManager() {
  return {
    loadServers: jest.fn().mockResolvedValue(undefined),
    getServers: jest.fn().mockReturnValue([]),
    getEnabledCount: jest.fn().mockReturnValue(0),
    getActiveServers: jest.fn().mockReturnValue({}),
    getDisallowedMcpTools: jest.fn().mockReturnValue([]),
    getAllDisallowedMcpTools: jest.fn().mockReturnValue([]),
    hasServers: jest.fn().mockReturnValue(false),
  } as any;
}

// Create a mock plugin manager
function createMockPluginManager() {
  return {
    setEnabledPluginIds: jest.fn(),
    loadPlugins: jest.fn().mockResolvedValue(undefined),
    getPlugins: jest.fn().mockReturnValue([]),
    getActivePluginConfigs: jest.fn().mockReturnValue([]),
    getUnavailableEnabledPlugins: jest.fn().mockReturnValue([]),
    hasEnabledPlugins: jest.fn().mockReturnValue(false),
    getEnabledCount: jest.fn().mockReturnValue(0),
    getPluginsKey: jest.fn().mockReturnValue(''),
    togglePlugin: jest.fn().mockReturnValue([]),
    enablePlugin: jest.fn().mockReturnValue([]),
    disablePlugin: jest.fn().mockReturnValue([]),
    hasPlugins: jest.fn().mockReturnValue(false),
  } as any;
}

// Create a mock agent manager
function createMockAgentManager(agents: Array<{
  id: string;
  name: string;
  description: string;
  prompt: string;
  source: 'plugin' | 'vault' | 'global' | 'builtin';
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  tools?: string[];
  disallowedTools?: string[];
}> = []) {
  return {
    loadAgents: jest.fn().mockResolvedValue(undefined),
    getAvailableAgents: jest.fn().mockReturnValue(agents),
    getAgentById: jest.fn((id: string) => agents.find(a => a.id === id)),
    searchAgents: jest.fn((query: string) => {
      if (!query) return agents;
      const q = query.toLowerCase();
      return agents.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q)
      );
    }),
  } as any;
}

// Create a mock settings object
function createMockSettings(overrides: Partial<ClaudianSettings> = {}): ClaudianSettings {
  return {
    enableBlocklist: true,
    blockedCommands: {
      unix: ['rm -rf'],
      windows: ['Remove-Item -Recurse -Force'],
    },
    permissions: [],
    permissionMode: 'yolo',
    allowedExportPaths: [],
    loadUserClaudeSettings: false,
    mediaFolder: '',
    systemPrompt: '',
    model: 'claude-sonnet-4-5',
    thinkingBudget: 'off',
    titleGenerationModel: '',
    excludedTags: [],
    environmentVariables: '',
    envSnippets: [],
    slashCommands: [],
    keyboardNavigation: {
      scrollUpKey: 'k',
      scrollDownKey: 'j',
      focusInputKey: 'i',
    },
    claudeCliPath: '',
    show1MModel: false,
    ...overrides,
  } as ClaudianSettings;
}

// Create a base context for tests
function createMockContext(overrides: Partial<QueryOptionsContext> = {}): QueryOptionsContext {
  return {
    vaultPath: '/test/vault',
    cliPath: '/mock/claude',
    settings: createMockSettings(),
    customEnv: {},
    enhancedPath: '/usr/bin:/mock/bin',
    mcpManager: createMockMcpManager(),
    pluginManager: createMockPluginManager(),
    ...overrides,
  };
}

describe('QueryOptionsBuilder', () => {
  describe('needsRestart', () => {
    it('returns true when currentConfig is null', () => {
      const newConfig: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: false,
      };

      expect(QueryOptionsBuilder.needsRestart(null, newConfig)).toBe(true);
    });

    it('returns false when configs are identical', () => {
      const config: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: false,
      };

      expect(QueryOptionsBuilder.needsRestart(config, { ...config })).toBe(false);
    });

    it('returns true when systemPromptKey changes', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: false,
      };

      const newConfig = { ...currentConfig, systemPromptKey: 'key2' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when disallowedToolsKey changes', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: false,
      };

      const newConfig = { ...currentConfig, disallowedToolsKey: 'tool1|tool2' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when claudeCliPath changes', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: false,
      };

      const newConfig = { ...currentConfig, claudeCliPath: '/new/claude' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when allowedExportPaths changes', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: ['/path/a'],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: false,
      };

      const newConfig = { ...currentConfig, allowedExportPaths: ['/path/a', '/path/b'] };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when settingSources changes', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: false,
      };

      const newConfig = { ...currentConfig, settingSources: 'user,project' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when pluginsKey changes', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: false,
      };

      const newConfig = { ...currentConfig, pluginsKey: 'plugin-a:/path/a|plugin-b:/path/b' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns false when only model changes (dynamic update)', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: false,
      };

      const newConfig = { ...currentConfig, model: 'claude-opus-4-5' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(false);
    });

    it('returns true when show1MModel changes from false to true', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'sonnet',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: false,
      };

      const newConfig = { ...currentConfig, show1MModel: true };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when show1MModel changes from true to false', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'sonnet',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: true,
      };

      const newConfig = { ...currentConfig, show1MModel: false };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when externalContextPaths changes', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'sonnet',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: false,
      };

      const newConfig = { ...currentConfig, externalContextPaths: ['/external/path'] };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when externalContextPaths is added', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'sonnet',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: ['/path/a'],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: false,
      };

      const newConfig = { ...currentConfig, externalContextPaths: ['/path/a', '/path/b'] };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when externalContextPaths is removed', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'sonnet',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: ['/path/a', '/path/b'],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: false,
      };

      const newConfig = { ...currentConfig, externalContextPaths: ['/path/a'] };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns false when externalContextPaths order changes (same content)', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'sonnet',
        thinkingTokens: null,
        permissionMode: 'yolo',
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        pluginsKey: '',
        externalContextPaths: ['/path/a', '/path/b'],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
        show1MModel: false,
      };

      // Same paths, different order - should NOT require restart since sorted comparison
      const newConfig = { ...currentConfig, externalContextPaths: ['/path/b', '/path/a'] };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(false);
    });
  });

  describe('buildPersistentQueryConfig', () => {
    it('builds config with default settings', () => {
      const ctx = createMockContext();
      const config = QueryOptionsBuilder.buildPersistentQueryConfig(ctx);

      expect(config.model).toBe('claude-sonnet-4-5');
      expect(config.thinkingTokens).toBeNull();
      expect(config.permissionMode).toBe('yolo');
      expect(config.settingSources).toBe('project');
      expect(config.claudeCliPath).toBe('/mock/claude');
    });

    it('includes thinking tokens when budget is set', () => {
      const ctx = createMockContext({
        settings: createMockSettings({ thinkingBudget: 'high' }),
      });
      const config = QueryOptionsBuilder.buildPersistentQueryConfig(ctx);

      expect(config.thinkingTokens).toBe(16000);
    });

    it('sets settingSources to user,project when loadUserClaudeSettings is true', () => {
      const ctx = createMockContext({
        settings: createMockSettings({ loadUserClaudeSettings: true }),
      });
      const config = QueryOptionsBuilder.buildPersistentQueryConfig(ctx);

      expect(config.settingSources).toBe('user,project');
    });
  });

  describe('buildPersistentQueryOptions', () => {
    it('sets yolo mode options correctly', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
      };
      const options = QueryOptionsBuilder.buildPersistentQueryOptions(ctx);

      expect(options.permissionMode).toBe('bypassPermissions');
      expect(options.allowDangerouslySkipPermissions).toBe(true);
    });

    it('sets normal mode options correctly', () => {
      const canUseTool = jest.fn();
      const ctx = {
        ...createMockContext({
          settings: createMockSettings({ permissionMode: 'normal' }),
        }),
        abortController: new AbortController(),
        hooks: {},
        canUseTool,
      };
      const options = QueryOptionsBuilder.buildPersistentQueryOptions(ctx);

      expect(options.permissionMode).toBe('default');
      // Always true to enable dynamic switching to bypassPermissions without restart
      expect(options.allowDangerouslySkipPermissions).toBe(true);
      expect(options.canUseTool).toBe(canUseTool);
    });

    it('sets thinking tokens for high budget', () => {
      const ctx = {
        ...createMockContext({
          settings: createMockSettings({ thinkingBudget: 'high' }),
        }),
        abortController: new AbortController(),
        hooks: {},
      };
      const options = QueryOptionsBuilder.buildPersistentQueryOptions(ctx);

      expect(options.maxThinkingTokens).toBe(16000);
    });

    it('sets resume session ID when provided', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        resumeSessionId: 'session-123',
      };
      const options = QueryOptionsBuilder.buildPersistentQueryOptions(ctx);

      expect(options.resume).toBe('session-123');
    });

    it('does not set betas when show1MModel is disabled', () => {
      const ctx = {
        ...createMockContext({
          settings: createMockSettings({ model: 'sonnet', show1MModel: false }),
        }),
        abortController: new AbortController(),
        hooks: {},
      };
      const options = QueryOptionsBuilder.buildPersistentQueryOptions(ctx);

      expect(options.model).toBe('sonnet');
      expect(options.betas).toBeUndefined();
    });

    it('sets betas for non-1M model when show1MModel is enabled', () => {
      const ctx = {
        ...createMockContext({
          settings: createMockSettings({ model: 'sonnet', show1MModel: true }),
        }),
        abortController: new AbortController(),
        hooks: {},
      };
      const options = QueryOptionsBuilder.buildPersistentQueryOptions(ctx);

      expect(options.model).toBe('sonnet');
      expect(options.betas).toBeDefined();
      expect(options.betas).toContain('context-1m-2025-08-07');
    });

    it('sets additionalDirectories when externalContextPaths provided', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        externalContextPaths: ['/external/path1', '/external/path2'],
      };
      const options = QueryOptionsBuilder.buildPersistentQueryOptions(ctx);

      expect(options.additionalDirectories).toEqual(['/external/path1', '/external/path2']);
    });

    it('does not set additionalDirectories when externalContextPaths is empty', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        externalContextPaths: [],
      };
      const options = QueryOptionsBuilder.buildPersistentQueryOptions(ctx);

      expect(options.additionalDirectories).toBeUndefined();
    });
  });

  describe('buildColdStartQueryOptions', () => {
    it('includes MCP servers when available', () => {
      const mcpManager = createMockMcpManager();
      mcpManager.getActiveServers.mockReturnValue({
        'test-server': { command: 'test', args: [] },
      });

      const ctx = {
        ...createMockContext({ mcpManager }),
        abortController: new AbortController(),
        hooks: {},
        mcpMentions: new Set(['test-server']),
        hasEditorContext: false,
      };
      const options = QueryOptionsBuilder.buildColdStartQueryOptions(ctx);

      expect(options.mcpServers).toBeDefined();
      expect(options.mcpServers?.['test-server']).toBeDefined();
    });

    it('uses model override when provided', () => {
      const ctx = {
        ...createMockContext({
          settings: createMockSettings({ model: 'claude-sonnet-4-5' }),
        }),
        abortController: new AbortController(),
        hooks: {},
        modelOverride: 'claude-opus-4-5',
        hasEditorContext: false,
      };
      const options = QueryOptionsBuilder.buildColdStartQueryOptions(ctx);

      expect(options.model).toBe('claude-opus-4-5');
    });

    it('applies tool restriction when allowedTools is provided', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        allowedTools: ['Read', 'Grep'],
        hasEditorContext: false,
      };
      const options = QueryOptionsBuilder.buildColdStartQueryOptions(ctx);

      expect(options.tools).toEqual(['Read', 'Grep']);
    });

    it('sets betas when show1MModel is enabled', () => {
      const ctx = {
        ...createMockContext({
          settings: createMockSettings({ model: 'sonnet', show1MModel: true }),
        }),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
      };
      const options = QueryOptionsBuilder.buildColdStartQueryOptions(ctx);

      expect(options.model).toBe('sonnet');
      expect(options.betas).toBeDefined();
      expect(options.betas).toContain('context-1m-2025-08-07');
    });

    it('does not set betas when show1MModel is disabled', () => {
      const ctx = {
        ...createMockContext({
          settings: createMockSettings({ model: 'sonnet' }),
        }),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
      };
      const options = QueryOptionsBuilder.buildColdStartQueryOptions(ctx);

      expect(options.model).toBe('sonnet');
      expect(options.betas).toBeUndefined();
    });

    it('sets additionalDirectories when externalContextPaths provided', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
        externalContextPaths: ['/external/path'],
      };
      const options = QueryOptionsBuilder.buildColdStartQueryOptions(ctx);

      expect(options.additionalDirectories).toEqual(['/external/path']);
    });

    it('does not set additionalDirectories when externalContextPaths is empty', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
        externalContextPaths: [],
      };
      const options = QueryOptionsBuilder.buildColdStartQueryOptions(ctx);

      expect(options.additionalDirectories).toBeUndefined();
    });

    it('includes custom agents in cold-start options', () => {
      const agentManager = createMockAgentManager([
        {
          id: 'cold-agent',
          name: 'Cold Agent',
          description: 'Agent for cold start',
          prompt: 'Cold prompt',
          source: 'vault',
          model: 'sonnet',
        },
      ]);

      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
        agentManager,
      };
      const options = QueryOptionsBuilder.buildColdStartQueryOptions(ctx);

      expect(options.agents).toBeDefined();
      expect(options.agents?.['cold-agent']).toBeDefined();
      expect(options.agents?.['cold-agent'].model).toBe('sonnet');
    });

    it('filters out built-in agents from cold-start options', () => {
      const agentManager = createMockAgentManager([
        {
          id: 'Explore',
          name: 'Explore',
          description: 'Built-in explore',
          prompt: '',
          source: 'builtin',
        },
        {
          id: 'custom-cold',
          name: 'Custom Cold',
          description: 'Custom agent',
          prompt: 'Custom prompt',
          source: 'global',
        },
      ]);

      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
        agentManager,
      };
      const options = QueryOptionsBuilder.buildColdStartQueryOptions(ctx);

      expect(options.agents?.['Explore']).toBeUndefined();
      expect(options.agents?.['custom-cold']).toBeDefined();
    });

    it('converts inherit model to undefined in cold-start agents', () => {
      const agentManager = createMockAgentManager([
        {
          id: 'inherit-agent',
          name: 'Inherit Agent',
          description: 'Uses inherit',
          prompt: 'Inherit prompt',
          source: 'vault',
          model: 'inherit',
        },
      ]);

      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
        agentManager,
      };
      const options = QueryOptionsBuilder.buildColdStartQueryOptions(ctx);

      expect(options.agents?.['inherit-agent']).toBeDefined();
      expect(options.agents?.['inherit-agent'].model).toBeUndefined();
    });
  });

  describe('getMcpServersConfig', () => {
    it('returns empty servers when no mentions', () => {
      const mcpManager = createMockMcpManager();
      const result = QueryOptionsBuilder.getMcpServersConfig(mcpManager);

      expect(result.servers).toEqual({});
      expect(result.key).toBe('{}');
    });

    it('combines mentions and UI-enabled servers', () => {
      const mcpManager = createMockMcpManager();
      mcpManager.getActiveServers.mockReturnValue({
        'server1': { command: 'cmd1' },
        'server2': { command: 'cmd2' },
      });

      QueryOptionsBuilder.getMcpServersConfig(
        mcpManager,
        new Set(['server1']),
        new Set(['server2'])
      );

      expect(mcpManager.getActiveServers).toHaveBeenCalledWith(
        new Set(['server1', 'server2'])
      );
    });
  });

  describe('buildSdkAgentsRecord model conversion', () => {
    it('converts inherit model to undefined in SDK agents', () => {
      const agentManager = createMockAgentManager([
        {
          id: 'test-agent',
          name: 'Test Agent',
          description: 'A test agent',
          prompt: 'Test prompt',
          source: 'vault',
          model: 'inherit',
        },
      ]);

      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        agentManager,
      };
      const options = QueryOptionsBuilder.buildPersistentQueryOptions(ctx);

      expect(options.agents).toBeDefined();
      expect(options.agents?.['test-agent']).toBeDefined();
      expect(options.agents?.['test-agent'].model).toBeUndefined();
    });

    it('passes through explicit model values to SDK agents', () => {
      const agentManager = createMockAgentManager([
        {
          id: 'sonnet-agent',
          name: 'Sonnet Agent',
          description: 'Uses sonnet',
          prompt: 'Sonnet prompt',
          source: 'vault',
          model: 'sonnet',
        },
        {
          id: 'opus-agent',
          name: 'Opus Agent',
          description: 'Uses opus',
          prompt: 'Opus prompt',
          source: 'global',
          model: 'opus',
        },
        {
          id: 'haiku-agent',
          name: 'Haiku Agent',
          description: 'Uses haiku',
          prompt: 'Haiku prompt',
          source: 'vault',
          model: 'haiku',
        },
      ]);

      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        agentManager,
      };
      const options = QueryOptionsBuilder.buildPersistentQueryOptions(ctx);

      expect(options.agents?.['sonnet-agent'].model).toBe('sonnet');
      expect(options.agents?.['opus-agent'].model).toBe('opus');
      expect(options.agents?.['haiku-agent'].model).toBe('haiku');
    });

    it('filters out built-in agents from SDK options', () => {
      const agentManager = createMockAgentManager([
        {
          id: 'Explore',
          name: 'Explore',
          description: 'Built-in explore',
          prompt: '',
          source: 'builtin',
        },
        {
          id: 'custom-agent',
          name: 'Custom Agent',
          description: 'Custom agent',
          prompt: 'Custom prompt',
          source: 'vault',
        },
      ]);

      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        agentManager,
      };
      const options = QueryOptionsBuilder.buildPersistentQueryOptions(ctx);

      // Built-in should be filtered out
      expect(options.agents?.['Explore']).toBeUndefined();
      // Custom should be included
      expect(options.agents?.['custom-agent']).toBeDefined();
    });

    it('includes tools and disallowedTools in SDK agents', () => {
      const agentManager = createMockAgentManager([
        {
          id: 'restricted-agent',
          name: 'Restricted Agent',
          description: 'Has tool restrictions',
          prompt: 'Restricted prompt',
          source: 'vault',
          tools: ['Read', 'Grep'],
          disallowedTools: ['Bash', 'Write'],
        },
      ]);

      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        agentManager,
      };
      const options = QueryOptionsBuilder.buildPersistentQueryOptions(ctx);

      expect(options.agents?.['restricted-agent'].tools).toEqual(['Read', 'Grep']);
      expect(options.agents?.['restricted-agent'].disallowedTools).toEqual(['Bash', 'Write']);
    });
  });
});
