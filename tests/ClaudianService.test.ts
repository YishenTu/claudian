import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  setMockMessages,
  resetMockMessages,
  getLastOptions,
  getLastResponse,
} from '@anthropic-ai/claude-agent-sdk';

// Mock fs module
jest.mock('fs');

// Now import after all mocks are set up
import { ClaudianService } from '../src/ClaudianService';

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

// Create a mock plugin
function createMockPlugin(settings = {}) {
  const mockPlugin = {
    settings: {
      enableBlocklist: true,
      blockedCommands: [
        'rm -rf',
        'rm -r /',
        'chmod 777',
        'chmod -R 777',
        'mkfs',
        'dd if=',
        '> /dev/sd',
      ],
      showToolUse: true,
      approvedActions: [],
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
    service = new ClaudianService(mockPlugin);
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
      service = new ClaudianService(mockPlugin);

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

      for await (const _ of service.query('first')) {
        // drain
      }

      setMockMessages([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Second run' }] } },
        { type: 'result' },
      ]);

      for await (const _ of service.query('second')) {
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
      service = new ClaudianService(mockPlugin);

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
        blockedCommands: ['rm\\s+-rf', 'chmod\\s+7{3}'],
      });
      service = new ClaudianService(mockPlugin);

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
        blockedCommands: ['[invalid regex'],
      });
      service = new ClaudianService(mockPlugin);

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
      for await (const chunk of service.query('new message', history)) {
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

      for await (const _ of service.query('continue')) {
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

      for await (const _ of service.query('hello')) {
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
        const path = require('path');
        return path.resolve(p);
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
      const candidates = (service as any).extractPathCandidates('cat "../secret.txt" ./notes/file.md ~/vault/config');
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
        approvedActions: [],
      });
      service = new ClaudianService(mockPlugin);
    });

    it('should store session-scoped approved actions', async () => {
      // Approve an action with session scope
      await (service as any).approveAction('Bash', { command: 'ls -la' }, 'session');

      // Check if action is approved
      const isApproved = (service as any).isActionApproved('Bash', { command: 'ls -la' });
      expect(isApproved).toBe(true);
    });

    it('should clear session-scoped approvals on resetSession', async () => {
      await (service as any).approveAction('Bash', { command: 'ls -la' }, 'session');

      service.resetSession();

      const isApproved = (service as any).isActionApproved('Bash', { command: 'ls -la' });
      expect(isApproved).toBe(false);
    });

    it('should store permanent approved actions in settings', async () => {
      await (service as any).approveAction('Read', { file_path: '/test/file.md' }, 'always');

      expect(mockPlugin.settings.approvedActions.length).toBe(1);
      expect(mockPlugin.settings.approvedActions[0].toolName).toBe('Read');
      expect(mockPlugin.settings.approvedActions[0].pattern).toBe('/test/file.md');
    });

    it('should recognize permanently approved actions', async () => {
      mockPlugin.settings.approvedActions = [
        { toolName: 'Read', pattern: '/test/file.md', approvedAt: Date.now(), scope: 'always' },
      ];

      const isApproved = (service as any).isActionApproved('Read', { file_path: '/test/file.md' });
      expect(isApproved).toBe(true);
    });

    it('should match Bash commands exactly', async () => {
      await (service as any).approveAction('Bash', { command: 'ls -la' }, 'session');

      // Exact match should be approved
      expect((service as any).isActionApproved('Bash', { command: 'ls -la' })).toBe(true);

      // Different command should not be approved
      expect((service as any).isActionApproved('Bash', { command: 'ls -l' })).toBe(false);
    });

    it('should match file paths with prefix', async () => {
      mockPlugin.settings.approvedActions = [
        { toolName: 'Read', pattern: '/test/vault/', approvedAt: Date.now(), scope: 'always' },
      ];

      // Path starting with approved prefix should match
      expect((service as any).isActionApproved('Read', { file_path: '/test/vault/notes/file.md' })).toBe(true);

      // Path not starting with prefix should not match
      expect((service as any).isActionApproved('Read', { file_path: '/other/path/file.md' })).toBe(false);
    });

    it('should generate correct action patterns for different tools', () => {
      expect((service as any).getActionPattern('Bash', { command: 'git status' })).toBe('git status');
      expect((service as any).getActionPattern('Read', { file_path: '/test/file.md' })).toBe('/test/file.md');
      expect((service as any).getActionPattern('Write', { file_path: '/test/output.md' })).toBe('/test/output.md');
      expect((service as any).getActionPattern('Edit', { file_path: '/test/edit.md' })).toBe('/test/edit.md');
      expect((service as any).getActionPattern('Glob', { pattern: '**/*.md' })).toBe('**/*.md');
      expect((service as any).getActionPattern('Grep', { pattern: 'TODO' })).toBe('TODO');
    });

    it('should generate correct action descriptions', () => {
      expect((service as any).getActionDescription('Bash', { command: 'git status' })).toBe('Run command: git status');
      expect((service as any).getActionDescription('Read', { file_path: '/test/file.md' })).toBe('Read file: /test/file.md');
      expect((service as any).getActionDescription('Write', { file_path: '/test/output.md' })).toBe('Write to file: /test/output.md');
      expect((service as any).getActionDescription('Edit', { file_path: '/test/edit.md' })).toBe('Edit file: /test/edit.md');
      expect((service as any).getActionDescription('Glob', { pattern: '**/*.md' })).toBe('Search files matching: **/*.md');
      expect((service as any).getActionDescription('Grep', { pattern: 'TODO' })).toBe('Search content matching: TODO');
    });
  });

  describe('safe mode approvals', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockPlugin = createMockPlugin({ permissionMode: 'normal' });
      service = new ClaudianService(mockPlugin);
    });

    it('should deny when no approval callback is set', async () => {
      const canUse = (service as any).createSafeModeCallback();

      const result = await canUse('Bash', { command: 'ls' }, {});

      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('No approval handler available');
    });

    it('should allow and cache session approvals when user allows', async () => {
      const approvalCallback = jest.fn().mockResolvedValue('allow');
      service.setApprovalCallback(approvalCallback);
      const canUse = (service as any).createSafeModeCallback();

      const result = await canUse('Bash', { command: 'ls -la' }, {});

      expect(result.behavior).toBe('allow');
      expect(approvalCallback).toHaveBeenCalled();
      expect((service as any).sessionApprovedActions.some((a: any) => a.toolName === 'Bash')).toBe(true);
    });

    it('should persist always-allow approvals and save settings', async () => {
      const approvalCallback = jest.fn().mockResolvedValue('allow-always');
      service.setApprovalCallback(approvalCallback);
      const canUse = (service as any).createSafeModeCallback();
      const saveSpy = jest.spyOn(mockPlugin, 'saveSettings');

      const result = await canUse('Read', { file_path: '/test/file.md' }, {});

      expect(result.behavior).toBe('allow');
      expect(mockPlugin.settings.approvedActions.some((a: any) => a.toolName === 'Read' && a.pattern === '/test/file.md')).toBe(true);
      expect(saveSpy).toHaveBeenCalled();
    });

    it('should deny when user rejects approval', async () => {
      const approvalCallback = jest.fn().mockResolvedValue('deny');
      service.setApprovalCallback(approvalCallback);
      const canUse = (service as any).createSafeModeCallback();

      const result = await canUse('Bash', { command: 'rm -rf /' }, {});

      expect(result.behavior).toBe('deny');
      expect(result.message).toBe('User denied this action.');
    });

    it('should deny and interrupt when approval flow errors', async () => {
      const approvalCallback = jest.fn().mockRejectedValue(new Error('boom'));
      service.setApprovalCallback(approvalCallback);
      const canUse = (service as any).createSafeModeCallback();

      const result = await canUse('Read', { file_path: '/test/file.md' }, {});

      expect(result.behavior).toBe('deny');
      expect(result.interrupt).toBe(true);
      expect(result.message).toBe('Approval request failed.');
    });
  });

  describe('session expiration recovery', () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
    });

    it('should detect session expired errors', () => {
      expect((service as any).isSessionExpiredError(new Error('Session expired'))).toBe(true);
      expect((service as any).isSessionExpiredError(new Error('session not found'))).toBe(true);
      expect((service as any).isSessionExpiredError(new Error('invalid session'))).toBe(true);
      expect((service as any).isSessionExpiredError(new Error('Resume failed'))).toBe(true);
    });

    it('should not detect non-session errors as session errors', () => {
      expect((service as any).isSessionExpiredError(new Error('Network error'))).toBe(false);
      expect((service as any).isSessionExpiredError(new Error('Rate limited'))).toBe(false);
      expect((service as any).isSessionExpiredError(new Error('Invalid API key'))).toBe(false);
    });

    it('should build context from conversation history', () => {
      const messages = [
        { id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant', content: 'Hi there!', timestamp: Date.now() },
        { id: 'msg-3', role: 'user', content: 'How are you?', timestamp: Date.now() },
      ];

      const context = (service as any).buildContextFromHistory(messages);

      expect(context).toContain('User: Hello');
      expect(context).toContain('Assistant: Hi there!');
      expect(context).toContain('User: How are you?');
    });

    it('should include tool call info in context', () => {
      const messages = [
        { id: 'msg-1', role: 'user', content: 'Read a file', timestamp: Date.now() },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Reading file...',
          timestamp: Date.now(),
          toolCalls: [
            { id: 'tool-1', name: 'Read', input: { file_path: '/test.md' }, status: 'completed', result: 'File contents' },
          ],
        },
      ];

      const context = (service as any).buildContextFromHistory(messages);

      expect(context).toContain('[Tool Read status=completed]');
      expect(context).toContain('File contents');
    });

    it('should include context files in rebuilt history', () => {
      const messages = [
        { id: 'msg-1', role: 'user', content: 'Edit this file', timestamp: Date.now(), contextFiles: ['notes/file.md'] },
      ];

      const context = (service as any).buildContextFromHistory(messages);

      expect(context).toContain('Context files: [notes/file.md]');
    });

    it('should truncate long tool results', () => {
      const longResult = 'x'.repeat(1000);
      const truncated = (service as any).truncateToolResultForContext(longResult, 100);

      expect(truncated.length).toBeLessThan(longResult.length);
      expect(truncated).toContain('(truncated)');
    });

    it('should not truncate short tool results', () => {
      const shortResult = 'Short result';
      const result = (service as any).truncateToolResultForContext(shortResult, 100);

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

      jest.spyOn(service as any, 'queryViaSDK').mockImplementation(async function* (prompt: string) {
        prompts.push(prompt);
        if (prompts.length === 1) {
          throw new Error('Session expired');
        }
        yield { type: 'text', content: 'Recovered' };
      });

      const history = [
        { id: 'msg-1', role: 'user' as const, content: 'First question', timestamp: Date.now() },
        {
          id: 'msg-2',
          role: 'assistant' as const,
          content: 'Answer',
          timestamp: Date.now(),
          toolCalls: [
            { id: 'tool-1', name: 'Read', input: { file_path: '/test/vault/path/file.md' }, status: 'completed', result: 'file content' },
          ],
        },
        { id: 'msg-3', role: 'user' as const, content: 'Follow up', timestamp: Date.now(), contextFiles: ['note.md'] },
      ];

      const chunks: any[] = [];
      for await (const chunk of service.query('Follow up', history)) {
        chunks.push(chunk);
      }

      expect(prompts[0]).toBe('Follow up');
      expect(prompts[1]).toContain('User: First question');
      expect(prompts[1]).toContain('Assistant: Answer');
      expect(prompts[1]).toContain('Context files: [note.md]');
      expect(chunks.some((c) => c.type === 'text' && c.content === 'Recovered')).toBe(true);
      expect(service.getSessionId()).toBeNull();
    });
  });
});
