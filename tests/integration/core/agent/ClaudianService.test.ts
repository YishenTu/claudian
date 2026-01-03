// eslint-disable-next-line jest/no-mocks-import
import {
  getLastOptions,
  getLastResponse,
  resetMockMessages,
  setMockMessages,
} from '@test/__mocks__/claude-agent-sdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock fs module
jest.mock('fs');
jest.mock('@/core/types', () => {
  const actual = jest.requireActual('@/core/types');
  return {
    __esModule: true,
    ...actual,
    getCurrentPlatformBlockedCommands: (commands: { unix: string[] }) => commands.unix,
  };
});

// Now import after all mocks are set up
import { ClaudianService } from '@/core/agent/ClaudianService';
import { createFileHashPostHook, createFileHashPreHook, type DiffContentEntry } from '@/core/hooks/DiffTrackingHooks';
import { createVaultRestrictionHook } from '@/core/hooks/SecurityHooks';
import { hydrateImagesData, readImageAttachmentBase64, resolveImageFilePath } from '@/core/images/imageLoader';
import { transformSDKMessage } from '@/core/sdk';
import { getActionDescription, getActionPattern } from '@/core/security/ApprovalManager';
import { extractPathCandidates } from '@/core/security/BashPathValidator';
import { getPathFromToolInput } from '@/core/tools/toolInput';
import type { ToolDiffData } from '@/core/types';
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

// Create a mock MCP server manager
function createMockMcpManager() {
  return {
    loadServers: jest.fn().mockResolvedValue(undefined),
    getServers: jest.fn().mockReturnValue([]),
    getEnabledCount: jest.fn().mockReturnValue(0),
    getActiveServers: jest.fn().mockReturnValue({}),
    hasServers: jest.fn().mockReturnValue(false),
  } as any;
}

