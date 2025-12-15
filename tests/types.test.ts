import {
  VIEW_TYPE_CLAUDIAN,
  DEFAULT_SETTINGS,
  ClaudianSettings,
  ChatMessage,
  ToolCallInfo,
  StreamChunk,
  Conversation,
  ConversationMeta,
  EnvSnippet,
} from '../src/types';

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

    it('should have showToolUse set to true by default', () => {
      expect(DEFAULT_SETTINGS.showToolUse).toBe(true);
    });

    it('should have default blocked commands', () => {
      expect(DEFAULT_SETTINGS.blockedCommands).toBeInstanceOf(Array);
      expect(DEFAULT_SETTINGS.blockedCommands.length).toBeGreaterThan(0);
    });

    it('should block rm -rf by default', () => {
      expect(DEFAULT_SETTINGS.blockedCommands).toContain('rm -rf');
    });

    it('should block chmod 777 by default', () => {
      expect(DEFAULT_SETTINGS.blockedCommands).toContain('chmod 777');
    });

    it('should block chmod -R 777 by default', () => {
      expect(DEFAULT_SETTINGS.blockedCommands).toContain('chmod -R 777');
    });

    it('should only contain non-empty default blocked commands', () => {
      expect(DEFAULT_SETTINGS.blockedCommands.every((cmd) => cmd.trim().length > 0)).toBe(true);
      expect(new Set(DEFAULT_SETTINGS.blockedCommands).size).toBe(DEFAULT_SETTINGS.blockedCommands.length);
    });

    it('should have environmentVariables as empty string by default', () => {
      expect(DEFAULT_SETTINGS.environmentVariables).toBe('');
    });

    it('should have envSnippets as empty array by default', () => {
      expect(DEFAULT_SETTINGS.envSnippets).toEqual([]);
    });

    it('should have lastClaudeModel set to claude-haiku-4-5 by default', () => {
      expect(DEFAULT_SETTINGS.lastClaudeModel).toBe('claude-haiku-4-5');
    });

    it('should have lastCustomModel as empty string by default', () => {
      expect(DEFAULT_SETTINGS.lastCustomModel).toBe('');
    });

    it('should have toolCallExpandedByDefault set to false by default', () => {
      expect(DEFAULT_SETTINGS.toolCallExpandedByDefault).toBe(false);
    });
  });

  describe('ClaudianSettings type', () => {
    it('should be assignable with valid settings', () => {
      const settings: ClaudianSettings = {
        enableBlocklist: false,
        blockedCommands: ['test'],
        showToolUse: false,
        toolCallExpandedByDefault: true,
        model: 'claude-haiku-4-5',
        thinkingBudget: 'off',
        permissionMode: 'yolo',
        approvedActions: [],
        excludedTags: [],
        mediaFolder: '',
        environmentVariables: '',
        envSnippets: [],
        systemPrompt: '',
        allowedExportPaths: [],
        slashCommands: [],
      };

      expect(settings.enableBlocklist).toBe(false);
      expect(settings.blockedCommands).toEqual(['test']);
      expect(settings.showToolUse).toBe(false);
      expect(settings.model).toBe('claude-haiku-4-5');
    });

    it('should accept custom model strings', () => {
      const settings: ClaudianSettings = {
        enableBlocklist: true,
        blockedCommands: [],
        showToolUse: true,
        toolCallExpandedByDefault: true,
        model: 'anthropic/custom-model-v1',
        thinkingBudget: 'medium',
        permissionMode: 'normal',
        approvedActions: [],
        excludedTags: ['private'],
        mediaFolder: 'attachments',
        environmentVariables: 'API_KEY=test',
        envSnippets: [],
        systemPrompt: '',
        allowedExportPaths: [],
        slashCommands: [],
      };

      expect(settings.model).toBe('anthropic/custom-model-v1');
    });

    it('should accept optional lastClaudeModel and lastCustomModel', () => {
      const settings: ClaudianSettings = {
        enableBlocklist: true,
        blockedCommands: [],
        showToolUse: true,
        toolCallExpandedByDefault: false,
        model: 'claude-sonnet-4-5',
        lastClaudeModel: 'claude-opus-4-5',
        lastCustomModel: 'custom/model',
        thinkingBudget: 'high',
        permissionMode: 'yolo',
        approvedActions: [],
        excludedTags: [],
        mediaFolder: '',
        environmentVariables: '',
        envSnippets: [],
        systemPrompt: '',
        allowedExportPaths: [],
        slashCommands: [],
      };

      expect(settings.lastClaudeModel).toBe('claude-opus-4-5');
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
      if (chunk.type === 'text') {
        expect(chunk.content).toBe('Hello world');
      }
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
        expect(chunk.id).toBe('tool-123');
        expect(chunk.name).toBe('Read');
        expect(chunk.input).toEqual({ file_path: '/test.txt' });
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
        expect(chunk.id).toBe('tool-123');
        expect(chunk.content).toBe('File contents here');
      }
    });

    it('should accept error type', () => {
      const chunk: StreamChunk = {
        type: 'error',
        content: 'Something went wrong',
      };

      expect(chunk.type).toBe('error');
      if (chunk.type === 'error') {
        expect(chunk.content).toBe('Something went wrong');
      }
    });

    it('should accept blocked type', () => {
      const chunk: StreamChunk = {
        type: 'blocked',
        content: 'Command blocked: rm -rf',
      };

      expect(chunk.type).toBe('blocked');
      if (chunk.type === 'blocked') {
        expect(chunk.content).toBe('Command blocked: rm -rf');
      }
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
});
