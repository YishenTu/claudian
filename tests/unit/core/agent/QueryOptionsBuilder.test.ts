import * as fs from 'fs';

import type { GeminiCliArgs,QueryOptionsContext } from '@/core/agent/QueryOptionsBuilder';
import { QueryOptionsBuilder } from '@/core/agent/QueryOptionsBuilder';
import type { PersistentQueryConfig } from '@/core/agent/types';
import type { GeminianSettings } from '@/core/types';

jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

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

function createMockPluginManager() {
  return {
    setEnabledPluginIds: jest.fn(),
    loadPlugins: jest.fn().mockResolvedValue(undefined),
    getPlugins: jest.fn().mockReturnValue([]),
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

function createMockSettings(overrides: Partial<GeminianSettings> = {}): GeminianSettings {
  return {
    enableBlocklist: true,
    blockedCommands: {
      unix: ['rm -rf'],
      windows: ['Remove-Item -Recurse -Force'],
    },
    permissionMode: 'yolo',
    allowedExportPaths: [],
    loadUserGeminiSettings: false,
    mediaFolder: '',
    systemPrompt: '',
    model: 'auto',
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
    geminiCliPath: '',
    ...overrides,
  } as GeminianSettings;
}

function createMockPersistentQueryConfig(
  overrides: Partial<PersistentQueryConfig> = {}
): PersistentQueryConfig {
  return {
    model: 'auto',
    thinkingTokens: null,
    permissionMode: 'yolo',
    systemPromptKey: 'key1',
    disallowedToolsKey: '',
    mcpServersKey: '',
    pluginsKey: '',
    externalContextPaths: [],
    allowedExportPaths: [],
    settingSources: 'project',
    geminiCliPath: '/mock/claude',
    ...overrides,
  };
}

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
      const newConfig = createMockPersistentQueryConfig();
      expect(QueryOptionsBuilder.needsRestart(null, newConfig)).toBe(true);
    });

    it('returns false when configs are identical', () => {
      const config = createMockPersistentQueryConfig();
      expect(QueryOptionsBuilder.needsRestart(config, { ...config })).toBe(false);
    });

    it('returns true when systemPromptKey changes', () => {
      const currentConfig = createMockPersistentQueryConfig();
      const newConfig = { ...currentConfig, systemPromptKey: 'key2' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when disallowedToolsKey changes', () => {
      const currentConfig = createMockPersistentQueryConfig();
      const newConfig = { ...currentConfig, disallowedToolsKey: 'tool1|tool2' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when geminiCliPath changes', () => {
      const currentConfig = createMockPersistentQueryConfig();
      const newConfig = { ...currentConfig, geminiCliPath: '/new/claude' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when allowedExportPaths changes', () => {
      const currentConfig = createMockPersistentQueryConfig({ allowedExportPaths: ['/path/a'] });
      const newConfig = { ...currentConfig, allowedExportPaths: ['/path/a', '/path/b'] };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when settingSources changes', () => {
      const currentConfig = createMockPersistentQueryConfig();
      const newConfig = { ...currentConfig, settingSources: 'user,project' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when pluginsKey changes', () => {
      const currentConfig = createMockPersistentQueryConfig();
      const newConfig = { ...currentConfig, pluginsKey: 'plugin-a:/path/a|plugin-b:/path/b' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns false when only model changes (dynamic update)', () => {
      const currentConfig = createMockPersistentQueryConfig();
      const newConfig = { ...currentConfig, model: 'pro' };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(false);
    });

    it('returns true when externalContextPaths changes', () => {
      const currentConfig = createMockPersistentQueryConfig();
      const newConfig = { ...currentConfig, externalContextPaths: ['/external/path'] };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when externalContextPaths is added', () => {
      const currentConfig = createMockPersistentQueryConfig({ externalContextPaths: ['/path/a'] });
      const newConfig = { ...currentConfig, externalContextPaths: ['/path/a', '/path/b'] };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns true when externalContextPaths is removed', () => {
      const currentConfig = createMockPersistentQueryConfig({ externalContextPaths: ['/path/a', '/path/b'] });
      const newConfig = { ...currentConfig, externalContextPaths: ['/path/a'] };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(true);
    });

    it('returns false when externalContextPaths order changes (same content)', () => {
      const currentConfig = createMockPersistentQueryConfig({ externalContextPaths: ['/path/a', '/path/b'] });
      // Same paths, different order - should NOT require restart since sorted comparison
      const newConfig = { ...currentConfig, externalContextPaths: ['/path/b', '/path/a'] };
      expect(QueryOptionsBuilder.needsRestart(currentConfig, newConfig)).toBe(false);
    });
  });

  describe('buildPersistentQueryConfig', () => {
    it('builds config with default settings', () => {
      const ctx = createMockContext();
      const config = QueryOptionsBuilder.buildPersistentQueryConfig(ctx);

      expect(config.model).toBe('auto');
      expect(config.thinkingTokens).toBeNull();
      expect(config.permissionMode).toBe('yolo');
      expect(config.settingSources).toBe('project');
      expect(config.geminiCliPath).toBe('/mock/claude');
    });

    it('includes thinking tokens when budget is set', () => {
      const ctx = createMockContext({
        settings: createMockSettings({ thinkingBudget: 'high' }),
      });
      const config = QueryOptionsBuilder.buildPersistentQueryConfig(ctx);

      expect(config.thinkingTokens).toBe(16000);
    });

    it('sets settingSources to user,project when loadUserGeminiSettings is true', () => {
      const ctx = createMockContext({
        settings: createMockSettings({ loadUserGeminiSettings: true }),
      });
      const config = QueryOptionsBuilder.buildPersistentQueryConfig(ctx);

      expect(config.settingSources).toBe('user,project');
    });
  });

  describe('buildPersistentCliArgs', () => {
    it('sets yolo mode approval arg correctly', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildPersistentCliArgs(ctx);

      expect(result.args).toContain('--approval-mode');
      expect(result.args[result.args.indexOf('--approval-mode') + 1]).toBe('yolo');
    });

    it('sets normal mode approval arg correctly', () => {
      const ctx = {
        ...createMockContext({
          settings: createMockSettings({ permissionMode: 'normal' }),
        }),
        abortController: new AbortController(),
        hooks: {},
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildPersistentCliArgs(ctx);

      expect(result.args).toContain('--approval-mode');
      expect(result.args[result.args.indexOf('--approval-mode') + 1]).toBe('auto_edit');
    });

    it('sets plan mode approval arg correctly', () => {
      const ctx = {
        ...createMockContext({
          settings: createMockSettings({ permissionMode: 'plan' }),
        }),
        abortController: new AbortController(),
        hooks: {},
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildPersistentCliArgs(ctx);

      expect(result.args).toContain('--approval-mode');
      expect(result.args[result.args.indexOf('--approval-mode') + 1]).toBe('plan');
    });

    it('includes model in args', () => {
      const ctx = {
        ...createMockContext({
          settings: createMockSettings({ model: 'pro' }),
        }),
        abortController: new AbortController(),
        hooks: {},
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildPersistentCliArgs(ctx);

      expect(result.args).toContain('--model');
      expect(result.args[result.args.indexOf('--model') + 1]).toBe('pro');
    });

    it('includes resume session ID when provided', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        resume: { sessionId: 'session-123' },
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildPersistentCliArgs(ctx);

      expect(result.args).toContain('--resume');
      expect(result.args[result.args.indexOf('--resume') + 1]).toBe('session-123');
    });

    it('does not include resume when not provided', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildPersistentCliArgs(ctx);

      expect(result.args).not.toContain('--resume');
    });

    it('includes externalContextPaths as --include-directories', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        externalContextPaths: ['/external/path1', '/external/path2'],
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildPersistentCliArgs(ctx);

      expect(result.args).toContain('--include-directories');
      expect(result.args[result.args.indexOf('--include-directories') + 1]).toBe('/external/path1,/external/path2');
    });

    it('does not include --include-directories when externalContextPaths is empty', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        externalContextPaths: [],
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildPersistentCliArgs(ctx);

      expect(result.args).not.toContain('--include-directories');
    });

    it('returns correct cwd and cliPath', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildPersistentCliArgs(ctx);

      expect(result.cwd).toBe('/test/vault');
      expect(result.cliPath).toBe('/mock/claude');
    });

    it('writes system prompt file and sets GEMINI_SYSTEM_MD in env', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildPersistentCliArgs(ctx);

      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(result.env.GEMINI_SYSTEM_MD).toBeDefined();
      expect(result.systemPrompt).toBeDefined();
    });

    it('includes custom env in result', () => {
      const ctx = {
        ...createMockContext({
          customEnv: { MY_VAR: 'test' },
        }),
        abortController: new AbortController(),
        hooks: {},
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildPersistentCliArgs(ctx);

      expect(result.env.MY_VAR).toBe('test');
    });

    it('always includes --output-format stream-json', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildPersistentCliArgs(ctx);

      expect(result.args).toContain('--output-format');
      expect(result.args[result.args.indexOf('--output-format') + 1]).toBe('stream-json');
    });
  });

  describe('buildColdStartCliArgs', () => {
    it('uses model override when provided', () => {
      const ctx = {
        ...createMockContext({
          settings: createMockSettings({ model: 'auto' }),
        }),
        abortController: new AbortController(),
        hooks: {},
        modelOverride: 'pro',
        hasEditorContext: false,
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildColdStartCliArgs(ctx, 'hello');

      expect(result.args).toContain('--model');
      expect(result.args[result.args.indexOf('--model') + 1]).toBe('pro');
    });

    it('uses settings model when no override provided', () => {
      const ctx = {
        ...createMockContext({
          settings: createMockSettings({ model: 'flash' }),
        }),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildColdStartCliArgs(ctx, 'hello');

      expect(result.args).toContain('--model');
      expect(result.args[result.args.indexOf('--model') + 1]).toBe('flash');
    });

    it('includes prompt in args', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildColdStartCliArgs(ctx, 'test prompt');

      expect(result.args).toContain('--prompt');
      expect(result.args[result.args.indexOf('--prompt') + 1]).toBe('test prompt');
    });

    it('includes allowedTools as --allowed-tools', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        allowedTools: ['Read', 'Grep'],
        hasEditorContext: false,
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildColdStartCliArgs(ctx, 'hello');

      expect(result.args).toContain('--allowed-tools');
      expect(result.args[result.args.indexOf('--allowed-tools') + 1]).toBe('Read,Grep');
    });

    it('does not include --allowed-tools when not provided', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildColdStartCliArgs(ctx, 'hello');

      expect(result.args).not.toContain('--allowed-tools');
    });

    it('includes externalContextPaths as --include-directories', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
        externalContextPaths: ['/external/path'],
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildColdStartCliArgs(ctx, 'hello');

      expect(result.args).toContain('--include-directories');
      expect(result.args[result.args.indexOf('--include-directories') + 1]).toBe('/external/path');
    });

    it('does not include --include-directories when externalContextPaths is empty', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
        externalContextPaths: [],
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildColdStartCliArgs(ctx, 'hello');

      expect(result.args).not.toContain('--include-directories');
    });

    it('includes session resume when sessionId provided', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
        sessionId: 'session-abc',
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildColdStartCliArgs(ctx, 'hello');

      expect(result.args).toContain('--resume');
      expect(result.args[result.args.indexOf('--resume') + 1]).toBe('session-abc');
    });

    it('returns correct cwd and cliPath', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildColdStartCliArgs(ctx, 'hello');

      expect(result.cwd).toBe('/test/vault');
      expect(result.cliPath).toBe('/mock/claude');
    });

    it('writes system prompt file and sets GEMINI_SYSTEM_MD in env', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildColdStartCliArgs(ctx, 'hello');

      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(result.env.GEMINI_SYSTEM_MD).toBeDefined();
      expect(result.systemPrompt).toBeDefined();
    });

    it('always includes --output-format stream-json', () => {
      const ctx = {
        ...createMockContext(),
        abortController: new AbortController(),
        hooks: {},
        hasEditorContext: false,
      };
      const result: GeminiCliArgs = QueryOptionsBuilder.buildColdStartCliArgs(ctx, 'hello');

      expect(result.args).toContain('--output-format');
      expect(result.args[result.args.indexOf('--output-format') + 1]).toBe('stream-json');
    });
  });
});
