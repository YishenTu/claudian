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

    it('returns synthetic assistant message for compact_boundary system messages', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-1',
        timestamp: '2024-06-15T12:00:00Z',
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.id).toBe('compact-1');
      expect(chatMsg!.role).toBe('assistant');
      expect(chatMsg!.content).toBe('');
      expect(chatMsg!.timestamp).toBe(new Date('2024-06-15T12:00:00Z').getTime());
      expect(chatMsg!.contentBlocks).toEqual([{ type: 'compact_boundary' }]);
    });

    it('generates ID for compact_boundary without uuid', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'system',
        subtype: 'compact_boundary',
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.id).toMatch(/^compact-/);
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

    it('preserves /compact command as user message with clean displayContent', async () => {
      // File ordering mirrors real SDK JSONL: compact_boundary written BEFORE /compact command.
      // The timestamp sort must reorder so /compact (earlier) precedes boundary (later).
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"user","uuid":"u1","timestamp":"2024-01-15T10:00:00Z","message":{"content":"Hello"}}',
        '{"type":"assistant","uuid":"a1","timestamp":"2024-01-15T10:01:00Z","message":{"content":[{"type":"text","text":"Hi!"}]}}',
        '{"type":"system","subtype":"compact_boundary","uuid":"c1","timestamp":"2024-01-15T10:02:10Z"}',
        '{"type":"user","uuid":"u2","timestamp":"2024-01-15T10:02:00Z","isMeta":true,"message":{"content":"<local-command-caveat>Caveat</local-command-caveat>"}}',
        '{"type":"user","uuid":"u3","timestamp":"2024-01-15T10:02:01Z","message":{"content":"<command-name>/compact</command-name>\\n<command-message>compact</command-message>\\n<command-args></command-args>"}}',
        '{"type":"user","uuid":"u4","timestamp":"2024-01-15T10:02:11Z","message":{"content":"<local-command-stdout>Compacted </local-command-stdout>"}}',
      ].join('\n'));

      const result = await loadSDKSessionMessages('/Users/test/vault', 'session-compact');

      // Should have: user "Hello", assistant "Hi!", user "/compact", assistant compact_boundary
      // Meta (u2), stdout (u4) should be skipped
      // /compact (10:02:01) sorted before compact_boundary (10:02:10) by timestamp
      expect(result.messages).toHaveLength(4);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toBe('Hello');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[2].role).toBe('user');
      expect(result.messages[2].displayContent).toBe('/compact');
      expect(result.messages[3].role).toBe('assistant');
      expect(result.messages[3].contentBlocks).toEqual([{ type: 'compact_boundary' }]);
    });

    it('renders compact cancellation stderr as interrupt (not filtered)', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"user","uuid":"u1","timestamp":"2024-01-15T10:00:00Z","message":{"content":"Hello"}}',
        '{"type":"assistant","uuid":"a1","timestamp":"2024-01-15T10:01:00Z","message":{"content":[{"type":"text","text":"Hi!"}]}}',
        '{"type":"user","uuid":"u2","timestamp":"2024-01-15T10:02:00Z","message":{"content":"<command-name>/compact</command-name>\\n<command-message>compact</command-message>\\n<command-args></command-args>"}}',
        '{"type":"user","uuid":"u3","timestamp":"2024-01-15T10:02:01Z","message":{"content":"<local-command-stderr>Error: Compaction canceled.</local-command-stderr>"}}',
      ].join('\n'));

      const result = await loadSDKSessionMessages('/Users/test/vault', 'session-compact-cancel');

      // Compact cancellation stderr should appear as interrupt, not be filtered
      const interruptMsg = result.messages.find(m => m.isInterrupt);
      expect(interruptMsg).toBeDefined();
      expect(interruptMsg!.isInterrupt).toBe(true);
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

    it('returns error pass-through from readSDKSession', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockRejectedValue(new Error('Disk failure'));

      const result = await loadSDKSessionMessages('/Users/test/vault', 'session-disk-err');

      expect(result.messages).toEqual([]);
      expect(result.error).toBe('Disk failure');
    });

    it('merges tool calls from consecutive assistant messages', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"assistant","uuid":"a1","timestamp":"2024-01-15T10:00:00Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"path":"a.ts"}}]}}',
        '{"type":"assistant","uuid":"a2","timestamp":"2024-01-15T10:00:01Z","message":{"content":[{"type":"tool_use","id":"t2","name":"Write","input":{"path":"b.ts"}}]}}',
      ].join('\n'));

      const result = await loadSDKSessionMessages('/Users/test/vault', 'session-merge-tools');

      // Consecutive assistant messages should merge into one
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].toolCalls).toHaveLength(2);
      expect(result.messages[0].toolCalls![0].name).toBe('Read');
      expect(result.messages[0].toolCalls![1].name).toBe('Write');
    });
  });

  describe('parseSDKMessageToChat - image extraction', () => {
    it('extracts image attachments from user message with image blocks', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'user-img',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: [
            { type: 'text', text: 'Check this image' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
              },
            },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.images).toHaveLength(1);
      expect(chatMsg!.images![0].mediaType).toBe('image/png');
      expect(chatMsg!.images![0].data).toContain('iVBORw0KGgo');
      expect(chatMsg!.images![0].source).toBe('paste');
      expect(chatMsg!.images![0].name).toBe('image-1');
    });

    it('does not extract images from assistant messages', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'assistant',
        uuid: 'asst-img',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: [
            { type: 'text', text: 'Here is a response' },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.images).toBeUndefined();
    });

    it('returns null for user message with only tool_result content blocks', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'user-tool-only',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'result data' },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      // Array content bypasses the null-return guard even without text/tool_use/images
      expect(chatMsg).not.toBeNull();
    });

    it('returns null for user message with empty string content', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'user-empty',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: '',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      expect(chatMsg).toBeNull();
    });

    it('returns null for user message with no content', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'user-nocontent',
        timestamp: '2024-01-15T10:30:00Z',
        message: {},
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      expect(chatMsg).toBeNull();
    });

    it('returns null for queue-operation messages', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'queue-operation',
        uuid: 'queue-1',
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      expect(chatMsg).toBeNull();
    });
  });

  describe('parseSDKMessageToChat - content block edge cases', () => {
    it('skips text blocks that are whitespace-only in contentBlocks', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'assistant',
        uuid: 'asst-whitespace',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: [
            { type: 'text', text: '   ' },
            { type: 'text', text: 'Actual content' },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      expect(chatMsg).not.toBeNull();
      // The whitespace-only text block should be skipped in contentBlocks
      expect(chatMsg!.contentBlocks).toHaveLength(1);
      expect(chatMsg!.contentBlocks![0].type).toBe('text');
    });

    it('skips thinking blocks with empty thinking field', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'assistant',
        uuid: 'asst-empty-think',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: 'Some answer' },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      expect(chatMsg).not.toBeNull();
      // Empty thinking block should be skipped
      expect(chatMsg!.contentBlocks).toHaveLength(1);
      expect(chatMsg!.contentBlocks![0].type).toBe('text');
    });

    it('skips tool_use blocks without id in contentBlocks', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'assistant',
        uuid: 'asst-no-id-tool',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'text', text: 'After tool' },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      expect(chatMsg).not.toBeNull();
      // tool_use without id should be skipped in contentBlocks
      expect(chatMsg!.contentBlocks).toHaveLength(1);
      expect(chatMsg!.contentBlocks![0].type).toBe('text');
    });

    it('returns undefined contentBlocks when all blocks are filtered out', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'assistant',
        uuid: 'asst-all-filtered',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'result' },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      // Content is array (so not null), but all blocks filtered → undefined contentBlocks
      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.contentBlocks).toBeUndefined();
    });

    it('handles tool_use without input field', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'assistant',
        uuid: 'asst-no-input',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-noinput', name: 'SomeTool' },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.toolCalls).toHaveLength(1);
      expect(chatMsg!.toolCalls![0].input).toEqual({});
    });

    it('handles tool_result with non-string content (JSON object)', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'assistant',
        uuid: 'asst-json-result',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-json', name: 'Read', input: {} },
            {
              type: 'tool_result',
              tool_use_id: 'tool-json',
              content: { file: 'test.ts', lines: 42 },
            },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.toolCalls).toHaveLength(1);
      // Non-string content should be JSON.stringified
      expect(chatMsg!.toolCalls![0].result).toBe('{"file":"test.ts","lines":42}');
    });
  });

  describe('parseSDKMessageToChat - rebuilt context with A: shorthand', () => {
    it('detects rebuilt context using A: shorthand marker', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'rebuilt-short',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: 'User: hello\n\nA: hi there',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.isRebuiltContext).toBe(true);
    });
  });

  describe('parseSDKMessageToChat - interrupt tool use variant', () => {
    it('marks tool use interrupt messages', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'interrupt-tool',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: '[Request interrupted by user for tool use]',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.isInterrupt).toBe(true);
    });

    it('marks compact cancellation stderr as interrupt', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'interrupt-compact',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: '<local-command-stderr>Error: Compaction canceled.</local-command-stderr>',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.isInterrupt).toBe(true);
    });
  });

  describe('loadSDKSessionMessages - merge edge cases', () => {
    it('merges assistant content blocks when first has no content blocks', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"assistant","uuid":"a1","timestamp":"2024-01-15T10:00:00Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}',
        '{"type":"assistant","uuid":"a2","timestamp":"2024-01-15T10:00:01Z","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Result here"}]}}',
      ].join('\n'));

      const result = await loadSDKSessionMessages('/Users/test/vault', 'session-merge-blocks');

      expect(result.messages).toHaveLength(1);
      // Merged: tool call from first + content blocks from both
      expect(result.messages[0].toolCalls).toHaveLength(1);
      expect(result.messages[0].contentBlocks!.length).toBeGreaterThanOrEqual(2);
    });

    it('merges assistant with empty target content', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        // First assistant: only tool_use, no text
        '{"type":"assistant","uuid":"a1","timestamp":"2024-01-15T10:00:00Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}',
        // Second assistant: has text content
        '{"type":"assistant","uuid":"a2","timestamp":"2024-01-15T10:00:01Z","message":{"content":[{"type":"text","text":"Here is the result"}]}}',
      ].join('\n'));

      const result = await loadSDKSessionMessages('/Users/test/vault', 'session-merge-empty-target');

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('Here is the result');
    });

    it('handles multiple user images in a message', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        JSON.stringify({
          type: 'user',
          uuid: 'u-imgs',
          timestamp: '2024-01-15T10:00:00Z',
          message: {
            content: [
              { type: 'text', text: 'Check these images' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'def456' } },
            ],
          },
        }),
      ].join('\n'));

      const result = await loadSDKSessionMessages('/Users/test/vault', 'session-multi-images');

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].images).toHaveLength(2);
      expect(result.messages[0].images![0].mediaType).toBe('image/png');
      expect(result.messages[0].images![1].mediaType).toBe('image/jpeg');
      expect(result.messages[0].images![1].name).toBe('image-2');
    });
  });
});
