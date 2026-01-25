/**
 * Tests for SDK Session Parser - parsing Claude Agent SDK native session files.
 */

import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';

import {
  deleteSDKSession,
  encodeVaultPathForSDK,
  getSDKProjectsPath,
  getSDKSessionPath,
  isValidSessionId,
  loadSDKSessionMessages,
  parseSDKMessageToChat,
  readSDKSession,
  type SDKNativeMessage,
  sdkSessionExists,
} from '@/utils/sdkSession';

// Mock fs, fs/promises, and os modules
jest.mock('fs', () => ({
  existsSync: jest.fn(),
}));
jest.mock('fs/promises');
jest.mock('os');

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockFsPromises = fsPromises as jest.Mocked<typeof fsPromises>;
const mockOs = os as jest.Mocked<typeof os>;

describe('sdkSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOs.homedir.mockReturnValue('/Users/test');
  });

  describe('encodeVaultPathForSDK', () => {
    it('encodes vault path by replacing all non-alphanumeric chars with dash', () => {
      const encoded = encodeVaultPathForSDK('/Users/test/vault');
      // SDK replaces ALL non-alphanumeric characters with `-`
      expect(encoded).toBe('-Users-test-vault');
    });

    it('handles paths with spaces and special characters', () => {
      const encoded = encodeVaultPathForSDK("/Users/test/My Vault's~Data");
      expect(encoded).toBe('-Users-test-My-Vault-s-Data');
    });

    it('handles Unicode characters (Chinese, Japanese, etc.)', () => {
      // Unicode characters should be replaced with `-` to match SDK behavior
      const encoded = encodeVaultPathForSDK('/Volumes/[Work]弘毅之鹰/学习/东京大学/2025年 秋');
      // All non-alphanumeric (including Chinese, brackets) become `-`
      expect(encoded).toBe('-Volumes--Work--------------2025---');
      // Verify only ASCII alphanumeric and dash remain
      expect(encoded).toMatch(/^[a-zA-Z0-9-]+$/);
    });

    it('handles brackets and other special characters', () => {
      const encoded = encodeVaultPathForSDK('/Users/test/[my-vault](notes)');
      expect(encoded).toBe('-Users-test--my-vault--notes-');
      expect(encoded).not.toContain('[');
      expect(encoded).not.toContain(']');
      expect(encoded).not.toContain('(');
      expect(encoded).not.toContain(')');
    });

    it('produces consistent encoding', () => {
      const path1 = '/Users/test/my-vault';
      const encoded1 = encodeVaultPathForSDK(path1);
      const encoded2 = encodeVaultPathForSDK(path1);
      expect(encoded1).toBe(encoded2);
    });

    it('produces different encodings for different paths', () => {
      const encoded1 = encodeVaultPathForSDK('/Users/test/vault1');
      const encoded2 = encodeVaultPathForSDK('/Users/test/vault2');
      expect(encoded1).not.toBe(encoded2);
    });

    it('handles backslashes for Windows compatibility', () => {
      // Test that backslashes are replaced (Windows path separators)
      // Note: path.resolve may modify the input, so we check the output contains no backslashes
      const encoded = encodeVaultPathForSDK('C:\\Users\\test\\vault');
      expect(encoded).not.toContain('\\');
      expect(encoded).toContain('-Users-test-vault');
    });

    it('replaces colons for Windows drive letters', () => {
      // Windows paths have colons after drive letter
      const encoded = encodeVaultPathForSDK('C:\\Users\\test\\vault');
      expect(encoded).not.toContain(':');
    });
  });

  describe('getSDKProjectsPath', () => {
    it('returns path under home directory', () => {
      const projectsPath = getSDKProjectsPath();
      expect(projectsPath).toBe('/Users/test/.claude/projects');
    });
  });

  describe('isValidSessionId', () => {
    it('accepts valid UUID-style session IDs', () => {
      expect(isValidSessionId('abc123')).toBe(true);
      expect(isValidSessionId('session-123')).toBe(true);
      expect(isValidSessionId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
      expect(isValidSessionId('test_session_id')).toBe(true);
    });

    it('rejects empty or too long session IDs', () => {
      expect(isValidSessionId('')).toBe(false);
      expect(isValidSessionId('a'.repeat(129))).toBe(false);
    });

    it('rejects path traversal attempts', () => {
      expect(isValidSessionId('../etc/passwd')).toBe(false);
      expect(isValidSessionId('..\\windows\\system32')).toBe(false);
      expect(isValidSessionId('foo/../bar')).toBe(false);
      expect(isValidSessionId('session/subdir')).toBe(false);
      expect(isValidSessionId('session\\subdir')).toBe(false);
    });

    it('rejects special characters', () => {
      expect(isValidSessionId('session.jsonl')).toBe(false);
      expect(isValidSessionId('session:123')).toBe(false);
      expect(isValidSessionId('session@host')).toBe(false);
    });
  });

  describe('getSDKSessionPath', () => {
    it('constructs correct session file path', () => {
      const sessionPath = getSDKSessionPath('/Users/test/vault', 'session-123');
      expect(sessionPath).toContain('.claude/projects');
      expect(sessionPath).toContain('session-123.jsonl');
    });

    it('throws error for path traversal attempts', () => {
      expect(() => getSDKSessionPath('/Users/test/vault', '../etc/passwd')).toThrow('Invalid session ID');
      expect(() => getSDKSessionPath('/Users/test/vault', 'foo/../bar')).toThrow('Invalid session ID');
      expect(() => getSDKSessionPath('/Users/test/vault', 'session/subdir')).toThrow('Invalid session ID');
    });

    it('throws error for empty session ID', () => {
      expect(() => getSDKSessionPath('/Users/test/vault', '')).toThrow('Invalid session ID');
    });
  });

  describe('sdkSessionExists', () => {
    it('returns true when session file exists', () => {
      mockExistsSync.mockReturnValue(true);

      const exists = sdkSessionExists('/Users/test/vault', 'session-abc');

      expect(exists).toBe(true);
    });

    it('returns false when session file does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const exists = sdkSessionExists('/Users/test/vault', 'session-xyz');

      expect(exists).toBe(false);
    });

    it('returns false on error', () => {
      mockExistsSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const exists = sdkSessionExists('/Users/test/vault', 'session-err');

      expect(exists).toBe(false);
    });
  });

  describe('deleteSDKSession', () => {
    it('deletes session file when it exists', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.unlink.mockResolvedValue(undefined);

      await deleteSDKSession('/Users/test/vault', 'session-abc');

      expect(mockFsPromises.unlink).toHaveBeenCalledWith(
        '/Users/test/.claude/projects/-Users-test-vault/session-abc.jsonl'
      );
    });

    it('does nothing when session file does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      await deleteSDKSession('/Users/test/vault', 'nonexistent');

      expect(mockFsPromises.unlink).not.toHaveBeenCalled();
    });

    it('fails silently when unlink throws', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.unlink.mockRejectedValue(new Error('Permission denied'));

      // Should not throw
      await expect(deleteSDKSession('/Users/test/vault', 'session-err')).resolves.toBeUndefined();
    });

    it('does nothing for invalid session ID', async () => {
      await deleteSDKSession('/Users/test/vault', '../invalid');

      expect(mockFsPromises.unlink).not.toHaveBeenCalled();
    });
  });

  describe('readSDKSession', () => {
    it('returns empty result when file does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await readSDKSession('/Users/test/vault', 'nonexistent');

      expect(result.messages).toEqual([]);
      expect(result.skippedLines).toBe(0);
      expect(result.error).toBeUndefined();
    });

    it('parses valid JSONL file', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"user","uuid":"u1","message":{"content":"Hello"}}',
        '{"type":"assistant","uuid":"a1","message":{"content":"Hi there"}}',
      ].join('\n'));

      const result = await readSDKSession('/Users/test/vault', 'session-1');

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].type).toBe('user');
      expect(result.messages[1].type).toBe('assistant');
      expect(result.skippedLines).toBe(0);
    });

    it('skips invalid JSON lines and reports count', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"user","uuid":"u1","message":{"content":"Hello"}}',
        'invalid json line',
        '{"type":"assistant","uuid":"a1","message":{"content":"Hi"}}',
      ].join('\n'));

      const result = await readSDKSession('/Users/test/vault', 'session-2');

      expect(result.messages).toHaveLength(2);
      expect(result.skippedLines).toBe(1);
    });

    it('handles empty lines', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"user","uuid":"u1","message":{"content":"Test"}}',
        '',
        '   ',
        '{"type":"assistant","uuid":"a1","message":{"content":"Response"}}',
      ].join('\n'));

      const result = await readSDKSession('/Users/test/vault', 'session-3');

      expect(result.messages).toHaveLength(2);
    });

    it('returns error on read failure', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockRejectedValue(new Error('Read error'));

      const result = await readSDKSession('/Users/test/vault', 'session-err');

      expect(result.messages).toEqual([]);
      expect(result.error).toBe('Read error');
    });
  });

  describe('parseSDKMessageToChat', () => {
    it('converts user message with string content', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'user-123',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: 'What is the weather?',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.id).toBe('user-123');
      expect(chatMsg!.role).toBe('user');
      expect(chatMsg!.content).toBe('What is the weather?');
      expect(chatMsg!.timestamp).toBe(new Date('2024-01-15T10:30:00Z').getTime());
    });

    it('converts assistant message with text content blocks', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'assistant',
        uuid: 'asst-456',
        timestamp: '2024-01-15T10:31:00Z',
        message: {
          content: [
            { type: 'text', text: 'The weather is sunny.' },
            { type: 'text', text: 'Temperature is 72°F.' },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.id).toBe('asst-456');
      expect(chatMsg!.role).toBe('assistant');
      expect(chatMsg!.content).toBe('The weather is sunny.\nTemperature is 72°F.');
    });

    it('extracts tool calls from content blocks', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'assistant',
        uuid: 'asst-tool',
        timestamp: '2024-01-15T10:32:00Z',
        message: {
          content: [
            { type: 'text', text: 'Let me search for that.' },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'WebSearch',
              input: { query: 'weather today' },
            },
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'Sunny, 72°F',
            },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.toolCalls).toHaveLength(1);
      expect(chatMsg!.toolCalls![0].id).toBe('tool-1');
      expect(chatMsg!.toolCalls![0].name).toBe('WebSearch');
      expect(chatMsg!.toolCalls![0].input).toEqual({ query: 'weather today' });
      expect(chatMsg!.toolCalls![0].status).toBe('completed');
      expect(chatMsg!.toolCalls![0].result).toBe('Sunny, 72°F');
    });

    it('marks tool call as error when is_error is true', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'assistant',
        uuid: 'asst-err',
        timestamp: '2024-01-15T10:33:00Z',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-err',
              name: 'Bash',
              input: { command: 'invalid' },
            },
            {
              type: 'tool_result',
              tool_use_id: 'tool-err',
              content: 'Command not found',
              is_error: true,
            },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg!.toolCalls![0].status).toBe('error');
    });

    it('extracts thinking content blocks', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'assistant',
        uuid: 'asst-think',
        timestamp: '2024-01-15T10:34:00Z',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me consider this...' },
            { type: 'text', text: 'Here is my answer.' },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg!.contentBlocks).toHaveLength(2);

      const thinkingBlock = chatMsg!.contentBlocks![0];
      expect(thinkingBlock.type).toBe('thinking');
      // Type narrowing for thinking block content check
      expect(thinkingBlock.type === 'thinking' && thinkingBlock.content).toBe('Let me consider this...');

      expect(chatMsg!.contentBlocks![1].type).toBe('text');
    });

    it('returns null for system messages', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'system',
        uuid: 'sys-1',
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).toBeNull();
    });

    it('returns null for result messages', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'result',
        uuid: 'res-1',
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).toBeNull();
    });

    it('returns null for file-history-snapshot messages', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'file-history-snapshot',
        uuid: 'fhs-1',
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).toBeNull();
    });

    it('generates ID when uuid is missing', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        timestamp: '2024-01-15T10:35:00Z',
        message: {
          content: 'No UUID message',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.id).toMatch(/^sdk-/);
    });

    it('uses current time when timestamp is missing', () => {
      const before = Date.now();
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'no-time',
        message: {
          content: 'No timestamp',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      const after = Date.now();

      expect(chatMsg!.timestamp).toBeGreaterThanOrEqual(before);
      expect(chatMsg!.timestamp).toBeLessThanOrEqual(after);
    });

    it('marks interrupt messages with isInterrupt flag', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'interrupt-1',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.isInterrupt).toBe(true);
      expect(chatMsg!.content).toBe('[Request interrupted by user]');
    });

    it('does not mark regular user messages as interrupt', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'user-regular',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: 'Hello, how are you?',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.isInterrupt).toBeUndefined();
    });

    it('marks rebuilt context messages with isRebuiltContext flag', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'rebuilt-1',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: 'User: hi\n\nAssistant: Hello!\n\nUser: how are you?',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.isRebuiltContext).toBe(true);
    });

    it('marks rebuilt context messages starting with Assistant', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'rebuilt-2',
        timestamp: '2024-01-15T10:31:00Z',
        message: {
          content: 'Assistant: Hello\n\nUser: Hi again',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.isRebuiltContext).toBe(true);
    });

    it('does not mark regular messages starting with User as rebuilt context', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'user-normal',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: 'User settings should be configurable',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.isRebuiltContext).toBeUndefined();
    });

    it('extracts displayContent from user message with current_note tag', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'user-note',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: 'Explain this file\n\n<current_note>\nnotes/test.md\n</current_note>',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.content).toBe('Explain this file\n\n<current_note>\nnotes/test.md\n</current_note>');
      expect(chatMsg!.displayContent).toBe('Explain this file');
    });

    it('extracts displayContent from user message with editor_selection tag', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'user-selection',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: 'Refactor this code\n\n<editor_selection path="src/main.ts">\nfunction foo() {}\n</editor_selection>',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.displayContent).toBe('Refactor this code');
    });

    it('extracts displayContent from user message with multiple context tags', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'user-multi',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: 'Update this\n\n<current_note>\ntest.md\n</current_note>\n\n<editor_selection path="test.md">\nselected\n</editor_selection>',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.displayContent).toBe('Update this');
    });

    it('does not set displayContent for plain user messages without XML context', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'user-plain',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: 'Just a regular question',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.displayContent).toBeUndefined();
    });
  });

  describe('loadSDKSessionMessages', () => {
    it('loads and converts all messages from session file', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"user","uuid":"u1","timestamp":"2024-01-15T10:00:00Z","message":{"content":"Hello"}}',
        '{"type":"assistant","uuid":"a1","timestamp":"2024-01-15T10:01:00Z","message":{"content":[{"type":"text","text":"Hi!"}]}}',
        '{"type":"system","uuid":"s1"}',
        '{"type":"user","uuid":"u2","timestamp":"2024-01-15T10:02:00Z","message":{"content":"Thanks"}}',
      ].join('\n'));

      const result = await loadSDKSessionMessages('/Users/test/vault', 'session-full');

      // Should have 3 messages (system skipped)
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toBe('Hello');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[1].content).toBe('Hi!');
      expect(result.messages[2].role).toBe('user');
      expect(result.messages[2].content).toBe('Thanks');
    });

    it('sorts messages by timestamp ascending', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"assistant","uuid":"a1","timestamp":"2024-01-15T10:01:00Z","message":{"content":[{"type":"text","text":"Second"}]}}',
        '{"type":"user","uuid":"u1","timestamp":"2024-01-15T10:00:00Z","message":{"content":"First"}}',
        '{"type":"user","uuid":"u2","timestamp":"2024-01-15T10:02:00Z","message":{"content":"Third"}}',
      ].join('\n'));

      const result = await loadSDKSessionMessages('/Users/test/vault', 'session-unordered');

      expect(result.messages[0].content).toBe('First');
      expect(result.messages[1].content).toBe('Second');
      expect(result.messages[2].content).toBe('Third');
    });

    it('returns empty result when session does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await loadSDKSessionMessages('/Users/test/vault', 'nonexistent');

      expect(result.messages).toEqual([]);
    });

    it('matches tool_result from user message to tool_use in assistant message', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"user","uuid":"u1","timestamp":"2024-01-15T10:00:00Z","message":{"content":"Search for cats"}}',
        '{"type":"assistant","uuid":"a1","timestamp":"2024-01-15T10:01:00Z","message":{"content":[{"type":"text","text":"Let me search"},{"type":"tool_use","id":"tool-1","name":"WebSearch","input":{"query":"cats"}}]}}',
        '{"type":"user","uuid":"u2","timestamp":"2024-01-15T10:02:00Z","toolUseResult":{},"message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"Found 10 results"}]}}',
        '{"type":"assistant","uuid":"a2","timestamp":"2024-01-15T10:03:00Z","message":{"content":[{"type":"text","text":"I found 10 results about cats."}]}}',
      ].join('\n'));

      const result = await loadSDKSessionMessages('/Users/test/vault', 'session-cross-tool');

      // Should have 2 messages (tool_result-only user skipped, assistant messages merged)
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content).toBe('Search for cats');
      // Merged assistant message has tool calls and combined content
      expect(result.messages[1].toolCalls).toHaveLength(1);
      expect(result.messages[1].toolCalls![0].id).toBe('tool-1');
      expect(result.messages[1].toolCalls![0].result).toBe('Found 10 results');
      expect(result.messages[1].toolCalls![0].status).toBe('completed');
      expect(result.messages[1].content).toContain('Let me search');
      expect(result.messages[1].content).toContain('I found 10 results about cats.');
    });

    it('skips user messages that are tool results', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"user","uuid":"u1","timestamp":"2024-01-15T10:00:00Z","message":{"content":"Hello"}}',
        '{"type":"assistant","uuid":"a1","timestamp":"2024-01-15T10:01:00Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}',
        '{"type":"user","uuid":"u2","timestamp":"2024-01-15T10:02:00Z","toolUseResult":{},"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"done"}]}}',
      ].join('\n'));

      const result = await loadSDKSessionMessages('/Users/test/vault', 'session-skip-tool-result');

      // Should have 2 messages (tool_result user skipped)
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toBe('Hello');
      expect(result.messages[1].role).toBe('assistant');
    });

    it('skips skill prompt injection messages (sourceToolUseID)', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"user","uuid":"u1","timestamp":"2024-01-15T10:00:00Z","message":{"content":"/commit"}}',
        '{"type":"assistant","uuid":"a1","timestamp":"2024-01-15T10:01:00Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Skill","input":{"skill":"commit"}}]}}',
        '{"type":"user","uuid":"u2","timestamp":"2024-01-15T10:02:00Z","toolUseResult":{},"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Launching skill: commit"}]}}',
        '{"type":"user","uuid":"u3","timestamp":"2024-01-15T10:02:01Z","sourceToolUseID":"t1","isMeta":true,"message":{"content":[{"type":"text","text":"## Your task\\n\\nCommit the changes..."}]}}',
        '{"type":"assistant","uuid":"a2","timestamp":"2024-01-15T10:03:00Z","message":{"content":[{"type":"text","text":"Committing the changes now."}]}}',
      ].join('\n'));

      const result = await loadSDKSessionMessages('/Users/test/vault', 'session-skip-skill');

      // Should have 2 messages: user query, merged assistant (tool_use + text merged together)
      // Skill prompt injection (u3) and tool result (u2) should be skipped
      // Consecutive assistant messages are merged
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toBe('/commit');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[1].toolCalls?.[0].name).toBe('Skill');
      expect(result.messages[1].content).toContain('Committing');
    });

    it('skips meta messages without sourceToolUseID', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"user","uuid":"u1","timestamp":"2024-01-15T10:00:00Z","message":{"content":"Hello"}}',
        '{"type":"user","uuid":"u2","timestamp":"2024-01-15T10:00:01Z","isMeta":true,"message":{"content":"System context injection"}}',
        '{"type":"assistant","uuid":"a1","timestamp":"2024-01-15T10:01:00Z","message":{"content":[{"type":"text","text":"Hi there!"}]}}',
      ].join('\n'));

      const result = await loadSDKSessionMessages('/Users/test/vault', 'session-skip-meta');

      // Should have 2 messages (meta message u2 skipped)
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toBe('Hello');
      expect(result.messages[1].role).toBe('assistant');
    });

    it('handles tool_result with error flag', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"assistant","uuid":"a1","timestamp":"2024-01-15T10:00:00Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"invalid"}}]}}',
        '{"type":"user","uuid":"u1","timestamp":"2024-01-15T10:01:00Z","toolUseResult":{},"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Command not found","is_error":true}]}}',
      ].join('\n'));

      const result = await loadSDKSessionMessages('/Users/test/vault', 'session-error-result');

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].toolCalls![0].status).toBe('error');
      expect(result.messages[0].toolCalls![0].result).toBe('Command not found');
    });
  });
});
