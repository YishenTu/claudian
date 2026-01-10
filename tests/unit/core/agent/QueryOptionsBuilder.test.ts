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
        allowDangerouslySkip: true,
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
      };

      expect(QueryOptionsBuilder.needsRestart(null, newConfig)).toBe(true);
    });

    it('returns false when configs are identical', () => {
      const config: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        allowDangerouslySkip: true,
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
      };

      expect(QueryOptionsBuilder.needsRestart(config, { ...config })).toBe(false);
    });

    it('returns true when systemPromptKey changes', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        allowDangerouslySkip: true,
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
      };

      const newConfig = { ...currentConfig, systemPromptKey: 'key2' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when disallowedToolsKey changes', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        allowDangerouslySkip: true,
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
      };

      const newConfig = { ...currentConfig, disallowedToolsKey: 'tool1|tool2' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when claudeCliPath changes', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        allowDangerouslySkip: true,
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
      };

      const newConfig = { ...currentConfig, claudeCliPath: '/new/claude' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when allowedExportPaths changes', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        allowDangerouslySkip: true,
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        externalContextPaths: [],
        allowedExportPaths: ['/path/a'],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
      };

      const newConfig = { ...currentConfig, allowedExportPaths: ['/path/a', '/path/b'] };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when settingSources changes', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        allowDangerouslySkip: true,
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
      };

      const newConfig = { ...currentConfig, settingSources: 'user,project' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns false when only model changes (dynamic update)', () => {
      const currentConfig: PersistentQueryConfig = {
        model: 'claude-sonnet-4-5',
        thinkingTokens: null,
        permissionMode: 'yolo',
        allowDangerouslySkip: true,
        systemPromptKey: 'key1',
        disallowedToolsKey: '',
        mcpServersKey: '',
        externalContextPaths: [],
        allowedExportPaths: [],
        settingSources: 'project',
        claudeCliPath: '/mock/claude',
      };

      const newConfig = { ...currentConfig, model: 'claude-opus-4-5' };
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
      expect(config.allowDangerouslySkip).toBe(true);
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
});