// Create a mock plugin
function createMockPlugin(settings = {}) {
  const mockPlugin = {
    settings: {
      enableBlocklist: true,
      blockedCommands: {
        unix: [
          'rm -rf',
          'rm -r /',
          'chmod 777',
          'chmod -R 777',
          'mkfs',
          'dd if=',
          '> /dev/sd',
        ],
        windows: [
          'Remove-Item -Recurse -Force',
          'Format-Volume',
        ],
      },
      permissions: [],
      permissionMode: 'yolo',
      ...settings,
    },
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault/path',
        },
      },
    },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    // Mock getView to return null (tests don't have real view)
    // This allows optional chaining to work safely
    getView: jest.fn().mockReturnValue(null),
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

  describe('plan mode approvals', () => {
    it('includes revise feedback in ExitPlanMode response', async () => {
      service.setExitPlanModeCallback(async () => ({
        decision: 'revise',
        feedback: 'Add coverage for edge cases.',
      }));

      const result = await (service as any).handleExitPlanModeTool({ plan: 'Plan draft' }, 'tool-1');

      expect(result.behavior).toBe('deny');
      expect(result.interrupt).toBe(false);
      expect(result.message).toContain('Add coverage for edge cases.');
    });

    it('reads plan content from ~/.claude/plans with tilde expansion', async () => {
      const planFromFile = 'Plan from file';
      const planPath = path.resolve(os.homedir(), '.claude', 'plans', 'plan.md');

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(planFromFile);

      service.setCurrentPlanFilePath('~/.claude/plans/plan.md');
      const callback = jest.fn().mockResolvedValue({ decision: 'cancel' });
      service.setExitPlanModeCallback(callback);

      await (service as any).handleExitPlanModeTool({ plan: 'Plan from input' }, 'tool-2');

      expect(fs.existsSync).toHaveBeenCalledWith(planPath);
      expect(fs.readFileSync).toHaveBeenCalledWith(planPath, 'utf-8');
      expect(callback).toHaveBeenCalledWith(planFromFile);
    });
  });

  describe('shouldBlockCommand', () => {
    it('should block dangerous rm commands', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'rm -rf /' }),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('delete everything')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('rm -rf');
    });

    it('should block chmod 777 commands', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'chmod 777 /etc/passwd' }),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('change permissions')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('chmod 777');
    });

    it('should allow safe commands when blocklist is enabled', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'ls -la' }),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('list files')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeUndefined();

      const toolUseChunk = chunks.find((c) => c.type === 'tool_use');
      expect(toolUseChunk).toBeDefined();
    });

    it('should not block commands when blocklist is disabled', async () => {
      mockPlugin = createMockPlugin({ enableBlocklist: false });
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      (fs.existsSync as jest.Mock).mockReturnValue(true);

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'rm -rf /' }),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('delete everything')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeUndefined();

      const toolUseChunk = chunks.find((c) => c.type === 'tool_use');
      expect(toolUseChunk).toBeDefined();
    });

    it('should block mkfs commands', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'mkfs.ext4 /dev/sda1' }),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('format disk')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('mkfs');
    });

    it('should block dd if= commands', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'dd if=/dev/zero of=/dev/sda' }),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('wipe disk')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('dd if=');
    });
  });

  describe('findClaudeCLI', () => {
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
      const customPath = '/custom/path/to/cli.js';
      mockPlugin = createMockPlugin({ claudeCliPath: customPath });
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
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      const homeDir = os.homedir();
      const autoDetectedPath = path.join(homeDir, '.claude', 'local', 'claude');

      (fs.existsSync as jest.Mock).mockImplementation((p: string) =>
        p === customPath || p === autoDetectedPath
      );
      (fs.statSync as jest.Mock).mockImplementation((p: string) => ({
        isFile: () => p !== customPath, // Custom path is a directory
      }));

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('hello')) {
        chunks.push(chunk);
      }

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('directory, not a file')
      );
      consoleSpy.mockRestore();
    });

    it('should fall back to auto-detection when custom path does not exist', async () => {
      const customPath = '/nonexistent/path/cli.js';
      mockPlugin = createMockPlugin({ claudeCliPath: customPath });
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      const homeDir = os.homedir();
      const autoDetectedPath = path.join(homeDir, '.claude', 'local', 'claude');

      (fs.existsSync as jest.Mock).mockImplementation((p: string) =>
        p === autoDetectedPath // Custom path does not exist
      );

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('hello')) {
        chunks.push(chunk);
      }

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('not found')
      );
      consoleSpy.mockRestore();
    });

    it('should fall back to auto-detection when custom path stat fails', async () => {
      const customPath = '/custom/path/to/cli.js';
      mockPlugin = createMockPlugin({ claudeCliPath: customPath });
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      const homeDir = os.homedir();
      const autoDetectedPath = path.join(homeDir, '.claude', 'local', 'claude');

      (fs.existsSync as jest.Mock).mockImplementation((p: string) =>
        p === customPath || p === autoDetectedPath
      );
      (fs.statSync as jest.Mock).mockImplementation(() => {
        throw new Error('EACCES');
      });

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

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
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('not accessible')
      );
      consoleSpy.mockRestore();
    });

    it('should reload CLI path after cleanup', async () => {
      const firstPath = '/custom/path/to/cli-1.js';
      const secondPath = '/custom/path/to/cli-2.js';
      mockPlugin = createMockPlugin({ claudeCliPath: firstPath });
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

      const toolResultChunk = chunks.find((c) => c.type === 'tool_result');
      expect(toolResultChunk).toBeDefined();
      expect(toolResultChunk?.content).toBe('File contents here');
      expect(toolResultChunk?.id).toBe('read-tool-1');
    });

    it('should transform error messages', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'error',
          error: 'Something went wrong',
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
      for await (const _chunk of service.query('second')) {
        // drain
      }

      const options = getLastOptions();
      expect(options?.resume).toBe('resume-session');
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

  describe('resetSession', () => {
    it('should reset session without throwing', () => {
      expect(() => service.resetSession()).not.toThrow();
    });

    it('should clear session ID', () => {
      service.setSessionId('some-session');
      expect(service.getSessionId()).toBe('some-session');

      service.resetSession();
      expect(service.getSessionId()).toBeNull();
    });
  });

  describe('getSessionId and setSessionId', () => {
    it('should initially return null', () => {
      expect(service.getSessionId()).toBeNull();
    });

    it('should set and get session ID', () => {
      service.setSessionId('test-session-123');
      expect(service.getSessionId()).toBe('test-session-123');
    });

    it('should allow setting session ID to null', () => {
      service.setSessionId('some-session');
      service.setSessionId(null);
      expect(service.getSessionId()).toBeNull();
    });
  });

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

  describe('regex pattern matching in blocklist', () => {
    it('should handle regex patterns in blocklist', async () => {
      mockPlugin = createMockPlugin({
        blockedCommands: { unix: ['rm\\s+-rf', 'chmod\\s+7{3}'], windows: [] },
      });
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      (fs.existsSync as jest.Mock).mockReturnValue(true);

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'rm   -rf /home' }),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('delete')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
    });

    it('should fallback to includes for invalid regex', async () => {
      mockPlugin = createMockPlugin({
        blockedCommands: { unix: ['[invalid regex'], windows: [] },
      });
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      (fs.existsSync as jest.Mock).mockReturnValue(true);

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'something with [invalid regex inside' }),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('test')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
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
      (service as any).resolvedClaudePath = '/mock/claude';
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

  describe('vault restriction', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      // Mock realpathSync to normalize paths (resolve .. and .)
      const normalizePath = (p: string) => {
        // Use path.resolve to normalize path traversal
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pathModule = require('path');
        return pathModule.resolve(p);
      };
      (fs.realpathSync as any) = jest.fn(normalizePath);
      if (fs.realpathSync) {
        (fs.realpathSync as any).native = jest.fn(normalizePath);
      }
    });

    it('should block Read tool accessing files outside vault', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Read', { file_path: '/etc/passwd' }, 'read-outside'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('read passwd')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('outside the vault');
    });

    it('should allow Read tool accessing files inside vault', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Read', { file_path: '/test/vault/path/notes/test.md' }, 'read-inside'),
        createUserWithToolResult('File contents', 'read-inside'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('read file')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeUndefined();

      const toolResultChunk = chunks.find((c) => c.type === 'tool_result');
      expect(toolResultChunk).toBeDefined();
    });

    it('should block Write tool writing outside vault', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Write', { file_path: '/tmp/malicious.sh', content: 'bad stuff' }, 'write-outside'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('write file')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('outside the vault');
    });

    it('should allow Write tool writing to allowed export path', async () => {
      mockPlugin.settings.allowedExportPaths = ['/tmp'];

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Write', { file_path: '/tmp/export.md', content: 'exported' }, 'write-export'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('export file')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeUndefined();
    });

    it('should block Write tool writing to context path under export path', async () => {
      mockPlugin.settings.allowedExportPaths = ['/tmp'];
      mockPlugin.settings.allowedContextPaths = ['/tmp/workspace'];

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Write', { file_path: '/tmp/workspace/out.md', content: 'blocked' }, 'write-context'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('write context')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('read-only');
    });

    it('should allow Read tool reading from context path under export path', async () => {
      mockPlugin.settings.allowedExportPaths = ['/tmp'];
      mockPlugin.settings.allowedContextPaths = ['/tmp/workspace'];

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Read', { file_path: '/tmp/workspace/in.md' }, 'read-context'),
        createUserWithToolResult('context contents', 'read-context'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('read context')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeUndefined();
    });

    it('should allow Write tool writing to exact overlap path', async () => {
      mockPlugin.settings.allowedExportPaths = ['/tmp/shared'];
      mockPlugin.settings.allowedContextPaths = ['/tmp/shared'];

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Write', { file_path: '/tmp/shared/out.md', content: 'allowed' }, 'write-overlap'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('write overlap')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeUndefined();
    });

    it('should block Edit tool editing outside vault', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Edit', { file_path: '/etc/hosts', old_string: 'old', new_string: 'new' }, 'edit-outside'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('edit file')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('outside the vault');
    });

    it('should block Bash commands with paths outside vault', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'cat /etc/passwd' }, 'bash-outside'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('read passwd')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('outside the vault');
    });

    it('should allow Bash command writing to allowed export path via redirection', async () => {
      mockPlugin.settings.allowedExportPaths = ['/tmp'];

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'cat ./notes/file.md > /tmp/out.md' }, 'bash-export'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('export via bash')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeUndefined();
    });

    it('should block Bash command writing to context path under export path', async () => {
      mockPlugin.settings.allowedExportPaths = ['/tmp'];
      mockPlugin.settings.allowedContextPaths = ['/tmp/workspace'];

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'echo hi > /tmp/workspace/out.md' }, 'bash-context-write'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('write context bash')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('read-only');
    });

    it('should allow Bash command writing to allowed export path via -o', async () => {
      mockPlugin.settings.allowedExportPaths = ['/tmp'];

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'pandoc ./notes/file.md -o /tmp/out.docx' }, 'bash-export-o'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('export via pandoc')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeUndefined();
    });

    it('should block Bash command reading from allowed export path (write-only)', async () => {
      mockPlugin.settings.allowedExportPaths = ['/tmp'];

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'cat /tmp/out.md' }, 'bash-export-read'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('read export')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('write-only');
    });

    it('should block Bash command copying from allowed export path into vault (write-only)', async () => {
      mockPlugin.settings.allowedExportPaths = ['/tmp'];

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'cp /tmp/out.md ./notes/out.md' }, 'bash-export-cp'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('copy export')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('write-only');
    });

    it('should allow Bash commands with paths inside vault', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'cat /test/vault/path/notes/file.md' }, 'bash-inside'),
        createUserWithToolResult('File contents', 'bash-inside'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('cat file')) {
        chunks.push(chunk);
      }

      // Should not be blocked by vault restriction (may still be blocked by blocklist)
      const blockedChunk = chunks.find((c) => c.type === 'blocked' && c.content.includes('outside the vault'));
      expect(blockedChunk).toBeUndefined();
    });

    it('should block path traversal attempts', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Read', { file_path: '/test/vault/path/../../../etc/passwd' }, 'read-traversal'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('read file')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('outside the vault');
    });

    it('should block Glob tool searching outside vault', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Glob', { pattern: '*.md', path: '/etc' }, 'glob-outside'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('search files')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('outside the vault');
    });

    it('should block Glob tool with escaping pattern', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Glob', { pattern: '../**/*.md' }, 'glob-escape'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('search files')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('outside the vault');
    });

    it('should block Grep tool searching outside vault', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Grep', { pattern: 'passwd', path: '/etc' }, 'grep-outside'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('grep outside')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('outside the vault');
    });

    it('should not block Grep tool with absolute pattern', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Grep', { pattern: '/etc/passwd' }, 'grep-abs-pattern'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('grep pattern')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeUndefined();
    });

    it('should block tilde expansion paths outside vault', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'cat ~/.bashrc' }, 'bash-tilde'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('read bashrc')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('outside the vault');
    });

    it('should block NotebookEdit tool writing outside vault', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('NotebookEdit', { notebook_path: '/etc/passwd', file_path: '/etc/passwd' }, 'notebook-outside'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('edit notebook')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('outside the vault');
    });

    it('should block LS tool paths outside vault', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('LS', { path: '/etc' }, 'ls-outside'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('list files')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
    });

    it('should block relative paths in Bash commands that escape vault', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        createAssistantWithToolUse('Bash', { command: 'cat ../secrets.txt' }, 'bash-relative'),
        { type: 'result' },
      ]);

      const chunks: any[] = [];
      for await (const chunk of service.query('read relative')) {
        chunks.push(chunk);
      }

      const blockedChunk = chunks.find((c) => c.type === 'blocked');
      expect(blockedChunk).toBeDefined();
      expect(blockedChunk?.content).toContain('outside the vault');
    });

    it('should extract quoted and relative paths from bash commands', () => {
      const candidates = extractPathCandidates('cat "../secret.txt" ./notes/file.md ~/vault/config');
      expect(candidates).toEqual(expect.arrayContaining(['../secret.txt', './notes/file.md', '~/vault/config']));
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

  describe('approval memory system', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      // Reset plugin settings
      mockPlugin = createMockPlugin({
        permissionMode: 'normal',
        permissions: [],
      });
      service = new ClaudianService(mockPlugin, createMockMcpManager());
    });

    it('should store session-scoped approved actions', async () => {
      // Approve an action with session scope via the approval manager
      await (service as any).approvalManager.approveAction('Bash', { command: 'ls -la' }, 'session');

      // Check if action is approved
      const isApproved = (service as any).approvalManager.isActionApproved('Bash', { command: 'ls -la' });
      expect(isApproved).toBe(true);
    });

    it('should clear session-scoped approvals on resetSession', async () => {
      await (service as any).approvalManager.approveAction('Bash', { command: 'ls -la' }, 'session');

      service.resetSession();

      const isApproved = (service as any).approvalManager.isActionApproved('Bash', { command: 'ls -la' });
      expect(isApproved).toBe(false);
    });

    it('should store permanent approved actions in settings', async () => {
      await (service as any).approvalManager.approveAction('Read', { file_path: '/test/file.md' }, 'always');

      expect(mockPlugin.settings.permissions.length).toBe(1);
      expect(mockPlugin.settings.permissions[0].toolName).toBe('Read');
      expect(mockPlugin.settings.permissions[0].pattern).toBe('/test/file.md');
    });

    it('should recognize permanently approved actions', async () => {
      mockPlugin.settings.permissions = [
        { toolName: 'Read', pattern: '/test/file.md', approvedAt: Date.now(), scope: 'always' },
      ];

      const isApproved = (service as any).approvalManager.isActionApproved('Read', { file_path: '/test/file.md' });
      expect(isApproved).toBe(true);
    });

    it('should match Bash commands exactly', async () => {
      await (service as any).approvalManager.approveAction('Bash', { command: 'ls -la' }, 'session');

      // Exact match should be approved
      expect((service as any).approvalManager.isActionApproved('Bash', { command: 'ls -la' })).toBe(true);

      // Different command should not be approved
      expect((service as any).approvalManager.isActionApproved('Bash', { command: 'ls -l' })).toBe(false);
    });

    it('should match file paths with prefix', async () => {
      mockPlugin.settings.permissions = [
        { toolName: 'Read', pattern: '/test/vault/', approvedAt: Date.now(), scope: 'always' },
      ];

      // Path starting with approved prefix should match
      expect((service as any).approvalManager.isActionApproved('Read', { file_path: '/test/vault/notes/file.md' })).toBe(true);

      // Path not starting with prefix should not match
      expect((service as any).approvalManager.isActionApproved('Read', { file_path: '/other/path/file.md' })).toBe(false);
    });

    it('should not match non-segment prefixes for file paths', () => {
      mockPlugin.settings.permissions = [
        { toolName: 'Read', pattern: '/test/vault/notes', approvedAt: Date.now(), scope: 'always' },
      ];

      expect((service as any).approvalManager.isActionApproved('Read', { file_path: '/test/vault/notes/file.md' })).toBe(true);
      expect((service as any).approvalManager.isActionApproved('Read', { file_path: '/test/vault/notes2/file.md' })).toBe(false);
    });

    it('should generate correct action patterns for different tools', () => {
      // Now test the standalone function directly
      expect(getActionPattern('Bash', { command: 'git status' })).toBe('git status');
      expect(getActionPattern('Read', { file_path: '/test/file.md' })).toBe('/test/file.md');
      expect(getActionPattern('Write', { file_path: '/test/output.md' })).toBe('/test/output.md');
      expect(getActionPattern('Edit', { file_path: '/test/edit.md' })).toBe('/test/edit.md');
      expect(getActionPattern('Glob', { pattern: '**/*.md' })).toBe('**/*.md');
      expect(getActionPattern('Grep', { pattern: 'TODO' })).toBe('TODO');
    });

    it('should generate correct action descriptions', () => {
      // Now test the standalone function directly
      expect(getActionDescription('Bash', { command: 'git status' })).toBe('Run command: git status');
      expect(getActionDescription('Read', { file_path: '/test/file.md' })).toBe('Read file: /test/file.md');
      expect(getActionDescription('Write', { file_path: '/test/output.md' })).toBe('Write to file: /test/output.md');
      expect(getActionDescription('Edit', { file_path: '/test/edit.md' })).toBe('Edit file: /test/edit.md');
      expect(getActionDescription('Glob', { pattern: '**/*.md' })).toBe('Search files matching: **/*.md');
      expect(getActionDescription('Grep', { pattern: 'TODO' })).toBe('Search content matching: TODO');
    });
  });

  describe('safe mode approvals', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockPlugin = createMockPlugin({ permissionMode: 'normal' });
      service = new ClaudianService(mockPlugin, createMockMcpManager());
    });

    it('should deny when no approval callback is set', async () => {
      const canUse = (service as any).createUnifiedToolCallback('normal');

      const result = await canUse('Bash', { command: 'ls' }, {});

      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('No approval handler available');
    });

    it('should allow and cache session approvals when user allows', async () => {
      const approvalCallback = jest.fn().mockResolvedValue('allow');
      service.setApprovalCallback(approvalCallback);
      const canUse = (service as any).createUnifiedToolCallback('normal');

      const result = await canUse('Bash', { command: 'ls -la' }, {});

      expect(result.behavior).toBe('allow');
      expect(approvalCallback).toHaveBeenCalled();
      // Access via approval manager's session approvals
      const sessionApprovals = (service as any).approvalManager.getSessionApprovals();
      expect(sessionApprovals.some((a: any) => a.toolName === 'Bash')).toBe(true);
    });

    it('should persist always-allow approvals and save settings', async () => {
      const approvalCallback = jest.fn().mockResolvedValue('allow-always');
      service.setApprovalCallback(approvalCallback);
      const canUse = (service as any).createUnifiedToolCallback('normal');
      const saveSpy = jest.spyOn(mockPlugin, 'saveSettings');

      const result = await canUse('Read', { file_path: '/test/file.md' }, {});

      expect(result.behavior).toBe('allow');
      expect(mockPlugin.settings.permissions.some((a: any) => a.toolName === 'Read' && a.pattern === '/test/file.md')).toBe(true);
      expect(saveSpy).toHaveBeenCalled();
    });

    it('should deny when user rejects approval', async () => {
      const approvalCallback = jest.fn().mockResolvedValue('deny');
      service.setApprovalCallback(approvalCallback);
      const canUse = (service as any).createUnifiedToolCallback('normal');

      const result = await canUse('Bash', { command: 'rm -rf /' }, {});

      expect(result.behavior).toBe('deny');
      expect(result.message).toBe('User denied this action.');
    });

    it('should cancel file edit state when approval is denied', async () => {
      const cancelFileEdit = jest.fn();
      service.setFileEditTracker({
        cancelFileEdit,
        markFileBeingEdited: jest.fn().mockResolvedValue(undefined),
        trackEditedFile: jest.fn().mockResolvedValue(undefined),
      });
      const approvalCallback = jest.fn().mockResolvedValue('deny');
      service.setApprovalCallback(approvalCallback);
      const canUse = (service as any).createUnifiedToolCallback('normal');

      const result = await canUse('Write', { file_path: '/test/file.md' }, {});

      expect(result.behavior).toBe('deny');
      expect(cancelFileEdit).toHaveBeenCalledWith('Write', { file_path: '/test/file.md' });
    });

    it('should deny and interrupt when approval flow errors', async () => {
      const cancelFileEdit = jest.fn();
      service.setFileEditTracker({
        cancelFileEdit,
        markFileBeingEdited: jest.fn().mockResolvedValue(undefined),
        trackEditedFile: jest.fn().mockResolvedValue(undefined),
      });
      const approvalCallback = jest.fn().mockRejectedValue(new Error('boom'));
      service.setApprovalCallback(approvalCallback);
      const canUse = (service as any).createUnifiedToolCallback('normal');

      const result = await canUse('Read', { file_path: '/test/file.md' }, {});

      expect(result.behavior).toBe('deny');
      expect(result.interrupt).toBe(true);
      expect(result.message).toBe('Approval request failed.');
      expect(cancelFileEdit).toHaveBeenCalledWith('Read', { file_path: '/test/file.md' });
    });
  });

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

    it('should include tool call info in context', () => {
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

      expect(context).toContain('[Tool Read status=completed]');
      expect(context).toContain('File contents');
    });

    it('should include context files in rebuilt history', () => {
      const messages = [
        { id: 'msg-1', role: 'user' as const, content: 'Edit this file', timestamp: Date.now(), contextFiles: ['notes/file.md'] },
      ];

      // Now test the standalone function directly
      const context = buildContextFromHistory(messages);

      expect(context).toContain('<context_files>');
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
      (service as any).resolvedClaudePath = '/mock/claude';
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
        { id: 'msg-3', role: 'user' as const, content: 'Follow up', timestamp: Date.now(), contextFiles: ['note.md'] },
      ];

      const chunks: any[] = [];
      for await (const chunk of service.query('Follow up', undefined, history)) {
        chunks.push(chunk);
      }

      expect(prompts[0]).toBe('Follow up');
      expect(prompts[1]).toContain('User: First question');
      expect(prompts[1]).toContain('Assistant: Answer');
      expect(prompts[1]).toContain('<context_files>');
      expect(prompts[1]).toContain('note.md');
      expect(chunks.some((c) => c.type === 'text' && c.content === 'Recovered')).toBe(true);
      expect(service.getSessionId()).toBeNull();
    });
  });

  describe('image prompt and hydration', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (service as any).resolvedClaudePath = '/mock/claude';
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

    it('should hydrate images using existing data, cache, and file paths', async () => {
      const imageCache = await import('@/core/images/imageCache');
      jest.spyOn(imageCache, 'readCachedImageBase64').mockReturnValue('CACHE');

      (fs.existsSync as jest.Mock).mockImplementation((p: any) => p === '/test/vault/path/c.png');
      (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('file-bytes'));

      const images = [
        { id: 'img-1', name: 'a.png', mediaType: 'image/png' as const, data: 'DATA', size: 1, source: 'file' as const },
        { id: 'img-2', name: 'b.png', mediaType: 'image/png' as const, cachePath: 'cache.png', size: 1, source: 'file' as const },
        { id: 'img-3', name: 'c.png', mediaType: 'image/png' as const, filePath: 'c.png', size: 1, source: 'file' as const },
      ];

      const hydrated = await hydrateImagesData(mockPlugin.app, images as any, '/test/vault/path');

      expect(hydrated?.[0].data).toBe('DATA');
      expect(hydrated?.[1].data).toBe('CACHE');
      expect(hydrated?.[2].data).toBe(Buffer.from('file-bytes').toString('base64'));
    });
  });

  describe('query options construction', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
    });

    it('should set yolo mode options', async () => {
      mockPlugin = createMockPlugin({ permissionMode: 'yolo', thinkingBudget: 'off' });
      service = new ClaudianService(mockPlugin, createMockMcpManager());
      (service as any).resolvedClaudePath = '/mock/claude';

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } },
        { type: 'result' },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of service.query('hello')) {
        // drain
      }

      const options = getLastOptions();
      expect(options?.permissionMode).toBe('bypassPermissions');
      expect(options?.allowDangerouslySkipPermissions).toBe(true);
    });

    it('should set safe mode, resume, and thinking tokens', async () => {
      mockPlugin = createMockPlugin({ permissionMode: 'normal', thinkingBudget: 'high' });
      service = new ClaudianService(mockPlugin, createMockMcpManager());
      (service as any).resolvedClaudePath = '/mock/claude';
      service.setSessionId('resume-id');

      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'new-session' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } },
        { type: 'result' },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of service.query('hello')) {
        // drain
      }

      const options = getLastOptions();
      expect(options?.permissionMode).toBe('default');
      expect(options?.resume).toBe('resume-id');
      expect(options?.maxThinkingTokens).toBe(16000);
      expect(typeof options?.canUseTool).toBe('function');
    });
  });

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

    it('should skip usage for subagent results', () => {
      const sdkMessage: any = {
        type: 'result',
        parent_tool_use_id: 'task-1',
        model: 'model-a',
        modelUsage: {
          'model-a': {
            inputTokens: 10,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 100,
          },
        },
      };

      const chunks = Array.from(transformSDKMessage(sdkMessage));
      expect(chunks).toHaveLength(0);
    });

    it('should emit usage chunk with computed tokens and clamped percentage', () => {
      const sdkMessage: any = {
        type: 'result',
        model: 'model-a',
        modelUsage: {
          'model-a': {
            inputTokens: 50,
            cacheCreationInputTokens: 25,
            cacheReadInputTokens: 25,
            contextWindow: 80,
          },
        },
      };

      const chunks = Array.from(transformSDKMessage(sdkMessage));
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual(expect.objectContaining({ type: 'usage' }));

      const usage = (chunks[0] as any).usage;
      expect(usage).toEqual(expect.objectContaining({
        model: 'model-a',
        inputTokens: 50,
        cacheCreationInputTokens: 25,
        cacheReadInputTokens: 25,
        contextTokens: 100,
        contextWindow: 80,
        percentage: 100,
      }));
    });

    it('should prefer message model when selecting usage entry', () => {
      const sdkMessage: any = {
        type: 'result',
        model: 'model-a',
        modelUsage: {
          'model-a': {
            inputTokens: 10,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 100,
          },
          'model-b': {
            inputTokens: 200,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 2000,
          },
        },
      };

      const chunks = Array.from(transformSDKMessage(sdkMessage));
      expect(chunks).toHaveLength(1);
      expect((chunks[0] as any).usage.model).toBe('model-a');
      expect((chunks[0] as any).usage.contextTokens).toBe(10);
    });

    it('should select highest usage entry when message model is missing and no intendedModel', () => {
      const sdkMessage: any = {
        type: 'result',
        modelUsage: {
          'model-a': {
            inputTokens: 10,
            cacheCreationInputTokens: 10,
            cacheReadInputTokens: 0,
            contextWindow: 100,
          },
          'model-b': {
            inputTokens: 30,
            cacheCreationInputTokens: 10,
            cacheReadInputTokens: 10,
            contextWindow: 200,
          },
        },
      };

      const chunks = Array.from(transformSDKMessage(sdkMessage));
      expect(chunks).toHaveLength(1);
      expect((chunks[0] as any).usage.model).toBe('model-b');
      expect((chunks[0] as any).usage.contextTokens).toBe(50);
    });

    it('should prefer intendedModel over highest tokens when message.model is missing', () => {
      const sdkMessage: any = {
        type: 'result',
        // No message.model set - simulates SDK not providing it
        modelUsage: {
          'main-model': {
            inputTokens: 10,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 200000,
          },
          'subagent-model': {
            inputTokens: 100, // Higher tokens - would be picked without intendedModel
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 200000,
          },
        },
      };

      // Without intendedModel: picks subagent-model (higher tokens)
      const chunksWithoutIntended = Array.from(transformSDKMessage(sdkMessage));
      expect((chunksWithoutIntended[0] as any).usage.model).toBe('subagent-model');

      // With intendedModel: picks main-model (ignores subagent)
      const chunksWithIntended = Array.from(transformSDKMessage(sdkMessage, { intendedModel: 'main-model' }));
      expect(chunksWithIntended).toHaveLength(1);
      expect((chunksWithIntended[0] as any).usage.model).toBe('main-model');
      expect((chunksWithIntended[0] as any).usage.contextTokens).toBe(10);
    });

    it('should skip usage chunk when contextWindow is missing or zero', () => {
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

  describe('file hash hooks and diff data', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReset();
      (fs.statSync as jest.Mock).mockReset();
      (fs.readFileSync as jest.Mock).mockReset();

      mockPlugin = createMockPlugin({ permissionMode: 'yolo' });
      service = new ClaudianService(mockPlugin, createMockMcpManager());
      service.setFileEditTracker({
        cancelFileEdit: jest.fn(),
        markFileBeingEdited: jest.fn().mockResolvedValue(undefined),
        trackEditedFile: jest.fn().mockResolvedValue(undefined),
      });
      (service as any).vaultPath = '/test/vault/path';
    });

    it('captures original content and computes diff for small file', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 10 });
      (fs.readFileSync as jest.Mock)
        .mockReturnValueOnce('old')
        .mockReturnValueOnce('new');

      // Create hooks using the exported functions
      const originalContents = new Map<string, DiffContentEntry>();
      const pendingDiffData = new Map<string, ToolDiffData>();
      const vaultPath = '/test/vault/path';

      const preHook = createFileHashPreHook(vaultPath, originalContents);
      const postHook = createFileHashPostHook(vaultPath, originalContents, pendingDiffData);

      await preHook.hooks[0]({ tool_name: 'Write', tool_input: { file_path: 'note.md' } } as any, 'tool-1', {} as any);
      await postHook.hooks[0]({ tool_name: 'Write', tool_input: { file_path: 'note.md' }, tool_result: {} } as any, 'tool-1', {} as any);

      const diff = pendingDiffData.get('tool-1');
      expect(diff).toEqual({ filePath: 'note.md', originalContent: 'old', newContent: 'new' });
    });

    it('skips diff when original file is too large', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 200 * 1024 });

      // Create hooks using the exported functions
      const originalContents = new Map<string, DiffContentEntry>();
      const pendingDiffData = new Map<string, ToolDiffData>();
      const vaultPath = '/test/vault/path';

      const preHook = createFileHashPreHook(vaultPath, originalContents);
      const postHook = createFileHashPostHook(vaultPath, originalContents, pendingDiffData);

      await preHook.hooks[0]({ tool_name: 'Edit', tool_input: { file_path: 'big.md' } } as any, 'tool-big', {} as any);
      await postHook.hooks[0]({ tool_name: 'Edit', tool_input: { file_path: 'big.md' }, tool_result: {} } as any, 'tool-big', {} as any);

      const diff = pendingDiffData.get('tool-big');
      expect(diff).toEqual({ filePath: 'big.md', skippedReason: 'too_large' });
    });

    it('marks diff unavailable when edited file is missing', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 10 });

      // Create hooks using the exported functions
      const originalContents = new Map<string, DiffContentEntry>();
      const pendingDiffData = new Map<string, ToolDiffData>();
      const vaultPath = '/test/vault/path';

      const preHook = createFileHashPreHook(vaultPath, originalContents);
      const postHook = createFileHashPostHook(vaultPath, originalContents, pendingDiffData);

      await preHook.hooks[0]({ tool_name: 'Write', tool_input: { file_path: 'new.md' } } as any, 'tool-new', {} as any);
      await postHook.hooks[0]({ tool_name: 'Write', tool_input: { file_path: 'new.md' }, tool_result: {} } as any, 'tool-new', {} as any);

      const diff = pendingDiffData.get('tool-new');
      expect(diff).toEqual({ filePath: 'new.md', skippedReason: 'unavailable' });
    });
  });

  describe('remaining business branches', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (service as any).resolvedClaudePath = '/mock/claude';
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
      for await (const c of service.query('Hi', undefined, history)) chunks.push(c);

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
      for await (const c of service.query('Hi')) chunks.push(c);

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

    it('handles image read errors and path resolution branches', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockImplementation(() => { throw new Error('boom'); });

      const base64 = readImageAttachmentBase64(mockPlugin.app, { filePath: 'x.png' } as any, '/test/vault');
      expect(base64).toBeNull();

      expect(resolveImageFilePath('/abs.png', '/test/vault')).toBe('/abs.png');
      expect(resolveImageFilePath('rel.png', null)).toBeNull();
    });

    it('yields error when SDK query throws inside queryViaSDK', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdk = require('@anthropic-ai/claude-agent-sdk');
      const spy = jest.spyOn(sdk, 'query').mockImplementation(() => { throw new Error('boom'); });

      const chunks: any[] = [];
      for await (const c of service.query('Hi')) chunks.push(c);

      expect(chunks.some((c) => c.type === 'error' && c.content.includes('boom'))).toBe(true);
      spy.mockRestore();
    });

    it('allows pre-approved actions in safe mode callback', async () => {
      mockPlugin = createMockPlugin({ permissionMode: 'normal', permissions: [
        { toolName: 'Read', pattern: '/test/file.md', approvedAt: Date.now(), scope: 'always' },
      ] });
      service = new ClaudianService(mockPlugin, createMockMcpManager());

      const canUse = (service as any).createUnifiedToolCallback('normal');
      const res = await canUse('Read', { file_path: '/test/file.md' }, {});
      expect(res.behavior).toBe('allow');
    });

    it('returns continue for non-file tools in vault hook and null for unknown paths', async () => {
      // Create vault restriction hook using the exported function
      const hook = createVaultRestrictionHook({
        getPathAccessType: () => 'vault',
      });
      const res = await hook.hooks[0]({ tool_name: 'WebSearch', tool_input: {} } as any, 't1', {} as any);
      expect((res as any).continue).toBe(true);

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

    it('stores null original content when pre-hook stat fails', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.statSync as jest.Mock).mockImplementation(() => { throw new Error('boom'); });

      // Create hooks using the exported functions
      const originalContents = new Map<string, DiffContentEntry>();
      const pendingDiffData = new Map<string, ToolDiffData>();
      const vaultPath = '/test/vault/path';

      const preHook = createFileHashPreHook(vaultPath, originalContents);
      await preHook.hooks[0]({ tool_name: 'Write', tool_input: { file_path: 'bad.md' } } as any, 'tool-bad', {} as any);

      expect(originalContents.get('tool-bad')?.content).toBeNull();

      const postHook = createFileHashPostHook(vaultPath, originalContents, pendingDiffData);
      await postHook.hooks[0]({ tool_name: 'Write', tool_input: { file_path: 'bad.md' }, tool_result: {} } as any, 'tool-bad', {} as any);
      expect(pendingDiffData.get('tool-bad')).toEqual({ filePath: 'bad.md', skippedReason: 'unavailable' });
    });

    it('skips diff when post-hook lacks original entry or hits read error', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 10 });
      (fs.readFileSync as jest.Mock).mockReturnValueOnce('new');

      // Create hooks using the exported functions
      const originalContents = new Map<string, DiffContentEntry>();
      const pendingDiffData = new Map<string, ToolDiffData>();
      const vaultPath = '/test/vault/path';

      const postHook = createFileHashPostHook(vaultPath, originalContents, pendingDiffData);
      await postHook.hooks[0]({ tool_name: 'Write', tool_input: { file_path: 'no-orig.md' }, tool_result: {} } as any, 'tool-no-orig', {} as any);
      expect(pendingDiffData.get('tool-no-orig')).toEqual({ filePath: 'no-orig.md', skippedReason: 'unavailable' });

      // Now force read error in post-hook
      originalContents.set('tool-read-err', { filePath: 'err.md', content: '' });
      (fs.readFileSync as jest.Mock).mockImplementation(() => { throw new Error('boom'); });

      await postHook.hooks[0]({ tool_name: 'Write', tool_input: { file_path: 'err.md' }, tool_result: {} } as any, 'tool-read-err', {} as any);
      expect(pendingDiffData.get('tool-read-err')).toEqual({ filePath: 'err.md', skippedReason: 'unavailable' });
    });

    it('marks too_large when post-hook sees large new file', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      // Create hooks using the exported functions
      const originalContents = new Map<string, DiffContentEntry>();
      const pendingDiffData = new Map<string, ToolDiffData>();
      const vaultPath = '/test/vault/path';

      const preHook = createFileHashPreHook(vaultPath, originalContents);
      await preHook.hooks[0]({ tool_name: 'Write', tool_input: { file_path: 'large.md' } } as any, 'tool-large', {} as any);

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.statSync as jest.Mock).mockReturnValue({ size: 200 * 1024 });

      const postHook = createFileHashPostHook(vaultPath, originalContents, pendingDiffData);
      await postHook.hooks[0]({ tool_name: 'Write', tool_input: { file_path: 'large.md' }, tool_result: {} } as any, 'tool-large', {} as any);

      expect(pendingDiffData.get('tool-large')).toEqual({ filePath: 'large.md', skippedReason: 'too_large' });
    });
  });
});
