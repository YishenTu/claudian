import type {
  ChatMessage,
  ClaudianSettings,
  Conversation,
  ConversationMeta,
  EnvSnippet,
  LegacyPermission,
  StreamChunk,
  ToolCallInfo
} from '@/core/types';
import {
  BETA_1M_CONTEXT,
  CONTEXT_WINDOW_1M,
  CONTEXT_WINDOW_STANDARD,
  createPermissionRule,
  DEFAULT_SETTINGS,
  getCliPlatformKey,
  getContextWindowSize,
  legacyPermissionsToCCPermissions,
  legacyPermissionToCCRule,
  parseCCPermissionRule,
  resolveModelWithBetas,
  VIEW_TYPE_CLAUDIAN
} from '@/core/types';

describe('types.ts', () => {
  describe('VIEW_TYPE_CLAUDIAN', () => {
    it('should be defined as the correct view type', () => {
      expect(VIEW_TYPE_CLAUDIAN).toBe('claudian-view');
    });
  });

  describe('DEFAULT_SETTINGS', () => {
    it('should have enableBlocklist set to true by default', () => {
      expect(DEFAULT_SETTINGS.enableBlocklist).toBe(true);
    });

    it('should have default blocked commands as platform-keyed object', () => {
      expect(DEFAULT_SETTINGS.blockedCommands).toHaveProperty('unix');
      expect(DEFAULT_SETTINGS.blockedCommands).toHaveProperty('windows');
      expect(DEFAULT_SETTINGS.blockedCommands.unix).toBeInstanceOf(Array);
      expect(DEFAULT_SETTINGS.blockedCommands.windows).toBeInstanceOf(Array);
      expect(DEFAULT_SETTINGS.blockedCommands.unix.length).toBeGreaterThan(0);
      expect(DEFAULT_SETTINGS.blockedCommands.windows.length).toBeGreaterThan(0);
    });

    it('should block rm -rf by default on Unix', () => {
      expect(DEFAULT_SETTINGS.blockedCommands.unix).toContain('rm -rf');
    });

    it('should block chmod 777 by default on Unix', () => {
      expect(DEFAULT_SETTINGS.blockedCommands.unix).toContain('chmod 777');
    });

    it('should block chmod -R 777 by default on Unix', () => {
      expect(DEFAULT_SETTINGS.blockedCommands.unix).toContain('chmod -R 777');
    });

    it('should block dangerous commands on Windows', () => {
      expect(DEFAULT_SETTINGS.blockedCommands.windows).toContain('Remove-Item -Recurse -Force');
      expect(DEFAULT_SETTINGS.blockedCommands.windows).toContain('Format-Volume');
    });

    it('should only contain non-empty default blocked commands', () => {
      expect(DEFAULT_SETTINGS.blockedCommands.unix.every((cmd) => cmd.trim().length > 0)).toBe(true);
      expect(new Set(DEFAULT_SETTINGS.blockedCommands.unix).size).toBe(DEFAULT_SETTINGS.blockedCommands.unix.length);
      expect(DEFAULT_SETTINGS.blockedCommands.windows.every((cmd) => cmd.trim().length > 0)).toBe(true);
      expect(new Set(DEFAULT_SETTINGS.blockedCommands.windows).size).toBe(DEFAULT_SETTINGS.blockedCommands.windows.length);
    });

    it('should have environmentVariables as empty string by default', () => {
      expect(DEFAULT_SETTINGS.environmentVariables).toBe('');
    });

    it('should have envSnippets as empty array by default', () => {
      expect(DEFAULT_SETTINGS.envSnippets).toEqual([]);
    });

    it('should have lastClaudeModel set to haiku by default', () => {
      expect(DEFAULT_SETTINGS.lastClaudeModel).toBe('haiku');
    });

    it('should have lastCustomModel as empty string by default', () => {
      expect(DEFAULT_SETTINGS.lastCustomModel).toBe('');
    });
  });

  describe('ClaudianSettings type', () => {
    it('should be assignable with valid settings', () => {
      const settings: ClaudianSettings = {
        userName: '',
        enableBlocklist: false,
        blockedCommands: { unix: ['test'], windows: ['test-win'] },
        model: 'haiku',
        enableAutoTitleGeneration: true,
        titleGenerationModel: '',
        thinkingBudget: 'off',
        permissionMode: 'yolo',
        excludedTags: [],
        mediaFolder: '',
        environmentVariables: '',
        envSnippets: [],
        customContextLimits: {},
        systemPrompt: '',
        allowedExportPaths: [],
        persistentExternalContextPaths: [],
        slashCommands: [],
        keyboardNavigation: { scrollUpKey: 'w', scrollDownKey: 's', focusInputKey: 'i' },
        locale: 'en',
        claudeCliPath: '',
        claudeCliPathsByHost: {},
        loadUserClaudeSettings: false,
        maxTabs: 3,
        show1MModel: false,
        tabBarPosition: 'input',
      };

      expect(settings.enableBlocklist).toBe(false);
      expect(settings.blockedCommands).toEqual({ unix: ['test'], windows: ['test-win'] });
      expect(settings.model).toBe('haiku');
    });

    it('should accept custom model strings', () => {
      const settings: ClaudianSettings = {
        userName: '',
        enableBlocklist: true,
        blockedCommands: { unix: [], windows: [] },
        model: 'anthropic/custom-model-v1',
        enableAutoTitleGeneration: true,
        titleGenerationModel: '',
        thinkingBudget: 'medium',
        permissionMode: 'normal',
        excludedTags: ['private'],
        mediaFolder: 'attachments',
        environmentVariables: 'API_KEY=test',
        envSnippets: [],
        customContextLimits: {},
        systemPrompt: '',
        allowedExportPaths: [],
        persistentExternalContextPaths: [],
        slashCommands: [],
        keyboardNavigation: { scrollUpKey: 'w', scrollDownKey: 's', focusInputKey: 'i' },
        locale: 'zh-CN',
        claudeCliPath: '',
        claudeCliPathsByHost: {},
        loadUserClaudeSettings: false,
        maxTabs: 3,
        show1MModel: false,
        tabBarPosition: 'input',
      };

      expect(settings.model).toBe('anthropic/custom-model-v1');
    });

    it('should accept optional lastClaudeModel and lastCustomModel', () => {
      const settings: ClaudianSettings = {
        userName: '',
        enableBlocklist: true,
        blockedCommands: { unix: [], windows: [] },
        model: 'sonnet',
        enableAutoTitleGeneration: true,
        titleGenerationModel: '',
        lastClaudeModel: 'opus',
        lastCustomModel: 'custom/model',
        thinkingBudget: 'high',
        permissionMode: 'yolo',
        excludedTags: [],
        mediaFolder: '',
        environmentVariables: '',
        envSnippets: [],
        customContextLimits: {},
        systemPrompt: '',
        allowedExportPaths: [],
        persistentExternalContextPaths: [],
        slashCommands: [],
        keyboardNavigation: { scrollUpKey: 'w', scrollDownKey: 's', focusInputKey: 'i' },
        locale: 'en',
        claudeCliPath: '',
        claudeCliPathsByHost: {},
        loadUserClaudeSettings: false,
        maxTabs: 5,
        show1MModel: true,
        tabBarPosition: 'header',
      };

      expect(settings.lastClaudeModel).toBe('opus');
      expect(settings.lastCustomModel).toBe('custom/model');
    });
  });

  describe('EnvSnippet type', () => {
    it('should store all required fields', () => {
      const snippet: EnvSnippet = {
        id: 'snippet-123',
        name: 'Production Config',
        description: 'Production environment variables',
        envVars: 'API_KEY=prod-key\nDEBUG=false',
      };

      expect(snippet.id).toBe('snippet-123');
      expect(snippet.name).toBe('Production Config');
      expect(snippet.description).toBe('Production environment variables');
      expect(snippet.envVars).toContain('API_KEY=prod-key');
    });

    it('should allow empty description', () => {
      const snippet: EnvSnippet = {
        id: 'snippet-789',
        name: 'Quick Config',
        description: '',
        envVars: 'KEY=value',
      };

      expect(snippet.description).toBe('');
    });
  });

  describe('ChatMessage type', () => {
    it('should accept user role', () => {
      const msg: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      };

      expect(msg.role).toBe('user');
    });

    it('should accept assistant role', () => {
      const msg: ChatMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: 'Hi there!',
        timestamp: Date.now(),
      };

      expect(msg.role).toBe('assistant');
    });

    it('should accept optional toolCalls array', () => {
      const toolCalls: ToolCallInfo[] = [
        {
          id: 'tool-1',
          name: 'Read',
          input: { file_path: '/test.txt' },
          status: 'completed',
          result: 'file contents',
        },
      ];

      const msg: ChatMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: 'Reading file...',
        timestamp: Date.now(),
        toolCalls,
      };

      expect(msg.toolCalls).toEqual(toolCalls);
    });
  });

  describe('ToolCallInfo type', () => {
    it('should store tool name, input, status, and result', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-123',
        name: 'Bash',
        input: { command: 'ls -la' },
        status: 'completed',
        result: 'file1.txt\nfile2.txt',
      };

      expect(toolCall.id).toBe('tool-123');
      expect(toolCall.name).toBe('Bash');
      expect(toolCall.input).toEqual({ command: 'ls -la' });
      expect(toolCall.status).toBe('completed');
      expect(toolCall.result).toBe('file1.txt\nfile2.txt');
    });

    it('should accept running status', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-123',
        name: 'Read',
        input: { file_path: '/test.txt' },
        status: 'running',
      };

      expect(toolCall.status).toBe('running');
    });

    it('should accept error status', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-123',
        name: 'Read',
        input: { file_path: '/test.txt' },
        status: 'error',
        result: 'File not found',
      };

      expect(toolCall.status).toBe('error');
    });
  });

  describe('StreamChunk type', () => {
    it('should accept text type', () => {
      const chunk: StreamChunk = {
        type: 'text',
        content: 'Hello world',
      };

      expect(chunk.type).toBe('text');
      // eslint-disable-next-line jest/no-conditional-expect
      if (chunk.type === 'text') expect(chunk.content).toBe('Hello world');
    });

    it('should accept tool_use type', () => {
      const chunk: StreamChunk = {
        type: 'tool_use',
        id: 'tool-123',
        name: 'Read',
        input: { file_path: '/test.txt' },
      };

      expect(chunk.type).toBe('tool_use');
      if (chunk.type === 'tool_use') {
        // Type narrowing block - eslint-disable-next-line jest/no-conditional-expect
        expect(chunk.id).toBe('tool-123'); // eslint-disable-line jest/no-conditional-expect
        expect(chunk.name).toBe('Read'); // eslint-disable-line jest/no-conditional-expect
        expect(chunk.input).toEqual({ file_path: '/test.txt' }); // eslint-disable-line jest/no-conditional-expect
      }
    });

    it('should accept tool_result type', () => {
      const chunk: StreamChunk = {
        type: 'tool_result',
        id: 'tool-123',
        content: 'File contents here',
      };

      expect(chunk.type).toBe('tool_result');
      if (chunk.type === 'tool_result') {
        expect(chunk.id).toBe('tool-123'); // eslint-disable-line jest/no-conditional-expect
        expect(chunk.content).toBe('File contents here'); // eslint-disable-line jest/no-conditional-expect
      }
    });

    it('should accept error type', () => {
      const chunk: StreamChunk = {
        type: 'error',
        content: 'Something went wrong',
      };

      expect(chunk.type).toBe('error');
      // eslint-disable-next-line jest/no-conditional-expect
      if (chunk.type === 'error') expect(chunk.content).toBe('Something went wrong');
    });

    it('should accept blocked type', () => {
      const chunk: StreamChunk = {
        type: 'blocked',
        content: 'Command blocked: rm -rf',
      };

      expect(chunk.type).toBe('blocked');
      // eslint-disable-next-line jest/no-conditional-expect
      if (chunk.type === 'blocked') expect(chunk.content).toBe('Command blocked: rm -rf');
    });

    it('should accept done type', () => {
      const chunk: StreamChunk = {
        type: 'done',
      };

      expect(chunk.type).toBe('done');
    });
  });

  describe('Conversation type', () => {
    it('should store conversation with all required fields', () => {
      const conversation: Conversation = {
        id: 'conv-123',
        title: 'Test Conversation',
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        sessionId: 'session-abc',
        messages: [],
      };

      expect(conversation.id).toBe('conv-123');
      expect(conversation.title).toBe('Test Conversation');
      expect(conversation.createdAt).toBe(1700000000000);
      expect(conversation.updatedAt).toBe(1700000001000);
      expect(conversation.sessionId).toBe('session-abc');
      expect(conversation.messages).toEqual([]);
    });

    it('should allow null sessionId for new conversations', () => {
      const conversation: Conversation = {
        id: 'conv-456',
        title: 'New Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: null,
        messages: [],
      };

      expect(conversation.sessionId).toBeNull();
    });

    it('should store messages array with ChatMessage objects', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant', content: 'Hi there!', timestamp: Date.now() },
      ];

      const conversation: Conversation = {
        id: 'conv-789',
        title: 'Chat with Messages',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionId: 'session-xyz',
        messages,
      };

      expect(conversation.messages).toHaveLength(2);
      expect(conversation.messages[0].role).toBe('user');
      expect(conversation.messages[1].role).toBe('assistant');
    });
  });

  describe('ConversationMeta type', () => {
    it('should store conversation metadata without messages', () => {
      const meta: ConversationMeta = {
        id: 'conv-123',
        title: 'Test Conversation',
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        messageCount: 5,
        preview: 'Hello, how can I...',
      };

      expect(meta.id).toBe('conv-123');
      expect(meta.title).toBe('Test Conversation');
      expect(meta.createdAt).toBe(1700000000000);
      expect(meta.updatedAt).toBe(1700000001000);
      expect(meta.messageCount).toBe(5);
      expect(meta.preview).toBe('Hello, how can I...');
    });

    it('should have preview for empty conversations', () => {
      const meta: ConversationMeta = {
        id: 'conv-empty',
        title: 'Empty Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
        preview: 'New conversation',
      };

      expect(meta.messageCount).toBe(0);
      expect(meta.preview).toBe('New conversation');
    });
  });

  describe('Platform CLI helpers (deprecated)', () => {
    describe('getCliPlatformKey', () => {
      it('should return a valid platform key', () => {
        const key = getCliPlatformKey();
        expect(['macos', 'linux', 'windows']).toContain(key);
      });

      it('should return consistent results', () => {
        const key1 = getCliPlatformKey();
        const key2 = getCliPlatformKey();
        expect(key1).toBe(key2);
      });
    });

    describe('DEFAULT_SETTINGS.claudeCliPathsByHost', () => {
      it('should have empty hostname-based CLI paths by default', () => {
        expect(DEFAULT_SETTINGS.claudeCliPathsByHost).toBeDefined();
        expect(DEFAULT_SETTINGS.claudeCliPathsByHost).toEqual({});
      });
    });
  });

  describe('Permission Conversion Utilities', () => {
    describe('legacyPermissionToCCRule', () => {
      it('should convert Bash permission with pattern', () => {
        const legacy: LegacyPermission = {
          toolName: 'Bash',
          pattern: 'git status',
          approvedAt: Date.now(),
          scope: 'always',
        };
        expect(legacyPermissionToCCRule(legacy)).toBe('Bash(git status)');
      });

      it('should convert Read permission with file path', () => {
        const legacy: LegacyPermission = {
          toolName: 'Read',
          pattern: '/path/to/file.txt',
          approvedAt: Date.now(),
          scope: 'always',
        };
        expect(legacyPermissionToCCRule(legacy)).toBe('Read(/path/to/file.txt)');
      });

      it('should return just tool name for wildcard pattern', () => {
        const legacy: LegacyPermission = {
          toolName: 'WebSearch',
          pattern: '*',
          approvedAt: Date.now(),
          scope: 'always',
        };
        expect(legacyPermissionToCCRule(legacy)).toBe('WebSearch');
      });

      it('should return just tool name for empty pattern', () => {
        const legacy: LegacyPermission = {
          toolName: 'Glob',
          pattern: '',
          approvedAt: Date.now(),
          scope: 'always',
        };
        expect(legacyPermissionToCCRule(legacy)).toBe('Glob');
      });

      it('should return just tool name for JSON object pattern (legacy format)', () => {
        const legacy: LegacyPermission = {
          toolName: 'CustomTool',
          pattern: '{"key":"value"}',
          approvedAt: Date.now(),
          scope: 'always',
        };
        expect(legacyPermissionToCCRule(legacy)).toBe('CustomTool');
      });
    });

    describe('legacyPermissionsToCCPermissions', () => {
      it('should convert array of legacy permissions to CC format', () => {
        const legacy: LegacyPermission[] = [
          { toolName: 'Bash', pattern: 'git *', approvedAt: Date.now(), scope: 'always' },
          { toolName: 'Read', pattern: '/vault', approvedAt: Date.now(), scope: 'always' },
        ];
        const result = legacyPermissionsToCCPermissions(legacy);
        expect(result.allow).toEqual(['Bash(git *)', 'Read(/vault)']);
        expect(result.deny).toEqual([]);
        expect(result.ask).toEqual([]);
      });

      it('should skip session-scoped permissions', () => {
        const legacy: LegacyPermission[] = [
          { toolName: 'Bash', pattern: 'npm test', approvedAt: Date.now(), scope: 'always' },
          { toolName: 'Bash', pattern: 'rm temp.txt', approvedAt: Date.now(), scope: 'session' },
        ];
        const result = legacyPermissionsToCCPermissions(legacy);
        expect(result.allow).toEqual(['Bash(npm test)']);
      });

      it('should deduplicate rules', () => {
        const legacy: LegacyPermission[] = [
          { toolName: 'Read', pattern: '*', approvedAt: Date.now(), scope: 'always' },
          { toolName: 'Read', pattern: '*', approvedAt: Date.now() + 1000, scope: 'always' },
        ];
        const result = legacyPermissionsToCCPermissions(legacy);
        expect(result.allow).toEqual(['Read']);
      });

      it('should return empty arrays for empty input', () => {
        const result = legacyPermissionsToCCPermissions([]);
        expect(result.allow).toEqual([]);
        expect(result.deny).toEqual([]);
        expect(result.ask).toEqual([]);
      });
    });

    describe('parseCCPermissionRule', () => {
      it('should parse rule with pattern', () => {
        const result = parseCCPermissionRule(createPermissionRule('Bash(git status)'));
        expect(result.tool).toBe('Bash');
        expect(result.pattern).toBe('git status');
      });

      it('should parse rule with complex pattern', () => {
        const result = parseCCPermissionRule(createPermissionRule('WebFetch(domain:github.com)'));
        expect(result.tool).toBe('WebFetch');
        expect(result.pattern).toBe('domain:github.com');
      });

      it('should parse rule without pattern', () => {
        const result = parseCCPermissionRule(createPermissionRule('Read'));
        expect(result.tool).toBe('Read');
        expect(result.pattern).toBeUndefined();
      });

      it('should handle nested parentheses in pattern', () => {
        const result = parseCCPermissionRule(createPermissionRule('Bash(echo "hello (world)")'));
        expect(result.tool).toBe('Bash');
        expect(result.pattern).toBe('echo "hello (world)"');
      });

      it('should handle path patterns', () => {
        const result = parseCCPermissionRule(createPermissionRule('Read(/Users/test/vault/notes)'));
        expect(result.tool).toBe('Read');
        expect(result.pattern).toBe('/Users/test/vault/notes');
      });

      it('should return rule as tool for malformed input', () => {
        const result = parseCCPermissionRule(createPermissionRule('not-valid-format'));
        expect(result.tool).toBe('not-valid-format');
        expect(result.pattern).toBeUndefined();
      });
    });
  });

  describe('1M Model Utilities', () => {
    describe('resolveModelWithBetas', () => {
      it('should return model with betas when include1MBeta is true', () => {
        const result = resolveModelWithBetas('sonnet', true);
        expect(result.model).toBe('sonnet');
        expect(result.betas).toBeDefined();
        expect(result.betas).toContain(BETA_1M_CONTEXT);
      });

      it('should return model without betas when include1MBeta is false', () => {
        const result = resolveModelWithBetas('sonnet', false);
        expect(result.model).toBe('sonnet');
        expect(result.betas).toBeUndefined();
      });

      it('should return model without betas by default', () => {
        const result = resolveModelWithBetas('sonnet');
        expect(result.model).toBe('sonnet');
        expect(result.betas).toBeUndefined();
      });

      it('should preserve model name', () => {
        expect(resolveModelWithBetas('claude-sonnet-4-5', true).model).toBe('claude-sonnet-4-5');
        expect(resolveModelWithBetas('claude-opus-4-5', false).model).toBe('claude-opus-4-5');
      });

      it('should return single beta flag in array', () => {
        const result = resolveModelWithBetas('sonnet', true);
        expect(result.betas).toHaveLength(1);
      });

      it('should throw when model is empty string', () => {
        expect(() => resolveModelWithBetas('')).toThrow('model is required');
        expect(() => resolveModelWithBetas('', true)).toThrow('model is required');
      });

      it('should throw when model is not provided correctly', () => {
        // @ts-expect-error - testing runtime validation
        expect(() => resolveModelWithBetas(null)).toThrow('model is required');
        // @ts-expect-error - testing runtime validation
        expect(() => resolveModelWithBetas(undefined)).toThrow('model is required');
      });
    });

    describe('BETA_1M_CONTEXT', () => {
      it('should be defined as the correct beta flag', () => {
        expect(BETA_1M_CONTEXT).toBe('context-1m-2025-08-07');
      });
    });

    describe('getContextWindowSize', () => {
      it('should return standard context window by default', () => {
        expect(getContextWindowSize('sonnet')).toBe(CONTEXT_WINDOW_STANDARD);
        expect(getContextWindowSize('opus')).toBe(CONTEXT_WINDOW_STANDARD);
        expect(getContextWindowSize('haiku')).toBe(CONTEXT_WINDOW_STANDARD);
      });

      it('should return 1M context window for sonnet when enabled', () => {
        expect(getContextWindowSize('sonnet', true)).toBe(CONTEXT_WINDOW_1M);
        expect(getContextWindowSize('claude-sonnet-4-5', true)).toBe(CONTEXT_WINDOW_1M);
      });

      it('should return standard context for non-sonnet models even with 1M enabled', () => {
        expect(getContextWindowSize('opus', true)).toBe(CONTEXT_WINDOW_STANDARD);
        expect(getContextWindowSize('haiku', true)).toBe(CONTEXT_WINDOW_STANDARD);
      });

      it('should use custom limits when provided', () => {
        const customLimits = { 'custom-model': 256000 };
        expect(getContextWindowSize('custom-model', false, customLimits)).toBe(256000);
      });

      it('should prioritize custom limits over 1M setting', () => {
        const customLimits = { 'custom-sonnet': 500000 };
        expect(getContextWindowSize('custom-sonnet', true, customLimits)).toBe(500000);
      });

      it('should fall back to default when model not in custom limits', () => {
        const customLimits = { 'other-model': 256000 };
        expect(getContextWindowSize('sonnet', false, customLimits)).toBe(CONTEXT_WINDOW_STANDARD);
      });

      it('should handle empty custom limits object', () => {
        expect(getContextWindowSize('sonnet', false, {})).toBe(CONTEXT_WINDOW_STANDARD);
      });

      it('should handle undefined custom limits', () => {
        expect(getContextWindowSize('sonnet', false, undefined)).toBe(CONTEXT_WINDOW_STANDARD);
      });

      describe('defensive validation for invalid custom limit values', () => {
        it('should fall back to default for NaN custom limit', () => {
          const customLimits = { 'custom-model': NaN };
          expect(getContextWindowSize('custom-model', false, customLimits)).toBe(CONTEXT_WINDOW_STANDARD);
        });

        it('should fall back to default for negative custom limit', () => {
          const customLimits = { 'custom-model': -100000 };
          expect(getContextWindowSize('custom-model', false, customLimits)).toBe(CONTEXT_WINDOW_STANDARD);
        });

        it('should fall back to default for zero custom limit', () => {
          const customLimits = { 'custom-model': 0 };
          expect(getContextWindowSize('custom-model', false, customLimits)).toBe(CONTEXT_WINDOW_STANDARD);
        });

        it('should fall back to default for Infinity custom limit', () => {
          const customLimits = { 'custom-model': Infinity };
          expect(getContextWindowSize('custom-model', false, customLimits)).toBe(CONTEXT_WINDOW_STANDARD);
        });

        it('should fall back to default for -Infinity custom limit', () => {
          const customLimits = { 'custom-model': -Infinity };
          expect(getContextWindowSize('custom-model', false, customLimits)).toBe(CONTEXT_WINDOW_STANDARD);
        });

        it('should fall back to 1M for invalid sonnet custom limit when 1M enabled', () => {
          const customLimits = { 'sonnet': NaN };
          expect(getContextWindowSize('sonnet', true, customLimits)).toBe(CONTEXT_WINDOW_1M);
        });

        it('should accept valid positive custom limit', () => {
          const customLimits = { 'custom-model': 256000 };
          expect(getContextWindowSize('custom-model', false, customLimits)).toBe(256000);
        });
      });
    });
  });
});
