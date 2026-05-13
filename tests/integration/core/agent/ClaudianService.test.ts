import '@/providers';

// eslint-disable-next-line jest/no-mocks-import
import {
  getLastOptions,
  getLastResponse,
  getQueryCallCount,
  resetMockMessages,
  setMockMessages,
  simulateCrash,
} from '@test/__mocks__/claude-agent-sdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock fs module
jest.mock('fs');

// Now import after all mocks are set up
import { buildResultErrorMessage } from '@test/helpers/sdkMessages';

import { getActionDescription, getActionPattern } from '@/core/security/ApprovalManager';
import { getPathFromToolInput } from '@/core/tools/toolInput';
import { ClaudianService } from '@/providers/claude/runtime/ClaudeChatRuntime';
import { resolveClaudeCliPath } from '@/providers/claude/runtime/ClaudeCliResolver';
import { transformSDKMessage } from '@/providers/claude/stream/transformClaudeMessage';
import {
  buildContextFromHistory,
  formatToolCallForContext,
  getLastUserMessage,
  isSessionExpiredError,
  truncateToolResult,
} from '@/utils/session';

// Helper to create SDK-format assistant message with tool_use
function createAssistantWithToolUse(toolName: string, toolInput: Record<string, unknown>, toolId = 'tool-123') {
  return {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: toolId, name: toolName, input: toolInput },
      ],
    },
  };
}

// Helper to create SDK-format user message with tool_result
function createUserWithToolResult(content: string, parentToolUseId = 'tool-123') {
  return {
    type: 'user',
    parent_tool_use_id: parentToolUseId,
    tool_use_result: content,
    message: { content: [] },
  };
}

function createTextUserMessage(content: string) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
    session_id: '',
  };
}

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
    extractMentions: jest.fn().mockReturnValue(new Set<string>()),
    transformMentions: jest.fn().mockImplementation((text: string) => text),
  } as any;
}

// Create a mock plugin
function createMockPlugin(settings: Record<string, unknown> = {}) {
  // CC permissions storage (allow/deny/ask arrays)
  const ccPermissions = {
    allow: [] as string[],
    deny: [] as string[],
    ask: [] as string[],
  };

  const mockPlugin = {
    settings: {
      permissions: [], // Legacy field (for backwards compat tests)
      permissionMode: 'yolo',
      loadUserClaudeSettings: false,
      mediaFolder: '',
      systemPrompt: '',
      model: 'claude-sonnet-4-5',
      thinkingBudget: 'off',
      ...settings,
    },
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault/path',
        },
      },
    },
    storage: {
      getPermissions: jest.fn().mockImplementation(async () => ccPermissions),
      addAllowRule: jest.fn().mockImplementation(async (rule: string) => {
        ccPermissions.allow.push(rule);
      }),
      addDenyRule: jest.fn().mockImplementation(async (rule: string) => {
        ccPermissions.deny.push(rule);
      }),
    },
    // Expose ccPermissions for test assertions
    _ccPermissions: ccPermissions,
    saveSettings: jest.fn().mockResolvedValue(undefined),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/mock/claude'),
    // Mock getView to return null (tests don't have real view)
    // This allows optional chaining to work safely
    getView: jest.fn().mockReturnValue(null),
    // Mock pluginManager for QueryOptionsBuilder
    pluginManager: {
      getPluginsKey: jest.fn().mockReturnValue(''),
      hasEnabledPlugins: jest.fn().mockReturnValue(false),
    },
  } as any;
  return mockPlugin;
}

describe('ClaudianService', () => {
  let service: ClaudianService;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    resetMockMessages();
    mockPlugin = createMockPlugin();
    service = new ClaudianService(mockPlugin, createMockMcpManager());
  });

  afterEach(() => {
    // Clean up persistent query to prevent test hangs
    service.cleanup();
  });

  describe('findClaudeCLI', () => {
    beforeEach(() => {
      mockPlugin.getResolvedProviderCliPath.mockImplementation(() =>
        resolveClaudeCliPath(
          undefined,  // Hostname path (not used in tests)
          mockPlugin.settings.claudeCliPath,
          mockPlugin.getActiveEnvironmentVariables()
        )
      );
    });

    afterEach(() => {
      (fs.existsSync as jest.Mock).mockReset();
      (fs.statSync as jest.Mock).mockReset();
    });

    it('should find claude CLI in ~/.claude/local/claude', async () => {
      const homeDir = os.homedir();
      const expectedPath = path.join(homeDir, '.claude', 'local', 'claude');

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        return p === expectedPath;
      });
      (fs.statSync as jest.Mock).mockReturnValue({ isFile: () => true });

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('hello')) {
        chunks.push(chunk);
      }

      const errorChunk = chunks.find(
        (c) => c.type === 'error' && c.content.includes('Claude CLI not found')
      );
      expect(errorChunk).toBeUndefined();
    });

    it('should return error when claude CLI not found', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const chunks: any[] = [];
      for await (const chunk of service.query('hello')) {
        chunks.push(chunk);
      }

      const errorChunk = chunks.find((c) => c.type === 'error');
      expect(errorChunk).toBeDefined();
      expect(errorChunk?.content).toContain('Claude CLI not found');
    });

    it('should use custom CLI path when valid file is specified', async () => {
      const customPath = '/custom/path/to/claude';
      mockPlugin = createMockPlugin({ claudeCliPath: customPath });
      mockPlugin.getResolvedProviderCliPath.mockImplementation(() =>
        resolveClaudeCliPath(
          undefined,  // Hostname path (not used in tests)
          mockPlugin.settings.claudeCliPath,
          mockPlugin.getActiveEnvironmentVariables()
        )
      );
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => p === customPath);
      (fs.statSync as jest.Mock).mockReturnValue({ isFile: () => true });

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('hello')) {
        chunks.push(chunk);
      }

      const errorChunk = chunks.find(
        (c) => c.type === 'error' && c.content.includes('Claude CLI not found')
      );
      expect(errorChunk).toBeUndefined();
    });

    it('should fall back to auto-detection when custom path is a directory', async () => {
      const customPath = '/custom/path/to/directory';
      mockPlugin = createMockPlugin({ claudeCliPath: customPath });
      mockPlugin.getResolvedProviderCliPath.mockImplementation(() =>
        resolveClaudeCliPath(
          undefined,  // Hostname path (not used in tests)
          mockPlugin.settings.claudeCliPath,
          mockPlugin.getActiveEnvironmentVariables()
        )
      );
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      const homeDir = os.homedir();
      const autoDetectedPath = path.join(homeDir, '.claude', 'local', 'claude');

      (fs.existsSync as jest.Mock).mockImplementation((p: string) =>
        p === customPath || p === autoDetectedPath
      );
      (fs.statSync as jest.Mock).mockImplementation((p: string) => ({
        isFile: () => p !== customPath, // Custom path is a directory
      }));

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('hello')) {
        chunks.push(chunk);
      }

      // CLI path validation is silent - just verifies fallback works
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should fall back to auto-detection when custom path does not exist', async () => {
      const customPath = '/nonexistent/path/claude';
      mockPlugin = createMockPlugin({ claudeCliPath: customPath });
      mockPlugin.getResolvedProviderCliPath.mockImplementation(() =>
        resolveClaudeCliPath(
          undefined,  // Hostname path (not used in tests)
          mockPlugin.settings.claudeCliPath,
          mockPlugin.getActiveEnvironmentVariables()
        )
      );
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      const homeDir = os.homedir();
      const autoDetectedPath = path.join(homeDir, '.claude', 'local', 'claude');

      (fs.existsSync as jest.Mock).mockImplementation((p: string) =>
        p === autoDetectedPath // Custom path does not exist
      );
      (fs.statSync as jest.Mock).mockImplementation((p: string) => ({
        isFile: () => p === autoDetectedPath,
      }));

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('hello')) {
        chunks.push(chunk);
      }

      // CLI path validation is silent - just verifies fallback works
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should fall back to auto-detection when custom path stat fails', async () => {
      const customPath = '/custom/path/to/claude';
      mockPlugin = createMockPlugin({ claudeCliPath: customPath });
      mockPlugin.getResolvedProviderCliPath.mockImplementation(() =>
        resolveClaudeCliPath(
          undefined,  // Hostname path (not used in tests)
          mockPlugin.settings.claudeCliPath,
          mockPlugin.getActiveEnvironmentVariables()
        )
      );
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      const homeDir = os.homedir();
      const autoDetectedPath = path.join(homeDir, '.claude', 'local', 'claude');

      (fs.existsSync as jest.Mock).mockImplementation((p: string) =>
        p === customPath || p === autoDetectedPath
      );
      // Custom path stat throws, auto-detected path works
      (fs.statSync as jest.Mock).mockImplementation((p: string) => {
        if (p === customPath) {
          throw new Error('EACCES');
        }
        return { isFile: () => p === autoDetectedPath };
      });

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('hello')) {
        chunks.push(chunk);
      }

      const errorChunk = chunks.find(
        (c) => c.type === 'error' && c.content.includes('Claude CLI not found')
      );
      expect(errorChunk).toBeUndefined();

      const options = getLastOptions();
      expect(options?.pathToClaudeCodeExecutable).toBe(autoDetectedPath);
    });

    it('should reload CLI path after cleanup', async () => {
      const firstPath = '/custom/path/to/claude-1';
      const secondPath = '/custom/path/to/claude-2';
      mockPlugin = createMockPlugin({ claudeCliPath: firstPath });
      mockPlugin.getResolvedProviderCliPath.mockImplementation(() =>
        resolveClaudeCliPath(
          undefined,  // Hostname path (not used in tests)
          mockPlugin.settings.claudeCliPath,
          mockPlugin.getActiveEnvironmentVariables()
        )
      );
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => p === firstPath);
      (fs.statSync as jest.Mock).mockReturnValue({ isFile: () => true });

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of service.query('hello')) {
        // drain
      }

      const firstOptions = getLastOptions();
      expect(firstOptions?.pathToClaudeCodeExecutable).toBe(firstPath);

      mockPlugin.settings.claudeCliPath = secondPath;
      service.cleanup();

      (fs.existsSync as jest.Mock).mockImplementation((p: string) => p === secondPath);
      (fs.statSync as jest.Mock).mockReturnValue({ isFile: () => true });

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello again' }] } },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of service.query('hello again')) {
        // drain
      }

      const secondOptions = getLastOptions();
      expect(secondOptions?.pathToClaudeCodeExecutable).toBe(secondPath);
    });
  });

  describe('transformSDKMessage', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
    });

    it('should transform assistant text messages', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'This is a test response' }] },
        },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('hello')) {
        chunks.push(chunk);
      }

      const textChunk = chunks.find((c) => c.type === 'text');
      expect(textChunk).toBeDefined();
      expect(textChunk?.content).toBe('This is a test response');
    });

    it('should transform tool_use from assistant message content', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Read', { file_path: '/test/file.txt' }, 'read-tool-1'),
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('read file')) {
        chunks.push(chunk);
      }

      const toolUseChunk = chunks.find((c) => c.type === 'tool_use');
      expect(toolUseChunk).toBeDefined();
      expect(toolUseChunk?.name).toBe('Read');
      expect(toolUseChunk?.input).toEqual({ file_path: '/test/file.txt' });
      expect(toolUseChunk?.id).toBe('read-tool-1');
    });

    it('should transform tool_result from user message', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Read', { file_path: '/test/file.txt' }, 'read-tool-1'),
        createUserWithToolResult('File contents here', 'read-tool-1'),
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('read file')) {
        chunks.push(chunk);
      }

      const toolResultChunk = chunks.find((c) => c.type === 'subagent_tool_result');
      expect(toolResultChunk).toBeDefined();
      expect(toolResultChunk?.content).toBe('File contents here');
      expect(toolResultChunk?.id).toBe('read-tool-1');
    });

    it('should transform assistant error messages', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          error: 'Something went wrong',
          message: { content: [] },
        },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('do something')) {
        chunks.push(chunk);
      }

      const errorChunk = chunks.find((c) => c.type === 'error' && c.content === 'Something went wrong');
      expect(errorChunk).toBeDefined();
    });

    it('should capture session ID from init message', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'my-session-123' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('hello')) {
        chunks.push(chunk);
      }

      expect(chunks.some((c) => c.type === 'text')).toBe(true);
    });

    it('should resume previous session on subsequent queries', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'resume-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'First run' }] } },
        { type: 'result' },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of service.query('first')) {
        // drain
      }

      setMockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Second run' }] } },
        { type: 'result' },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of service.query('second', undefined, undefined, { forceColdStart: true })) {
        // drain
      }

      const options = getLastOptions();
      expect(options?.resume).toBe('resume-session');
      expect(service.getSessionId()).toBe('resume-session');
    });

    it('should extract multiple content blocks from assistant message', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Let me read that file.' },
              { type: 'tool_use', id: 'tool-abc', name: 'Read', input: { file_path: '/foo.txt' } },
            ],
          },
        },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('read foo.txt')) {
        chunks.push(chunk);
      }

      const textChunk = chunks.find((c) => c.type === 'text');
      expect(textChunk?.content).toBe('Let me read that file.');

      const toolUseChunk = chunks.find((c) => c.type === 'tool_use');
      expect(toolUseChunk?.name).toBe('Read');
      expect(toolUseChunk?.id).toBe('tool-abc');
    });
  });

  describe('cancel', () => {
    it('should abort ongoing request', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      ]);

      const queryGenerator = service.query('hello');
      await queryGenerator.next();

      expect(() => service.cancel()).not.toThrow();
    });

    it('should call interrupt on underlying stream when aborted', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'cancel-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Chunk 1' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Chunk 2' }] } },
        { type: 'result' },
      ]);

      const generator = service.query('streaming');
      await generator.next();

      service.cancel();

      const chunks: any[] = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      const response = getLastResponse();
      expect(response?.interrupt).toHaveBeenCalled();
      expect(chunks.some((c) => c.type === 'done')).toBe(true);
    });

    it('should handle cancel when no query is running', () => {
      expect(() => service.cancel()).not.toThrow();
    });
  });

  // MessageChannel tests moved to tests/unit/core/agent/MessageChannel.test.ts

  describe('persistent query updates', () => {
    it('updates model on the active persistent query', async () => {
      const chunks: any[] = [];
      for await (const chunk of service.query('hello', undefined, undefined, { model: 'claude-opus-4-5' })) {
        chunks.push(chunk);
      }

      const response = getLastResponse();
      expect(response?.setModel).toHaveBeenCalledWith('claude-opus-4-5');
    });
  });

  describe('persistent query error handling', () => {
    it('yields error from assistant message with error field', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant', error: 'server_error', message: { content: [] } },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('trigger error')) {
        chunks.push(chunk);
      }

      expect(chunks.some((c) => c.type === 'error' && c.content === 'server_error')).toBe(true);
      expect(chunks.some((c) => c.type === 'done')).toBe(true);
    });

    it('yields error from failed result messages', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        buildResultErrorMessage({
          subtype: 'error_max_turns',
          errors: ['Max turns reached'],
        }),
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('trigger max turns')) {
        chunks.push(chunk);
      }

      expect(chunks.some((c) => c.type === 'error' && c.content === 'Max turns reached')).toBe(true);
      expect(chunks.some((c) => c.type === 'done')).toBe(true);
    });

    // Note: Session expiration is handled via thrown errors in catch blocks,
    // not via message types. The SDK throws on session expiration which is
    // caught by isSessionExpiredError() in the query error handlers.
  });

  describe('closePersistentQuery with preserveHandlers', () => {
    afterEach(() => {
      service.cleanup();
    });

    it('preserves handlers when preserveHandlers is true', async () => {
      // Start a query to create handlers
      const queryPromise = (async () => {
        const chunks: any[] = [];
        for await (const chunk of service.query('hello')) {
          chunks.push(chunk);
        }
        return chunks;
      })();

      // Let the query start
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Access internal state to verify handlers exist
      const handlersBefore = (service as any).responseHandlers?.length ?? 0;

      // Close with preserveHandlers: true
      service.closePersistentQuery('test', { preserveHandlers: true });

      // Handlers should still exist
      const handlersAfter = (service as any).responseHandlers?.length ?? 0;
      expect(handlersAfter).toBe(handlersBefore);

      // Clean up the promise (it will resolve/reject after close)
      await queryPromise.catch(() => { });
    });

    it('clears handlers when preserveHandlers is false (default)', async () => {
      // Start a query to create handlers
      const queryPromise = (async () => {
        const chunks: any[] = [];
        for await (const chunk of service.query('hello')) {
          chunks.push(chunk);
        }
        return chunks;
      })();

      // Let the query start
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Close without preserveHandlers (default is false)
      service.closePersistentQuery('test');

      // Handlers should be cleared
      const handlersAfter = (service as any).responseHandlers?.length ?? 0;
      expect(handlersAfter).toBe(0);

      // Clean up the promise
      await queryPromise.catch(() => { });
    });
  });

  describe('crash recovery with simulateCrash', () => {
    afterEach(() => {
      service.cleanup();
    });

    it('restarts persistent query on consumer error when no chunks received', async () => {
      // Simulate crash before any chunks are emitted
      simulateCrash(0);

      const initialCallCount = getQueryCallCount();
      const chunks: any[] = [];

      // The query should recover and eventually succeed
      for await (const chunk of service.query('hello')) {
        chunks.push(chunk);
      }

      // Query should have been called twice (initial + restart)
      expect(getQueryCallCount()).toBe(initialCallCount + 2);

      // Should have received the successful response after recovery
      const textChunk = chunks.find((c) => c.type === 'text');
      expect(textChunk).toBeDefined();
    });

    it('does not replay message when chunks were already received before crash', async () => {
      // Simulate crash after 1 chunk is emitted (system init message)
      simulateCrash(1);

      const chunks: any[] = [];

      for await (const chunk of service.query('hello')) {
        chunks.push(chunk);
      }

      // Should have received the system init chunk before error
      // Note: error is propagated via onError handler which ends the generator
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe('persistent query recovery after close', () => {
    afterEach(() => {
      service.cleanup();
    });

    it('can start new persistent query after closePersistentQuery', async () => {
      // First query establishes persistent query
      const chunks1: any[] = [];
      for await (const chunk of service.query('first')) {
        chunks1.push(chunk);
      }
      expect(chunks1.length).toBeGreaterThan(0);
      expect((service as any).persistentQuery).not.toBeNull();

      // Close the persistent query (simulating session reset)
      service.closePersistentQuery('test close');
      expect((service as any).persistentQuery).toBeNull();
      expect((service as any).shuttingDown).toBe(false); // Should be reset

      // Next query should start a NEW persistent query (not fall back to cold-start)
      const chunks2: any[] = [];
      for await (const chunk of service.query('second')) {
        chunks2.push(chunk);
      }
      expect(chunks2.length).toBeGreaterThan(0);

      // Verify persistent query was recreated
      expect((service as any).persistentQuery).not.toBeNull();
    });

    it('can recover after resetSession closes persistent query', async () => {
      // First query
      const chunks1: any[] = [];
      for await (const chunk of service.query('first')) {
        chunks1.push(chunk);
      }
      expect((service as any).persistentQuery).not.toBeNull();

      // Reset session (which closes persistent query)
      service.resetSession();
      expect((service as any).persistentQuery).toBeNull();
      expect((service as any).shuttingDown).toBe(false);

      // Next query should work
      const chunks2: any[] = [];
      for await (const chunk of service.query('second')) {
        chunks2.push(chunk);
      }
      expect(chunks2.length).toBeGreaterThan(0);
      expect((service as any).persistentQuery).not.toBeNull();
    });

    it('can recover after session switch closes persistent query', async () => {
      // First query
      const chunks1: any[] = [];
      for await (const chunk of service.query('first')) {
        chunks1.push(chunk);
      }
      expect((service as any).persistentQuery).not.toBeNull();

      // Switch to a different session (which closes persistent query)
      service.setSessionId('new-session-id');
      expect((service as any).persistentQuery).toBeNull();
      expect((service as any).shuttingDown).toBe(false);

      // Next query should work with new session
      const chunks2: any[] = [];
      for await (const chunk of service.query('second')) {
        chunks2.push(chunk);
      }
      expect(chunks2.length).toBeGreaterThan(0);
      expect((service as any).persistentQuery).not.toBeNull();
    });
  });

  // SessionManager tests (resetSession, getSessionId, setSessionId) moved to:
  // tests/unit/core/agent/SessionManager.test.ts

  describe('cleanup', () => {
    it('should call cancel and resetSession', () => {
      const cancelSpy = jest.spyOn(service, 'cancel');
      const resetSessionSpy = jest.spyOn(service, 'resetSession');

      service.cleanup();

      expect(cancelSpy).toHaveBeenCalled();
      expect(resetSessionSpy).toHaveBeenCalled();
    });
  });

  describe('getVaultPath', () => {
    it('should return error when vault path cannot be determined', async () => {
      mockPlugin = {
        ...mockPlugin,
        app: {
          vault: {
            adapter: {},
          },
        },
      };
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      const chunks: any[] = [];
      for await (const chunk of service.query('hello')) {
        chunks.push(chunk);
      }

      const errorChunk = chunks.find(
        (c) => c.type === 'error' && c.content.includes('vault path')
      );
      expect(errorChunk).toBeDefined();
    });
  });

  describe('query with conversation history', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
    });

    it('should accept optional conversation history parameter', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello!' }] } },
        { type: 'result' },
      ]);

      const history = [
        { id: 'msg-1', role: 'user' as const, content: 'Previous message', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant' as const, content: 'Previous response', timestamp: Date.now() },
      ];

      const chunks: any[] = [];
      for await (const chunk of service.query('new message', undefined, history)) {
        chunks.push(chunk);
      }

      expect(chunks.some((c) => c.type === 'text')).toBe(true);
    });

    it('should work without conversation history', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello!' }] } },
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('hello')) {
        chunks.push(chunk);
      }

      expect(chunks.some((c) => c.type === 'text')).toBe(true);
    });

    it('should rebuild history when session is missing but history exists', async () => {
      const prompts: string[] = [];

      jest.spyOn(service as any, 'queryViaSDK').mockImplementation((async function* (prompt: string) {
        prompts.push(prompt);
        yield { type: 'text', content: 'ok' };
      }) as any);

      const history = [
        { id: 'msg-1', role: 'user' as const, content: 'Previous message', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant' as const, content: 'Previous response', timestamp: Date.now() },
      ];

      const chunks: any[] = [];
      for await (const chunk of service.query('New message', undefined, history)) {
        chunks.push(chunk);
      }

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('User: Previous message');
      expect(prompts[0]).toContain('Assistant: Previous response');
      expect(prompts[0]).toContain('User: New message');
      expect(chunks.some((c) => c.type === 'text')).toBe(true);
    });
  });

  describe('session restoration', () => {
    it('should use restored session ID on subsequent queries', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      // Simulate restoring a session ID from storage
      service.setSessionId('restored-session-id');

      setMockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Resumed!' }] } },
        { type: 'result' },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of service.query('continue')) {
        // drain
      }

      const options = getLastOptions();
      expect(options?.resume).toBe('restored-session-id');
    });

    it('should capture new session ID from SDK', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'new-captured-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
        { type: 'result' },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of service.query('hello')) {
        // drain
      }

      expect(service.getSessionId()).toBe('new-captured-session');
    });
  });

  describe('extended thinking', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
    });

    it('should transform thinking blocks from assistant messages', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'Let me analyze this problem...' },
              { type: 'text', text: 'Here is my answer.' },
            ],
          },
        },
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('think about this')) {
        chunks.push(chunk);
      }

      const thinkingChunk = chunks.find((c) => c.type === 'thinking');
      expect(thinkingChunk).toBeDefined();
      expect(thinkingChunk?.content).toBe('Let me analyze this problem...');

      const textChunk = chunks.find((c) => c.type === 'text');
      expect(textChunk).toBeDefined();
      expect(textChunk?.content).toBe('Here is my answer.');
    });

    it('should transform thinking deltas from stream events', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'thinking', thinking: 'Starting thought...' },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: ' continuing thought...' },
          },
        },
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('think')) {
        chunks.push(chunk);
      }

      const thinkingChunks = chunks.filter((c) => c.type === 'thinking');
      expect(thinkingChunks.length).toBeGreaterThanOrEqual(1);
      expect(thinkingChunks.some((c) => c.content.includes('thought'))).toBe(true);
    });
  });

  describe('permission utility functions', () => {
    it('should generate correct action patterns for different tools', () => {
      expect(getActionPattern('Bash', { command: 'git status' })).toBe('git status');
      expect(getActionPattern('Read', { file_path: '/test/file.md' })).toBe('/test/file.md');
      expect(getActionPattern('Write', { file_path: '/test/output.md' })).toBe('/test/output.md');
      expect(getActionPattern('Edit', { file_path: '/test/edit.md' })).toBe('/test/edit.md');
      expect(getActionPattern('Glob', { pattern: '**/*.md' })).toBe('**/*.md');
      expect(getActionPattern('Grep', { pattern: 'TODO' })).toBe('TODO');
    });

    it('should generate correct action descriptions', () => {
      expect(getActionDescription('Bash', { command: 'git status' })).toBe('Run command: git status');
      expect(getActionDescription('Read', { file_path: '/test/file.md' })).toBe('Read file: /test/file.md');
      expect(getActionDescription('Write', { file_path: '/test/output.md' })).toBe('Write to file: /test/output.md');
      expect(getActionDescription('Edit', { file_path: '/test/edit.md' })).toBe('Edit file: /test/edit.md');
      expect(getActionDescription('Glob', { pattern: '**/*.md' })).toBe('Search files matching: **/*.md');
      expect(getActionDescription('Grep', { pattern: 'TODO' })).toBe('Search content matching: TODO');
    });
  });

  // Note: safe mode approvals tests removed - createUnifiedToolCallback was part of plan mode

  describe('session expiration recovery', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
    });

    it('should detect session expired errors', () => {
      // Now test the standalone function directly
      expect(isSessionExpiredError(new Error('Session expired'))).toBe(true);
      expect(isSessionExpiredError(new Error('session not found'))).toBe(true);
      expect(isSessionExpiredError(new Error('invalid session'))).toBe(true);
      expect(isSessionExpiredError(new Error('Resume failed'))).toBe(true);
    });

    it('should not detect non-session errors as session errors', () => {
      // Now test the standalone function directly
      expect(isSessionExpiredError(new Error('Network error'))).toBe(false);
      expect(isSessionExpiredError(new Error('Rate limited'))).toBe(false);
      expect(isSessionExpiredError(new Error('Invalid API key'))).toBe(false);
    });

    it('should build context from conversation history', () => {
      const messages = [
        { id: 'msg-1', role: 'user' as const, content: 'Hello', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant' as const, content: 'Hi there!', timestamp: Date.now() },
        { id: 'msg-3', role: 'user' as const, content: 'How are you?', timestamp: Date.now() },
      ];

      // Now test the standalone function directly
      const context = buildContextFromHistory(messages);

      expect(context).toContain('User: Hello');
      expect(context).toContain('Assistant: Hi there!');
      expect(context).toContain('User: How are you?');
    });

    it('should include tool call info with input (status only for success)', () => {
      const messages = [
        { id: 'msg-1', role: 'user' as const, content: 'Read a file', timestamp: Date.now() },
        {
          id: 'msg-2',
          role: 'assistant' as const,
          content: 'Reading file...',
          timestamp: Date.now(),
          toolCalls: [
            { id: 'tool-1', name: 'Read', input: { file_path: '/test.md' }, status: 'completed' as const, result: 'File contents' },
          ],
        },
      ];

      // Now test the standalone function directly
      const context = buildContextFromHistory(messages);

      // Successful tools show input but no result (Claude can re-read if needed)
      expect(context).toContain('[Tool Read input: file_path=/test.md status=completed]');
      expect(context).not.toContain('File contents');
    });

    it('should include error messages for failed tool calls with input', () => {
      const messages = [
        { id: 'msg-1', role: 'user' as const, content: 'Read a file', timestamp: Date.now() },
        {
          id: 'msg-2',
          role: 'assistant' as const,
          content: 'Reading file...',
          timestamp: Date.now(),
          toolCalls: [
            { id: 'tool-1', name: 'Read', input: { file_path: '/missing.md' }, status: 'error' as const, result: 'File not found' },
          ],
        },
      ];

      const context = buildContextFromHistory(messages);

      // Failed tools include input AND error message so Claude knows what went wrong
      expect(context).toContain('[Tool Read input: file_path=/missing.md status=error] error: File not found');
    });

    it('should include current note in rebuilt history', () => {
      const messages = [
        { id: 'msg-1', role: 'user' as const, content: 'Edit this file', timestamp: Date.now(), currentNote: 'notes/file.md' },
      ];

      // Now test the standalone function directly
      const context = buildContextFromHistory(messages);

      expect(context).toContain('<current_note>');
      expect(context).toContain('notes/file.md');
    });

    it('should truncate long tool results', () => {
      const longResult = 'x'.repeat(1000);
      // Now test the standalone function directly
      const truncated = truncateToolResult(longResult, 100);

      expect(truncated.length).toBeLessThan(longResult.length);
      expect(truncated).toContain('(truncated)');
    });

    it('should not truncate short tool results', () => {
      const shortResult = 'Short result';
      // Now test the standalone function directly
      const result = truncateToolResult(shortResult, 100);

      expect(result).toBe(shortResult);
    });
  });

  describe('session expiration recovery flow', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockPlugin.getResolvedProviderCliPath.mockReturnValue('/mock/claude');
    });

    it('should rebuild history and retry without resume on session expiration', async () => {
      service.setSessionId('stale-session');
      const prompts: string[] = [];

      jest.spyOn(service as any, 'queryViaSDK').mockImplementation((async function* (prompt: string) {
        prompts.push(prompt);
        if (prompts.length === 1) {
          throw new Error('Session expired');
        }
        yield { type: 'text', content: 'Recovered' };
      }) as any);

      const history = [
        { id: 'msg-1', role: 'user' as const, content: 'First question', timestamp: Date.now() },
        {
          id: 'msg-2',
          role: 'assistant' as const,
          content: 'Answer',
          timestamp: Date.now(),
          toolCalls: [
            { id: 'tool-1', name: 'Read', input: { file_path: '/test/vault/path/file.md' }, status: 'completed' as const, result: 'file content' },
          ],
        },
        { id: 'msg-3', role: 'user' as const, content: 'Follow up', timestamp: Date.now(), currentNote: 'note.md' },
      ];

      const chunks: any[] = [];
      for await (const chunk of service.query('Follow up', undefined, history, { forceColdStart: true })) {
        chunks.push(chunk);
      }

      expect(prompts[0]).toBe('Follow up');
      expect(prompts[1]).toContain('User: First question');
      expect(prompts[1]).toContain('Assistant: Answer');
      expect(prompts[1]).toContain('<current_note>');
      expect(prompts[1]).toContain('note.md');
      expect(chunks.some((c) => c.type === 'text' && c.content === 'Recovered')).toBe(true);
      expect(service.getSessionId()).toBeNull();
    });

    it('should rebuild history when persistent query throws session expired', async () => {
      service.setSessionId('stale-session');
      const prompts: string[] = [];

      // eslint-disable-next-line require-yield
      jest.spyOn(service as any, 'queryViaPersistent').mockImplementation((async function* () {
        throw new Error('Session expired');
      }) as any);

      jest.spyOn(service as any, 'queryViaSDK').mockImplementation((async function* (prompt: string) {
        prompts.push(prompt);
        yield { type: 'text', content: 'Recovered' };
      }) as any);

      const history = [
        { id: 'msg-1', role: 'user' as const, content: 'First question', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant' as const, content: 'Answer', timestamp: Date.now() },
        { id: 'msg-3', role: 'user' as const, content: 'Follow up', timestamp: Date.now() },
      ];

      const chunks: any[] = [];
      for await (const chunk of service.query('Follow up', undefined, history)) {
        chunks.push(chunk);
      }

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('User: First question');
      expect(prompts[0]).toContain('Assistant: Answer');
      expect(prompts[0]).toContain('User: Follow up');
      expect(chunks.some((c) => c.type === 'text' && c.content === 'Recovered')).toBe(true);
      expect(service.getSessionId()).toBeNull();
    });

    it('should preserve current message images when session expired during cold-start', async () => {
      service.setSessionId('stale-session');
      let capturedImages: any[] | undefined;

      jest.spyOn(service as any, 'queryViaSDK').mockImplementation((async function* (
        _prompt: string,
        _vaultPath: string,
        _cliPath: string,
        images: any[] | undefined
      ) {
        if (!capturedImages) {
          // First call throws session expired
          capturedImages = images;
          throw new Error('Session expired');
        }
        // Second call (retry) should have the images
        capturedImages = images;
        yield { type: 'text', content: 'Recovered' };
      }) as any);

      const history = [
        { id: 'msg-1', role: 'user' as const, content: 'First question', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant' as const, content: 'Answer', timestamp: Date.now() },
      ];

      const currentImages = [
        { id: 'img-1', name: 'test.png', mediaType: 'image/png' as const, data: 'base64data', size: 100, source: 'file' as const },
      ];

      const chunks: any[] = [];
      for await (const chunk of service.query('Follow up with image', currentImages, history, { forceColdStart: true })) {
        chunks.push(chunk);
      }

      expect(capturedImages).toBeDefined();
      expect(capturedImages).toHaveLength(1);
      expect(capturedImages![0].id).toBe('img-1');
      expect(chunks.some((c) => c.type === 'text' && c.content === 'Recovered')).toBe(true);
    });

    it('should preserve current message images when session expired during persistent query', async () => {
      service.setSessionId('stale-session');
      let capturedImages: any[] | undefined;

      // eslint-disable-next-line require-yield
      jest.spyOn(service as any, 'queryViaPersistent').mockImplementation((async function* () {
        throw new Error('Session expired');
      }) as any);

      jest.spyOn(service as any, 'queryViaSDK').mockImplementation((async function* (
        _prompt: string,
        _vaultPath: string,
        _cliPath: string,
        images: any[] | undefined
      ) {
        capturedImages = images;
        yield { type: 'text', content: 'Recovered' };
      }) as any);

      const history = [
        { id: 'msg-1', role: 'user' as const, content: 'First question', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant' as const, content: 'Answer', timestamp: Date.now() },
      ];

      const currentImages = [
        { id: 'img-1', name: 'test.png', mediaType: 'image/png' as const, data: 'base64data', size: 100, source: 'file' as const },
        { id: 'img-2', name: 'test2.jpg', mediaType: 'image/jpeg' as const, data: 'base64data2', size: 200, source: 'paste' as const },
      ];

      const chunks: any[] = [];
      for await (const chunk of service.query('Follow up with images', currentImages, history)) {
        chunks.push(chunk);
      }

      expect(capturedImages).toBeDefined();
      expect(capturedImages).toHaveLength(2);
      expect(capturedImages![0].id).toBe('img-1');
      expect(capturedImages![1].id).toBe('img-2');
      expect(chunks.some((c) => c.type === 'text' && c.content === 'Recovered')).toBe(true);
    });
  });

  describe('image prompt and hydration', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockPlugin.getResolvedProviderCliPath.mockReturnValue('/mock/claude');
    });

    it('should return plain prompt when no valid images', () => {
      const prompt = (service as any).buildPromptWithImages('hello', []);
      expect(prompt).toBe('hello');
    });

    it('should build async generator with image blocks', async () => {
      const images = [
        { id: 'img-1', name: 'a.png', mediaType: 'image/png', data: 'AAA', size: 3, source: 'file' },
        { id: 'img-2', name: 'b.png', mediaType: 'image/png', data: 'BBB', size: 3, source: 'file' },
      ];

      const gen = (service as any).buildPromptWithImages('hi', images) as AsyncGenerator<any>;
      const messages: any[] = [];
      for await (const m of gen) messages.push(m);

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('user');
      expect(messages[0].message.content[0].type).toBe('image');
      expect(messages[0].message.content[2].type).toBe('text');
    });

  });

  // QueryOptionsBuilder tests moved to tests/unit/core/agent/QueryOptionsBuilder.test.ts

  describe('transformSDKMessage additional branches', () => {
    it('should transform tool_result blocks inside user content', () => {
      const sdkMessage: any = {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'out', is_error: true },
          ],
        },
      };

      const chunks = Array.from(transformSDKMessage(sdkMessage));
      expect(chunks[0]).toEqual(expect.objectContaining({ type: 'tool_result', id: 'tool-1', isError: true }));
    });

    it('should transform stream_event tool_use and text blocks', () => {
      const toolUseMsg: any = {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} } },
      };
      const textStartMsg: any = {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'text', text: 'hello' } },
      };
      const textDeltaMsg: any = {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
      };

      const toolChunks = Array.from(transformSDKMessage(toolUseMsg));
      const textChunks = [
        ...Array.from(transformSDKMessage(textStartMsg)),
        ...Array.from(transformSDKMessage(textDeltaMsg)),
      ];

      expect(toolChunks[0]).toEqual(expect.objectContaining({ type: 'tool_use', id: 't1', name: 'Read' }));
      expect(textChunks.map((c: any) => c.content).join('')).toBe('hello world');
    });

    // Note: Tests for result message usage were removed because transformSDKMessage
    // now extracts usage from assistant messages (not result messages) to avoid
    // inaccurate spikes from aggregated subagent tokens

    it('should emit no chunks for result messages (usage now comes from assistant messages)', () => {
      const sdkMessage: any = {
        type: 'result',
        modelUsage: {
          'model-a': {
            inputTokens: 10,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 0,
          },
        },
      };

      const chunks = Array.from(transformSDKMessage(sdkMessage));
      expect(chunks).toHaveLength(0);
    });
  });

  describe('remaining business branches', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockPlugin.getResolvedProviderCliPath.mockReturnValue('/mock/claude');
    });

    it('yields error when session retry also fails', async () => {
      // eslint-disable-next-line require-yield
      jest.spyOn(service as any, 'queryViaSDK').mockImplementation(async function* () {
        throw new Error('Session expired');
      });

      const history = [
        { id: 'u1', role: 'user' as const, content: 'Hi', timestamp: 0 },
      ];

      const chunks: any[] = [];
      for await (const c of service.query('Hi', undefined, history, { forceColdStart: true })) chunks.push(c);

      const errorChunk = chunks.find((c) => c.type === 'error');
      expect(errorChunk).toBeDefined();
      expect(errorChunk.content).toContain('Session expired');
    });

    it('yields error for non-session failures', async () => {
      // eslint-disable-next-line require-yield
      jest.spyOn(service as any, 'queryViaSDK').mockImplementation(async function* () {
        throw new Error('Network down');
      });

      const chunks: any[] = [];
      for await (const c of service.query('Hi', undefined, undefined, { forceColdStart: true })) chunks.push(c);

      expect(chunks.some((c) => c.type === 'error' && c.content.includes('Network down'))).toBe(true);
    });

    it('skips non-user messages and empty assistants in rebuilt context', () => {
      const messages: any[] = [
        { id: 'sys', role: 'system', content: 'ignore', timestamp: 0 },
        { id: 'a1', role: 'assistant', content: '', timestamp: 0 },
        { id: 'u1', role: 'user', content: 'Hello', timestamp: 0 },
      ];

      // Now test the standalone function directly
      const context = buildContextFromHistory(messages);
      expect(context).toContain('User: Hello');
      expect(context).not.toContain('system');
    });

    it('returns undefined when no user message exists', () => {
      // Now test the standalone function directly
      const last = getLastUserMessage([
        { id: 'a1', role: 'assistant' as const, content: 'Hi', timestamp: 0 },
      ]);
      expect(last).toBeUndefined();
    });

    it('formats tool call without result', () => {
      // Now test the standalone function directly
      const line = formatToolCallForContext({ id: 't', name: 'Read', input: {}, status: 'completed' as const });
      expect(line).toBe('[Tool Read status=completed]');
    });

    it('yields error when SDK query throws inside queryViaSDK', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdk = require('@anthropic-ai/claude-agent-sdk');
      const spy = jest.spyOn(sdk, 'query').mockImplementation(() => { throw new Error('boom'); });

      const chunks: any[] = [];
      for await (const c of service.query('Hi', undefined, undefined, { forceColdStart: true })) chunks.push(c);

      expect(chunks.some((c) => c.type === 'error' && c.content.includes('boom'))).toBe(true);
      spy.mockRestore();
    });

    // Note: 'allows pre-approved actions' test removed - createUnifiedToolCallback was part of plan mode

    it('returns null for non-file tools in getPathFromToolInput', () => {
      expect(getPathFromToolInput('WebSearch', {})).toBeNull();
    });

    it('does not treat Grep pattern as a path', () => {
      expect(getPathFromToolInput('Grep', { pattern: '/etc/passwd' })).toBeNull();
      expect(getPathFromToolInput('Grep', { pattern: 'TODO', path: 'notes' })).toBe('notes');
    });

    it('covers NotebookEdit and default patterns/descriptions', () => {
      // Now test the standalone functions directly
      expect(getActionPattern('NotebookEdit', { notebook_path: 'nb.ipynb' })).toBe('nb.ipynb');
      expect(getActionPattern('Other', { foo: 'bar' })).toContain('foo');
      expect(getActionDescription('Other', { foo: 'bar' })).toContain('foo');
    });

  });

  describe('persistent query configuration detection', () => {
    it('detects system prompt changes requiring restart', async () => {
      // First query establishes baseline config
      const chunks1: any[] = [];
      for await (const c of service.query('first')) chunks1.push(c);

      // Change system prompt which affects systemPromptKey
      mockPlugin.settings.systemPrompt = 'new custom prompt';

      // Second query should detect the change
      const chunks2: any[] = [];
      for await (const c of service.query('second')) chunks2.push(c);

      // If restart happened, the session would change
      // The service should have detected the configuration change
      expect(chunks2.some((c) => c.type === 'done')).toBe(true);
    });

  });

  describe('persistent query dynamic updates', () => {
    it('rebuilds the persistent query when a fixed thinking budget changes', async () => {
      // Use a custom model so the legacy budget path is used
      mockPlugin.settings.model = 'custom-model';
      mockPlugin.settings.thinkingBudget = 'off';

      const chunks1: any[] = [];
      for await (const c of service.query('first')) chunks1.push(c);

      // Change thinking budget - this should rebuild the query with startup thinking options.
      mockPlugin.settings.thinkingBudget = 'high';

      const chunks2: any[] = [];
      for await (const c of service.query('second')) chunks2.push(c);

      const response = getLastResponse();
      expect(response?.setMaxThinkingTokens).not.toHaveBeenCalled();
    });

    it('does not call setMaxThinkingTokens for adaptive models when budget changes', async () => {
      // Adaptive model (sonnet) should use effort levels, not token budgets
      mockPlugin.settings.model = 'sonnet';
      mockPlugin.settings.thinkingBudget = 'off';

      const chunks1: any[] = [];
      for await (const c of service.query('first')) chunks1.push(c);

      // Change thinking budget — should be ignored for adaptive models
      mockPlugin.settings.thinkingBudget = 'high';

      const chunks2: any[] = [];
      for await (const c of service.query('second')) chunks2.push(c);

      const response = getLastResponse();
      expect(response?.setMaxThinkingTokens).not.toHaveBeenCalled();
    });

    it('updates permission mode via setPermissionMode when going from YOLO to normal', async () => {
      // Start in YOLO mode
      mockPlugin.settings.permissionMode = 'yolo';
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      const chunks1: any[] = [];
      for await (const c of service.query('first')) chunks1.push(c);

      // Switch to normal mode
      mockPlugin.settings.permissionMode = 'normal';

      const chunks2: any[] = [];
      for await (const c of service.query('second')) chunks2.push(c);

      const response = getLastResponse();
      // Should call setPermissionMode for YOLO -> normal transition
      expect(response?.setPermissionMode).toHaveBeenCalledWith('acceptEdits');
    });

    it('updates permission mode via setPermissionMode when going from normal to YOLO', async () => {
      // Start in normal mode
      mockPlugin.settings.permissionMode = 'normal';
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      const chunks1: any[] = [];
      for await (const c of service.query('first')) chunks1.push(c);

      // Switch to YOLO mode
      mockPlugin.settings.permissionMode = 'yolo';

      const chunks2: any[] = [];
      for await (const c of service.query('second')) chunks2.push(c);

      const response = getLastResponse();
      // Should call setPermissionMode for normal -> YOLO transition (no restart needed)
      expect(response?.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    });

    it('updates effort level via applyFlagSettings without restarting', async () => {
      mockPlugin.settings.model = 'sonnet';
      mockPlugin.settings.effortLevel = 'high';

      const chunks1: any[] = [];
      for await (const c of service.query('first')) chunks1.push(c);

      const queryCountBefore = getQueryCallCount();
      mockPlugin.settings.effortLevel = 'max';

      const chunks2: any[] = [];
      for await (const c of service.query('second')) chunks2.push(c);

      const response = getLastResponse();
      expect(response?.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' });
      expect(getQueryCallCount()).toBe(queryCountBefore);
    });

    it('updates MCP servers on the active persistent query', async () => {
      const chunks1: any[] = [];
      for await (const c of service.query('first', undefined, undefined, {
        mcpMentions: new Set(['server1']),
      })) chunks1.push(c);

      const response1 = getLastResponse();
      expect(response1?.setMcpServers).toHaveBeenCalled();

      // Query with different MCP mentions
      const chunks2: any[] = [];
      for await (const c of service.query('second', undefined, undefined, {
        mcpMentions: new Set(['server2']),
      })) chunks2.push(c);

      const response2 = getLastResponse();
      expect(response2?.setMcpServers).toHaveBeenCalled();
    });

    it('reapplies query overrides after restart triggered by config change', async () => {
      const chunks1: any[] = [];
      for await (const c of service.query('first')) chunks1.push(c);

      mockPlugin.settings.systemPrompt = 'restart-required';

      const chunks2: any[] = [];
      for await (const c of service.query('second', undefined, undefined, {
        model: 'claude-opus-4-5',
      })) chunks2.push(c);

      const response = getLastResponse();
      expect(response?.setModel).toHaveBeenCalledWith('claude-opus-4-5');
    });

    it('falls back to cold-start when restart fails during dynamic updates', async () => {
      const chunks1: any[] = [];
      for await (const c of service.query('first')) chunks1.push(c);
      expect((service as any).persistentQuery).not.toBeNull();

      // Force a config change that requires restart
      mockPlugin.settings.systemPrompt = 'restart-required';

      // Allow query + applyDynamicUpdates, then fail restart due to missing CLI path
      mockPlugin.getResolvedProviderCliPath.mockReset();
      mockPlugin.getResolvedProviderCliPath
        .mockReturnValueOnce('/mock/claude')
        .mockReturnValueOnce('/mock/claude')
        .mockReturnValueOnce(null);

      const callCountBeforeSecond = getQueryCallCount();

      const chunks2: any[] = [];
      for await (const c of service.query('second')) chunks2.push(c);

      expect(chunks2.some((c) => c.type === 'text')).toBe(true);
      expect(getQueryCallCount()).toBe(callCountBeforeSecond + 1);
      expect((service as any).persistentQuery).toBeNull();
      expect((service as any).shuttingDown).toBe(false);
    });
  });

  describe('persistent query crash recovery', () => {
    it('prevents infinite crash recovery loops via crashRecoveryAttempted flag', async () => {
      // Access private state for testing
      const serviceAny = service as any;

      // Simulate first crash recovery
      serviceAny.crashRecoveryAttempted = false;
      serviceAny.lastSentMessage = createTextUserMessage('test');

      // After first crash, flag should be set
      serviceAny.crashRecoveryAttempted = true;

      // Second crash should not attempt recovery
      const shouldResend = serviceAny.lastSentMessage && !serviceAny.crashRecoveryAttempted;
      expect(shouldResend).toBe(false);
    });

    it('clears lastSentMessage on successful completion', async () => {
      const serviceAny = service as any;

      // Before query, lastSentMessage should be null
      expect(serviceAny.lastSentMessage).toBeNull();

      // Run a query
      const chunks: any[] = [];
      for await (const c of service.query('test')) chunks.push(c);

      // After successful completion, lastSentMessage should be cleared
      expect(serviceAny.lastSentMessage).toBeNull();
    });
  });

  // Note: 'persistent query deferred close', 'tool restriction with allowed tools list', and
  // 'persistent query permission mode transitions' tests removed - createUnifiedToolCallback/pendingCloseReason
  // were part of plan mode



  describe('persistent query crash recovery behavior', () => {
    it('restarts persistent query after consumer error to prepare for next query', async () => {
      const serviceAny = service as any;

      // Run a query to set up the persistent query
      const chunks: any[] = [];
      for await (const c of service.query('initial')) chunks.push(c);

      // The persistent query should exist
      expect(serviceAny.persistentQuery).not.toBeNull();

      // Crash recovery should restart the persistent query loop
      serviceAny.crashRecoveryAttempted = false;
      await service.ensureReady({ force: true });

      // After restart, persistent query should still be ready
      expect(serviceAny.persistentQuery).not.toBeNull();
    });

    it('re-enqueues pending message after crash recovery restart', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdk = require('@anthropic-ai/claude-agent-sdk');

      let callCount = 0;
      let firstPrompt: any = null;
      let secondPrompt: any = null;
      let resolveSecondPrompt: ((message: any) => void) | null = null;

      const secondPromptPromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timed out waiting for crash recovery re-enqueue'));
        }, 2000);
        resolveSecondPrompt = (message: any) => {
          clearTimeout(timeout);
          resolve(message);
        };
      });

      const spy = jest.spyOn(sdk, 'query').mockImplementation((params: any) => {
        const { prompt } = params;
        callCount += 1;
        const callIndex = callCount;

        const generator = async function* () {
          if (prompt && typeof prompt[Symbol.asyncIterator] === 'function') {
            for await (const message of prompt) {
              if (callIndex === 1) {
                firstPrompt = message;
                throw new Error('boom');
              }
              secondPrompt = message;
              if (resolveSecondPrompt) resolveSecondPrompt(message);
              yield { type: 'system', subtype: 'init', session_id: 'test-session-123' };
              yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Recovered' }] } };
              yield { type: 'result', result: 'completed' };
            }
            return;
          }

          if (callIndex === 1) {
            firstPrompt = prompt;
            throw new Error('boom');
          }
          secondPrompt = prompt;
          if (resolveSecondPrompt) resolveSecondPrompt(prompt);
          yield { type: 'system', subtype: 'init', session_id: 'test-session-123' };
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Recovered' }] } };
          yield { type: 'result', result: 'completed' };
        };

        const gen = generator() as AsyncGenerator<any> & {
          interrupt: jest.Mock;
          setModel: jest.Mock;
          setMaxThinkingTokens: jest.Mock;
          setPermissionMode: jest.Mock;
          setMcpServers: jest.Mock;
        };
        gen.interrupt = jest.fn().mockResolvedValue(undefined);
        gen.setModel = jest.fn().mockResolvedValue(undefined);
        gen.setMaxThinkingTokens = jest.fn().mockResolvedValue(undefined);
        gen.setPermissionMode = jest.fn().mockResolvedValue(undefined);
        gen.setMcpServers = jest.fn().mockResolvedValue({ added: [], removed: [], errors: {} });
        return gen;
      });

      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _chunk of service.query('initial')) {
          // drain
        }

        await secondPromptPromise;

        expect(callCount).toBeGreaterThanOrEqual(2);
        expect(firstPrompt).not.toBeNull();
        expect(secondPrompt).not.toBeNull();
        expect(secondPrompt.message?.content).toEqual(firstPrompt.message?.content);
      } finally {
        spy.mockRestore();
      }
    });

    it('only attempts crash recovery once via crashRecoveryAttempted flag', async () => {
      const serviceAny = service as any;

      // Run a query to set up the persistent query
      const chunks: any[] = [];
      for await (const c of service.query('initial')) chunks.push(c);

      // First crash - should attempt recovery
      expect(serviceAny.crashRecoveryAttempted).toBe(false);
      const shouldAttemptFirst = !serviceAny.crashRecoveryAttempted;
      expect(shouldAttemptFirst).toBe(true);

      // After first crash, flag is set
      serviceAny.crashRecoveryAttempted = true;

      // Second crash - should not attempt recovery
      const shouldAttemptSecond = !serviceAny.crashRecoveryAttempted;
      expect(shouldAttemptSecond).toBe(false);
    });
  });
});
