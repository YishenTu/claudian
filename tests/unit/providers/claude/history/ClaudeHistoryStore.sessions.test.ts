import { runInNewContext } from 'node:vm';

import { createReadStream, existsSync } from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type * as streamType from 'stream';
import type { Mocked, MockedFunction } from 'vitest';

import { extractToolResultContent } from '@/core/tools/toolResultContent';
import {
  getSDKSessionPath,
  isValidSessionId,
  readSDKSession,
} from '@/providers/claude/history/ClaudeHistoryPathResolver';
import {
  encodeVaultPathForSDK,
  getLastSDKSessionModel,
  getSDKProjectsPath,
  loadSDKSessionMessages,
  loadSubagentFinalResult,
  loadSubagentToolCalls,
  locateSDKSession,
} from '@/providers/claude/history/ClaudeHistoryStore';
import { resolveToolUseResultStatus } from '@/providers/claude/history/sdkAsyncSubagent';
import { filterActiveBranch } from '@/providers/claude/history/sdkBranchFilter';
import type { SDKNativeMessage } from '@/providers/claude/history/sdkHistoryTypes';
import { collectAsyncSubagentResults, parseSDKMessageToChat } from '@/providers/claude/history/sdkMessageParsing';
import { parseClaudeTaskNotification } from '@/providers/claude/normalization/claudeTaskNotification';

// Mock fs, fs/promises, and os modules. The mocked filesystem serves each file's
// `readFile` content to streaming readers as well, so history reads run the real line reader.
vi.mock('fs', async () => {
  const { Readable } = (await vi.importActual<typeof streamType>('stream'));
  const mockedFsPromises = await import('fs/promises');
  return {
    existsSync: vi.fn(),
    createReadStream: vi.fn((filePath: string) => Readable.from((async function* () {
      yield String(await mockedFsPromises.readFile(filePath, 'utf-8'));
    })())),
  };
});
vi.mock('fs/promises');
vi.mock('os');

// Fixed native paths keep Windows drive letters independent of the runner's cwd.
const fixturePath = (value: string): string => process.platform === 'win32'
  ? path.win32.join('C:\\', value) : value;
const vaultPath = fixturePath('/Users/test/vault');
const encodedDrive = process.platform === 'win32' ? 'C-' : '';

const mockExistsSync = existsSync as MockedFunction<typeof existsSync>;
const mockCreateReadStream = vi.mocked(createReadStream);
const mockFsPromises = fsPromises as Mocked<typeof fsPromises>;
const mockOs = os as Mocked<typeof os>;

describe('sdkSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOs.homedir.mockReturnValue(fixturePath('/Users/test'));
  });

  it('finds the last non-synthetic model on the active Claude branch', () => {
    const entries: SDKNativeMessage[] = [
      { type: 'assistant', uuid: 'a1', message: { model: 'claude-opus-4-6' } },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        message: { role: 'user', content: 'Continue' },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        message: { model: '<synthetic>' },
      },
      {
        type: 'assistant',
        uuid: 'a3',
        parentUuid: 'a2',
        message: { model: 'deepseek-v4-pro' },
      },
    ];

    expect(getLastSDKSessionModel(entries)).toBe('deepseek-v4-pro');
    expect(getLastSDKSessionModel(entries, 'a1')).toBe('claude-opus-4-6');
  });

  it('does not recover a Claude model from a stale rewind checkpoint', () => {
    const entries: SDKNativeMessage[] = [
      { type: 'user', uuid: 'u1', parentUuid: null },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: { model: 'claude-sonnet-4-5' },
      },
      { type: 'user', uuid: 'u2', parentUuid: 'a1' },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        message: { model: 'claude-opus-4-6' },
      },
      { type: 'user', uuid: 'u3', parentUuid: 'a1' },
      {
        type: 'assistant',
        uuid: 'a3',
        parentUuid: 'u3',
        message: { model: 'claude-haiku-4-5' },
      },
    ];

    expect(getLastSDKSessionModel(entries, 'missing-checkpoint')).toBeNull();
    expect(getLastSDKSessionModel(entries, 'a2')).toBeNull();
  });

  describe('encodeVaultPathForSDK', () => {
    it('encodes vault path by replacing all non-alphanumeric chars with dash', () => {
      const encoded = encodeVaultPathForSDK(vaultPath);
      // SDK replaces ALL non-alphanumeric characters with `-`
      expect(encoded).toBe(`${encodedDrive}-Users-test-vault`);
    });

    it('handles paths with spaces and special characters', () => {
      const encoded = encodeVaultPathForSDK(fixturePath("/Users/test/My Vault's~Data"));
      expect(encoded).toBe(`${encodedDrive}-Users-test-My-Vault-s-Data`);
    });

    it('handles Unicode characters (Chinese, Japanese, etc.)', () => {
      // Unicode characters should be replaced with `-` to match SDK behavior
      const encoded = encodeVaultPathForSDK(fixturePath('/Volumes/[Work]弘毅之鹰/学习/东京大学/2025年 秋'));
      // All non-alphanumeric (including Chinese, brackets) become `-`
      expect(encoded).toBe(`${encodedDrive}-Volumes--Work--------------2025---`);
      // Verify only ASCII alphanumeric and dash remain
      expect(encoded).toMatch(/^[a-zA-Z0-9-]+$/);
    });

    it('handles brackets and other special characters', () => {
      const encoded = encodeVaultPathForSDK(fixturePath('/Users/test/[my-vault](notes)'));
      expect(encoded).toBe(`${encodedDrive}-Users-test--my-vault--notes-`);
      expect(encoded).not.toContain('[');
      expect(encoded).not.toContain(']');
      expect(encoded).not.toContain('(');
      expect(encoded).not.toContain(')');
    });

    it('produces different encodings for different paths', () => {
      const encoded1 = encodeVaultPathForSDK(fixturePath('/Users/test/vault1'));
      const encoded2 = encodeVaultPathForSDK(fixturePath('/Users/test/vault2'));
      expect(encoded1).not.toBe(encoded2);
    });

    it('handles backslashes for Windows compatibility', () => {
      // Test that backslashes are replaced (Windows path separators)
      // Note: path.resolve may modify the input, so we check the output contains no backslashes
      const encoded = encodeVaultPathForSDK('C:\\Users\\test\\vault');
      expect(encoded).not.toContain('\\');
      expect(encoded).not.toContain(':');
      expect(encoded).toContain('-Users-test-vault');
    });
  });

  describe('getSDKProjectsPath', () => {
    it('returns path under home directory', () => {
      const projectsPath = getSDKProjectsPath();
      expect(projectsPath).toBe(fixturePath('/Users/test/.claude/projects'));
    });

    it('uses CLAUDE_CONFIG_DIR from the effective SDK environment', () => {
      const projectsPath = getSDKProjectsPath({
        environment: { CLAUDE_CONFIG_DIR: fixturePath('/custom/claude') },
        vaultPath: vaultPath,
      });

      expect(projectsPath).toBe(fixturePath('/custom/claude/projects'));
    });

    it('resolves a relative CLAUDE_CONFIG_DIR from the SDK working directory', () => {
      const projectsPath = getSDKProjectsPath({
        environment: { CLAUDE_CONFIG_DIR: '.claude-custom' },
        vaultPath: vaultPath,
      });

      expect(projectsPath).toBe(fixturePath('/Users/test/vault/.claude-custom/projects'));
    });

    it('falls back to the default directory when CLAUDE_CONFIG_DIR is unset', () => {
      const projectsPath = getSDKProjectsPath({
        environment: {},
        vaultPath: vaultPath,
      });

      expect(projectsPath).toBe(fixturePath('/Users/test/.claude/projects'));
    });

    it('uses the effective SDK HOME when CLAUDE_CONFIG_DIR is unset', () => {
      const projectsPath = getSDKProjectsPath({
        environment: { HOME: fixturePath('/custom/home') },
        hostPlatform: 'linux',
        vaultPath: vaultPath,
      });

      expect(projectsPath).toBe(fixturePath('/custom/home/.claude/projects'));
    });

    it('uses the effective SDK USERPROFILE on Windows', () => {
      const projectsPath = getSDKProjectsPath({
        environment: { USERPROFILE: fixturePath('/custom/windows-home') },
        hostPlatform: 'win32',
        vaultPath: vaultPath,
      });

      expect(projectsPath).toBe(fixturePath('/custom/windows-home/.claude/projects'));
    });

    it('resolves an empty SDK HOME from the SDK working directory', () => {
      const projectsPath = getSDKProjectsPath({
        environment: { HOME: '' },
        hostPlatform: 'linux',
        vaultPath: vaultPath,
      });

      expect(projectsPath).toBe(fixturePath('/Users/test/vault/.claude/projects'));
    });

    it('preserves an explicitly empty CLAUDE_CONFIG_DIR like the SDK', () => {
      const projectsPath = getSDKProjectsPath({
        environment: { CLAUDE_CONFIG_DIR: '' },
        vaultPath: vaultPath,
      });

      expect(projectsPath).toBe(fixturePath('/Users/test/vault/projects'));
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
      const sessionPath = getSDKSessionPath(vaultPath, 'session-123');
      expect(sessionPath).toContain(path.join('.claude', 'projects'));
      expect(sessionPath).toContain('session-123.jsonl');
    });

    it('throws error for path traversal attempts', () => {
      expect(() => getSDKSessionPath(vaultPath, '../etc/passwd')).toThrow('Invalid session ID');
      expect(() => getSDKSessionPath(vaultPath, 'foo/../bar')).toThrow('Invalid session ID');
      expect(() => getSDKSessionPath(vaultPath, 'session/subdir')).toThrow('Invalid session ID');
    });

    it('throws error for empty session ID', () => {
      expect(() => getSDKSessionPath(vaultPath, '')).toThrow('Invalid session ID');
    });

    it('builds session paths under the effective Claude config directory', () => {
      const sessionPath = getSDKSessionPath(vaultPath, 'session-123', {
        environment: { CLAUDE_CONFIG_DIR: fixturePath('/custom/claude') },
        vaultPath: vaultPath,
      });

      expect(sessionPath).toBe(fixturePath(`/custom/claude/projects/${encodedDrive}-Users-test-vault/session-123.jsonl`));
    });
  });

  describe('locateSDKSession', () => {
    it('reports an available session', async () => {
      mockFsPromises.access.mockResolvedValue(undefined);

      await expect(locateSDKSession(
        vaultPath,
        'session-abc',
      )).resolves.toMatchObject({ availability: 'available' });
      expect(mockFsPromises.access).toHaveBeenCalledWith(
        fixturePath(`/Users/test/.claude/projects/${encodedDrive}-Users-test-vault/session-abc.jsonl`),
      );
    });

    it('reports a missing session when a complete scan finds no transcript', async () => {
      mockFsPromises.access.mockRejectedValue(
        Object.assign(new Error('Missing'), { code: 'ENOENT' }),
      );
      mockFsPromises.readdir.mockResolvedValue([]);

      await expect(locateSDKSession(
        vaultPath,
        'session-missing',
      )).resolves.toMatchObject({ availability: 'missing' });
    });

    it('reports a session found under a previous vault project as relocated', async () => {
      mockFsPromises.access.mockRejectedValue(
        Object.assign(new Error('Missing'), { code: 'ENOENT' }),
      );
      mockFsPromises.readdir
        .mockResolvedValueOnce([{
          isDirectory: () => true,
          isFile: () => false,
          name: '-Users-test-previous-vault',
        }] as any)
        .mockResolvedValueOnce([{
          isDirectory: () => false,
          isFile: () => true,
          name: 'session-relocated.jsonl',
        }] as any);

      await expect(locateSDKSession(
        vaultPath,
        'session-relocated',
      )).resolves.toMatchObject({ availability: 'relocated' });
    });

    it('finds relocated sessions in nested project directories', async () => {
      mockFsPromises.access.mockRejectedValue(
        Object.assign(new Error('Missing'), { code: 'ENOENT' }),
      );
      mockFsPromises.readdir
        .mockResolvedValueOnce([{
          isDirectory: () => true,
          isFile: () => false,
          name: '-Users-test-current-project',
        }] as any)
        .mockResolvedValueOnce([{
          isDirectory: () => true,
          isFile: () => false,
          name: '-Users-test-previous-vault',
        }] as any)
        .mockResolvedValueOnce([{
          isDirectory: () => false,
          isFile: () => true,
          name: 'session-nested.jsonl',
        }] as any);

      await expect(locateSDKSession(
        vaultPath,
        'session-nested',
      )).resolves.toMatchObject({ availability: 'relocated' });
    });

    it('reports unknown when the local Claude projects root is absent', async () => {
      mockFsPromises.access.mockRejectedValue(
        Object.assign(new Error('Missing'), { code: 'ENOENT' }),
      );
      mockFsPromises.readdir.mockRejectedValue(
        Object.assign(new Error('Missing root'), { code: 'ENOENT' }),
      );

      await expect(locateSDKSession(
        vaultPath,
        'session-on-another-machine',
      )).resolves.toMatchObject({ availability: 'unknown' });
    });

    it('reports unknown for other filesystem failures', async () => {
      mockFsPromises.access.mockRejectedValue(
        Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
      );

      await expect(locateSDKSession(
        vaultPath,
        'session-inaccessible',
      )).resolves.toMatchObject({ availability: 'unknown' });
    });

    it('reports unknown when an unscanned symlink could contain the transcript', async () => {
      mockFsPromises.access.mockRejectedValue(
        Object.assign(new Error('Missing'), { code: 'ENOENT' }),
      );
      mockFsPromises.readdir.mockResolvedValue([{
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => true,
        name: 'linked-project',
      }] as any);

      await expect(locateSDKSession(
        vaultPath,
        'session-in-linked-project',
      )).resolves.toMatchObject({ availability: 'unknown' });
    });

    it('reports unknown for an invalid session ID', async () => {
      await expect(locateSDKSession(
        vaultPath,
        '../invalid',
      )).resolves.toMatchObject({ availability: 'unknown' });
      expect(mockFsPromises.access).not.toHaveBeenCalled();
    });
  });

  describe('readSDKSession', () => {
    it('returns empty result when file does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await readSDKSession(vaultPath, 'nonexistent');

      expect(result.messages).toEqual([]);
      expect(result.skippedLines).toBe(0);
      expect(result.error).toBeUndefined();
    });









    it('returns error on read failure', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockRejectedValue(new Error('Read error'));

      const result = await readSDKSession(vaultPath, 'session-err');

      expect(result.messages).toEqual([]);
      expect(result.error).toBe('Read error');
    });
  });

  describe('loadSubagentToolCalls', () => {

    it('filters out entries that only have tool_result but no tool_use', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue(
        '{"type":"user","timestamp":"2024-01-15T10:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"missing","content":"done"}]}}'
      );

      const toolCalls = await loadSubagentToolCalls(
        vaultPath,
        'session-abc',
        'a123'
      );

      expect(toolCalls).toEqual([]);
    });

    it('returns empty when agent id is invalid', async () => {
      const toolCalls = await loadSubagentToolCalls(
        vaultPath,
        'session-abc',
        '../bad-agent'
      );

      expect(toolCalls).toEqual([]);
      expect(mockCreateReadStream).not.toHaveBeenCalled();
    });
  });

  describe('loadSubagentFinalResult', () => {
    it('returns the latest assistant text from sidecar JSONL', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"First"}]}}',
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
          { type: 'text', text: 'Report heading' },
          { type: 'thinking', thinking: 'Private reasoning' },
          { type: 'text', text: 'Final answer' },
        ] } }),
      ].join('\n'));

      const result = await loadSubagentFinalResult(
        vaultPath,
        'session-abc',
        'a123'
      );

      expect(result).toBe('Report heading\nFinal answer');
      expect(mockCreateReadStream).toHaveBeenCalledWith(
        fixturePath(`/Users/test/.claude/projects/${encodedDrive}-Users-test-vault/session-abc/subagents/agent-a123.jsonl`),
        expect.anything()
      );
    });

    it('falls back to top-level result when assistant text is absent', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        '{"type":"progress","result":"Intermediate result"}',
        '{"type":"result","result":"Final result text"}',
      ].join('\n'));

      const result = await loadSubagentFinalResult(
        vaultPath,
        'session-abc',
        'a123'
      );

      expect(result).toBe('Final result text');
    });

    it('returns null when sidecar file is missing or agent id is invalid', async () => {
      mockExistsSync.mockReturnValue(false);

      const missing = await loadSubagentFinalResult(
        vaultPath,
        'session-abc',
        'a123'
      );
      expect(missing).toBeNull();

      const invalid = await loadSubagentFinalResult(
        vaultPath,
        'session-abc',
        '../bad-agent'
      );
      expect(invalid).toBeNull();
      expect(mockCreateReadStream).not.toHaveBeenCalled();
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
      expect(chatMsg!.userMessageId).toBe('user-123');
      expect(chatMsg!.assistantMessageId).toBeUndefined();
      expect(chatMsg!.isInterrupt).toBeUndefined();
      expect(chatMsg!.displayContent).toBeUndefined();
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
      expect(chatMsg!.assistantMessageId).toBe('asst-456');
      expect(chatMsg!.userMessageId).toBeUndefined();
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

    it('keeps tool calls running when no matching tool_result exists yet', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'assistant',
        uuid: 'asst-running',
        timestamp: '2024-01-15T10:33:30Z',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-running',
              name: 'Read',
              input: { file_path: 'notes/todo.md' },
            },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg!.toolCalls![0].status).toBe('running');
      expect(chatMsg!.toolCalls![0].result).toBeUndefined();
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

    it('preserves text block whitespace in contentBlocks', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'assistant',
        uuid: 'asst-whitespace',
        timestamp: '2024-01-15T10:34:30Z',
        message: {
          content: [
            { type: 'text', text: '  Preserve leading and trailing space  ' },
          ],
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);

      expect(chatMsg!.content).toBe('  Preserve leading and trailing space  ');
      expect(chatMsg!.contentBlocks).toEqual([
        { type: 'text', content: '  Preserve leading and trailing space  ' },
      ]);
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
      expect(chatMsg!.contentBlocks).toEqual([{ type: 'context_compacted' }]);
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
      expect(chatMsg!.userMessageId).toBeUndefined();
      expect(chatMsg!.assistantMessageId).toBeUndefined();
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

    it('does not mark non-canonical interrupt text variants', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'interrupt-non-canonical',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: 'prefix [Request interrupted by user]',
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
  });

  describe('loadSDKSessionMessages', () => {










    it('returns empty result when session does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await loadSDKSessionMessages(vaultPath, 'nonexistent');

      expect(result.messages).toEqual([]);
    });











    it('returns error pass-through from readSDKSession', async () => {
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockRejectedValue(new Error('Disk failure'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-disk-err');

      expect(result.messages).toEqual([]);
      expect(result.error).toBe('Disk failure');
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
      expect(chatMsg!.images).toBeUndefined();
    });

    it('retains user messages with only tool_result content at the parser boundary', () => {
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

    it('does not mark quoted compact cancellation mention as interrupt', () => {
      const sdkMsg: SDKNativeMessage = {
        type: 'user',
        uuid: 'interrupt-compact-quoted',
        timestamp: '2024-01-15T10:30:00Z',
        message: {
          content: '## Context\n<local-command-stderr>Error: Compaction canceled.</local-command-stderr>',
        },
      };

      const chatMsg = parseSDKMessageToChat(sdkMsg);
      expect(chatMsg).not.toBeNull();
      expect(chatMsg!.isInterrupt).toBeUndefined();
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

  describe('filterActiveBranch', () => {
    // A test timeout cannot interrupt a synchronous infinite loop.
    function filterCyclicBranch(entries: SDKNativeMessage[], resumeAtMessageId?: string): SDKNativeMessage[] {
      return runInNewContext('filterActiveBranch(entries, resumeAtMessageId)', {
        filterActiveBranch, entries, resumeAtMessageId,
      }, { timeout: 1000 });
    }

    it.each([undefined, 'after', 'tail'])('retains history across a compaction cycle when resuming at %s', resumeAt => {
      // Issue #1672: the preserved segment descends from the boundary, whose
      // logical parent points forward to the tail of that same segment.
      const entries: SDKNativeMessage[] = [
        { type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: null, logicalParentUuid: 'tail' },
        { type: 'user', uuid: 'summary', parentUuid: 'compact', isMeta: true },
        { type: 'assistant', uuid: 'head', parentUuid: 'summary' },
        { type: 'assistant', uuid: 'middle', parentUuid: 'head' },
        { type: 'assistant', uuid: 'last', parentUuid: 'middle' },
        { type: 'user', uuid: 'tool-result', parentUuid: 'last', toolUseResult: {} },
        { type: 'attachment', uuid: 'tail', parentUuid: 'tool-result' },
        { type: 'assistant', uuid: 'after', parentUuid: 'tail' },
      ];

      expect(filterCyclicBranch(entries, resumeAt).map(e => e.uuid)).toEqual([
        'compact', 'summary', 'head', 'middle', 'last', 'tool-result', 'tail',
        ...(resumeAt === 'tail' ? [] : ['after']),
      ]);
    });

    it.each([
      [undefined, ['loop', 'u-new', 'a-new']],
      ['a-old', ['loop', 'u-new', 'a-new']],
      ['u-new', ['loop', 'u-new']],
    ])('selects the latest branch through a self-parent cycle when resuming at %s', (resumeAt, expected) => {
      const entries: SDKNativeMessage[] = [
        { type: 'assistant', uuid: 'loop', parentUuid: 'loop' },
        { type: 'user', uuid: 'u-old', parentUuid: 'loop' },
        { type: 'assistant', uuid: 'a-old', parentUuid: 'u-old' },
        { type: 'user', uuid: 'u-new', parentUuid: 'loop' },
        { type: 'assistant', uuid: 'a-new', parentUuid: 'u-new' },
      ];

      expect(filterCyclicBranch(entries, resumeAt).map(e => e.uuid)).toEqual(expected);
    });

    it.each([undefined, 'one'])('handles a parent cycle with no leaf when resuming at %s', resumeAt => {
      const entries: SDKNativeMessage[] = [
        { type: 'assistant', uuid: 'one', parentUuid: 'two' },
        { type: 'assistant', uuid: 'two', parentUuid: 'one' },
      ];

      expect(filterCyclicBranch(entries, resumeAt)).toEqual(entries);
    });

    it('selects the latest branch through a cycle of non-conversation children', () => {
      const entries: SDKNativeMessage[] = [
        { type: 'system', uuid: 'one', parentUuid: 'two' },
        { type: 'attachment', uuid: 'two', parentUuid: 'one' },
        { type: 'user', uuid: 'u-old', parentUuid: 'one' },
        { type: 'assistant', uuid: 'a-old', parentUuid: 'u-old' },
        { type: 'user', uuid: 'u-new', parentUuid: 'one' },
        { type: 'assistant', uuid: 'a-new', parentUuid: 'u-new' },
      ];

      expect(filterCyclicBranch(entries).map(e => e.uuid)).toEqual(['one', 'two', 'u-new', 'a-new']);
    });

    it('returns all entries for linear chain without resumeAtMessageId', () => {
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        { type: 'user', uuid: 'u2', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2' },
      ];

      const result = filterActiveBranch(entries);

      expect(result).toHaveLength(4);
      expect(result).toEqual(entries);
    });

    it('truncates linear chain at resumeAtMessageId UUID', () => {
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        { type: 'user', uuid: 'u2', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2' },
      ];

      const result = filterActiveBranch(entries, 'a1');

      expect(result).toHaveLength(2);
      expect(result.map(e => e.uuid)).toEqual(['u1', 'a1']);
    });

    it('returns only new branch after rewind + follow-up', () => {
      // Original: u1 → a1 → u2 → a2
      // Rewind to a1, follow-up: u3 → a3 (u3.parentUuid = a1)
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        { type: 'user', uuid: 'u2', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2' },
        { type: 'user', uuid: 'u3', parentUuid: 'a1' },    // Branch point: a1 has 2 children
        { type: 'assistant', uuid: 'a3', parentUuid: 'u3' },
      ];

      const result = filterActiveBranch(entries);

      // Should include: u1, a1, u3, a3 (new branch), not u2, a2
      expect(result.map(e => e.uuid)).toEqual(['u1', 'a1', 'u3', 'a3']);
    });

    it('returns latest branch after multiple rewinds', () => {
      // Original: u1 → a1 → u2 → a2
      // Rewind 1: u3 → a3 (parent a1)
      // Rewind 2: u4 → a4 (parent a1) — third child of a1
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        { type: 'user', uuid: 'u2', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2' },
        { type: 'user', uuid: 'u3', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a3', parentUuid: 'u3' },
        { type: 'user', uuid: 'u4', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a4', parentUuid: 'u4' },
      ];

      const result = filterActiveBranch(entries);

      // Last entry with uuid is a4, walk back: a4 → u4 → a1 → u1
      expect(result.map(e => e.uuid)).toEqual(['u1', 'a1', 'u4', 'a4']);
    });

    it('returns all entries when resumeAtMessageId UUID not found (safety)', () => {
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
      ];

      const result = filterActiveBranch(entries, 'nonexistent-uuid');

      expect(result).toHaveLength(2);
      expect(result).toEqual(entries);
    });

    it('returns empty for empty entries', () => {
      const result = filterActiveBranch([]);
      expect(result).toEqual([]);
    });

    it('does not misdetect branching when duplicate uuid entries exist', () => {
      // SDK may write the same message twice (e.g., around compaction).
      // Without dedup, duplicate entries inflate childCount causing false branch detection.
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        { type: 'user', uuid: 'u2', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2' },
        // Duplicate of u2 — SDK writes this again
        { type: 'user', uuid: 'u2', parentUuid: 'a1' },
      ];

      // Without dedup fix, a1 would have childCount=2 (u2 counted twice),
      // triggering branch detection and excluding u2/a2.
      const result = filterActiveBranch(entries);

      // Should be a no-op (linear chain, no branching)
      expect(result).toHaveLength(4);
      expect(result.map(e => e.uuid)).toEqual(['u1', 'a1', 'u2', 'a2']);
    });

    it('correctly truncates at resumeAtMessageId when duplicates exist', () => {
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        { type: 'user', uuid: 'u2', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2' },
        // Duplicate of u2
        { type: 'user', uuid: 'u2', parentUuid: 'a1' },
      ];

      const result = filterActiveBranch(entries, 'a1');

      // Should truncate at a1, including only u1 and a1
      expect(result).toHaveLength(2);
      expect(result.map(e => e.uuid)).toEqual(['u1', 'a1']);
    });

    it('preserves no-uuid entries within active branch region', () => {
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'queue-operation' },  // No uuid — between u1 (active) and a1 (active)
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        { type: 'user', uuid: 'u2', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2' },
        { type: 'user', uuid: 'u3', parentUuid: 'a1' },    // Branch
        { type: 'assistant', uuid: 'a3', parentUuid: 'u3' },
      ];

      const result = filterActiveBranch(entries);

      const uuids = result.filter(e => e.uuid).map(e => e.uuid);
      expect(uuids).toEqual(['u1', 'a1', 'u3', 'a3']);
      // queue-operation is between u1 (active) and a1 (active), so preserved
      expect(result.some(e => e.type === 'queue-operation')).toBe(true);
    });

    it('truncates at resumeAtMessageId on latest branch when branching exists', () => {
      // Rewind 1 + follow-up created a branch: u3/a3 branch off a1
      // Rewind 2 on the new branch (no follow-up): resumeAtMessageId = a1
      // On reload, should truncate at a1, not show u3/a3
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        { type: 'user', uuid: 'u2', parentUuid: 'a1' },       // old branch
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2' },   // old branch
        { type: 'user', uuid: 'u3', parentUuid: 'a1' },        // new branch (from rewind 1)
        { type: 'assistant', uuid: 'a3', parentUuid: 'u3' },   // new branch
      ];

      // Rewind 2 on new branch: truncate at a1
      const result = filterActiveBranch(entries, 'a1');

      expect(result.map(e => e.uuid)).toEqual(['u1', 'a1']);
    });

    it.each([
      ['a branch after the compaction', undefined, ['u1', 'a1', 'c1', 's1', 'u3', 'a3']],
      ['a rewind after the compaction', 's1', ['u1', 'a1', 'c1', 's1']],
    ])('keeps history before a compact boundary when resolving %s', (_case, resumeAt, expected) => {
      // Native /compact restarts the parent chain; only logicalParentUuid links the boundary back.
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        { type: 'system', subtype: 'compact_boundary', uuid: 'c1', parentUuid: null, logicalParentUuid: 'a1' },
        { type: 'user', uuid: 's1', parentUuid: 'c1', isMeta: true },
        { type: 'user', uuid: 'u2', parentUuid: 's1' },        // old branch
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2' },   // old branch
        { type: 'user', uuid: 'u3', parentUuid: 's1' },        // new branch
        { type: 'assistant', uuid: 'a3', parentUuid: 'u3' },   // new branch
      ];

      expect(filterActiveBranch(entries, resumeAt).map(e => e.uuid)).toEqual(expected);
    });

    it('truncates at resumeAtMessageId mid-branch when branching exists', () => {
      // Branch from a1: old (u2→a2) and new (u3→a3→u4→a4)
      // Rewind on new branch to u4: resumeAtMessageId = a3
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        { type: 'user', uuid: 'u2', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2' },
        { type: 'user', uuid: 'u3', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a3', parentUuid: 'u3' },
        { type: 'user', uuid: 'u4', parentUuid: 'a3' },
        { type: 'assistant', uuid: 'a4', parentUuid: 'u4' },
      ];

      const result = filterActiveBranch(entries, 'a3');

      expect(result.map(e => e.uuid)).toEqual(['u1', 'a1', 'u3', 'a3']);
    });

    it('ignores resumeAtMessageId not on latest branch', () => {
      // Branch from a1: old (u2→a2) and new (u3→a3)
      // resumeAtMessageId points to a2 (on the OLD branch) — should be ignored
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        { type: 'user', uuid: 'u2', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2' },
        { type: 'user', uuid: 'u3', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a3', parentUuid: 'u3' },
      ];

      // a2 is on old branch, not an ancestor of leaf a3
      const result = filterActiveBranch(entries, 'a2');

      // Should return full latest branch (ignoring stale resumeAtMessageId)
      expect(result.map(e => e.uuid)).toEqual(['u1', 'a1', 'u3', 'a3']);
    });

    it('drops no-uuid entries in old branch region', () => {
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        { type: 'user', uuid: 'u2', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2' },
        { type: 'queue-operation' },  // No uuid — between a2 (old) and u3 (active)
        { type: 'user', uuid: 'u3', parentUuid: 'a1' },    // Branch
        { type: 'assistant', uuid: 'a3', parentUuid: 'u3' },
      ];

      const result = filterActiveBranch(entries);

      const uuids = result.filter(e => e.uuid).map(e => e.uuid);
      expect(uuids).toEqual(['u1', 'a1', 'u3', 'a3']);
      // queue-operation between a2 (not active) and u3 (active) — should be dropped
      expect(result.some(e => e.type === 'queue-operation')).toBe(false);
    });

    it('excludes progress entries and does not treat them as branches', () => {
      // Simulates Agent tool call: assistant issues tool_use, SDK writes progress chain,
      // then next user message is parented to end of progress chain.
      // Without fix: progress creates false branching, losing the conversation branch.
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        // a1 is a tool_use (Agent). SDK writes tool_result + progress chain as siblings:
        { type: 'user', uuid: 'tr1', parentUuid: 'a1', toolUseResult: {} },  // tool result
        { type: 'assistant', uuid: 'a2', parentUuid: 'tr1' },  // response after tool
        // Progress chain branching off a1 (subagent execution logs):
        { type: 'progress', uuid: 'p1', parentUuid: 'a1' },
        { type: 'progress', uuid: 'p2', parentUuid: 'p1' },
        { type: 'progress', uuid: 'p3', parentUuid: 'p2' },
        // Next conversation message parented to end of progress chain:
        { type: 'user', uuid: 'u2', parentUuid: 'p3' },
        { type: 'assistant', uuid: 'a3', parentUuid: 'u2' },
      ];

      const result = filterActiveBranch(entries);
      const uuids = result.filter(e => e.uuid).map(e => e.uuid);

      // All conversation entries should be present, progress entries excluded
      expect(uuids).toEqual(['u1', 'a1', 'tr1', 'a2', 'u2', 'a3']);
      expect(result.every(e => e.type !== 'progress')).toBe(true);
    });

    it('reparents through long progress chains to preserve full conversation', () => {
      // Two turns, each with Agent tool calls generating progress entries.
      // The second turn's user message is parented to the end of the first progress chain.
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1-think', parentUuid: 'u1' },
        { type: 'assistant', uuid: 'a1-tool', parentUuid: 'a1-think' },  // Agent tool_use
        // Conversation branch: tool result → assistant response
        { type: 'user', uuid: 'tr1', parentUuid: 'a1-tool', toolUseResult: {} },
        { type: 'assistant', uuid: 'a1-think2', parentUuid: 'tr1' },
        { type: 'assistant', uuid: 'a1-text', parentUuid: 'a1-think2' },
        // Progress chain off a1-tool:
        { type: 'progress', uuid: 'p1', parentUuid: 'a1-tool' },
        { type: 'progress', uuid: 'p2', parentUuid: 'p1' },
        // System entry chained to progress:
        { type: 'system', uuid: 'sys1', parentUuid: 'p2' },
        // Second turn parented to system (which is parented to progress chain):
        { type: 'user', uuid: 'u2', parentUuid: 'sys1' },
        { type: 'assistant', uuid: 'a2', parentUuid: 'u2' },
      ];

      const result = filterActiveBranch(entries);
      const uuids = result.filter(e => e.uuid).map(e => e.uuid);

      // Must include BOTH turns' content — nothing lost
      expect(uuids).toContain('a1-text');  // First turn's response
      expect(uuids).toContain('u2');       // Second turn's input
      expect(uuids).toContain('a2');       // Second turn's response
      // Progress entries must be excluded
      expect(uuids).not.toContain('p1');
      expect(uuids).not.toContain('p2');
    });

    it('does not treat parallel tool calls as branches', () => {
      // Assistant sends two tool_use blocks in parallel. SDK writes them as
      // separate entries. Their tool results are parented to respective entries.
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1-text', parentUuid: 'u1' },
        { type: 'assistant', uuid: 'a1-tool1', parentUuid: 'a1-text' },  // first tool_use
        { type: 'assistant', uuid: 'a1-tool2', parentUuid: 'a1-text' },  // second tool_use (parallel)
        // Tool results:
        { type: 'user', uuid: 'tr1', parentUuid: 'a1-tool1', toolUseResult: {} },
        { type: 'user', uuid: 'tr2', parentUuid: 'a1-tool2', toolUseResult: {} },
        // Assistant continues after both results:
        { type: 'assistant', uuid: 'a2', parentUuid: 'tr2' },
      ];

      const result = filterActiveBranch(entries);
      const uuids = result.filter(e => e.uuid).map(e => e.uuid);

      // Both tool calls and their results should be present
      expect(uuids).toContain('a1-tool1');
      expect(uuids).toContain('a1-tool2');
      expect(uuids).toContain('tr1');
      expect(uuids).toContain('tr2');
      expect(uuids).toContain('a2');
    });

    it('handles real rewind alongside progress entries', () => {
      // Turn 1 with Agent tool (progress entries), then a real rewind at a1.
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        // Original continuation:
        { type: 'user', uuid: 'u2-old', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a2-old', parentUuid: 'u2-old' },
        // Progress entries off a1:
        { type: 'progress', uuid: 'p1', parentUuid: 'a1' },
        { type: 'progress', uuid: 'p2', parentUuid: 'p1' },
        // Rewind: new user message also branching off a1
        { type: 'user', uuid: 'u2-new', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a2-new', parentUuid: 'u2-new' },
      ];

      const result = filterActiveBranch(entries);
      const uuids = result.filter(e => e.uuid).map(e => e.uuid);

      // Should follow the latest branch (u2-new), not the old one or progress
      expect(uuids).toEqual(['u1', 'a1', 'u2-new', 'a2-new']);
    });

    it('detects rewind when abandoned path continues through assistant/tool nodes', () => {
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1', parentUuid: 'u1' },
        { type: 'assistant', uuid: 'a1-tool', parentUuid: 'a1' },
        { type: 'user', uuid: 'tr1', parentUuid: 'a1-tool', toolUseResult: {} },
        { type: 'assistant', uuid: 'a2', parentUuid: 'tr1' },
        { type: 'user', uuid: 'u2-new', parentUuid: 'a1' },
        { type: 'assistant', uuid: 'a3-new', parentUuid: 'u2-new' },
      ];

      const result = filterActiveBranch(entries);
      const uuids = result.filter(e => e.uuid).map(e => e.uuid);

      expect(uuids).toEqual(['u1', 'a1', 'u2-new', 'a3-new']);
    });

    it('preserves earlier parallel tool-result descendants when a later rewind exists', () => {
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', parentUuid: null },
        { type: 'assistant', uuid: 'a1-text', parentUuid: 'u1' },
        { type: 'assistant', uuid: 'a1-tool1', parentUuid: 'a1-text' },
        { type: 'assistant', uuid: 'a1-tool2', parentUuid: 'a1-text' },
        { type: 'user', uuid: 'tr1', parentUuid: 'a1-tool1', toolUseResult: {} },
        { type: 'user', uuid: 'tr2', parentUuid: 'a1-tool2', toolUseResult: {} },
        { type: 'assistant', uuid: 'a2', parentUuid: 'tr2' },
        { type: 'user', uuid: 'u3-old', parentUuid: 'a2' },
        { type: 'assistant', uuid: 'a3-old', parentUuid: 'u3-old' },
        { type: 'user', uuid: 'u3-new', parentUuid: 'a2' },
        { type: 'assistant', uuid: 'a3-new', parentUuid: 'u3-new' },
      ];

      const result = filterActiveBranch(entries);
      const uuids = result.filter(e => e.uuid).map(e => e.uuid);

      expect(uuids).toEqual([
        'u1',
        'a1-text',
        'a1-tool1',
        'a1-tool2',
        'tr1',
        'tr2',
        'a2',
        'u3-new',
        'a3-new',
      ]);
    });
  });

  describe('extractToolResultContent', () => {
    it('passes through string content unchanged', () => {
      expect(extractToolResultContent('hello world')).toBe('hello world');
    });

    it('extracts text from array of content blocks (Agent results)', () => {
      const content = [
        { type: 'text', text: 'First block of output.' },
        { type: 'text', text: 'agentId: abc123\n<usage>total_tokens: 1000</usage>' },
      ];
      expect(extractToolResultContent(content)).toBe(
        'First block of output.\nagentId: abc123\n<usage>total_tokens: 1000</usage>'
      );
    });

    it('skips non-text blocks in array content', () => {
      const content = [
        { type: 'image', source: { type: 'base64', data: 'abc' } },
        { type: 'text', text: 'The only text.' },
      ];
      expect(extractToolResultContent(content)).toBe('The only text.');
    });

    it('returns empty string for null/undefined content', () => {
      expect(extractToolResultContent(null)).toBe('');
      expect(extractToolResultContent(undefined)).toBe('');
    });

    it('JSON-stringifies unknown content types as fallback', () => {
      expect(extractToolResultContent({ custom: 'value' })).toBe('{"custom":"value"}');
    });

    it('handles empty array content', () => {
      expect(extractToolResultContent([])).toBe('');
    });

    it('JSON-stringifies non-empty array with no text blocks (e.g. tool_reference)', () => {
      const content = [
        { type: 'tool_reference', tool_name: 'WebSearch' },
        { type: 'tool_reference', tool_name: 'Grep' },
      ];
      expect(extractToolResultContent(content)).toBe(JSON.stringify(content));
    });

    it('JSON-stringifies non-empty array with no text blocks using fallbackIndent', () => {
      const content = [
        { type: 'tool_reference', tool_name: 'Read' },
      ];
      expect(extractToolResultContent(content, { fallbackIndent: 2 })).toBe(
        JSON.stringify(content, null, 2)
      );
    });
  });

  describe('collectAsyncSubagentResults', () => {
    it('extracts task-notification data from queue-operation enqueue entries', () => {
      const entries: SDKNativeMessage[] = [
        {
          type: 'queue-operation',
          operation: 'enqueue',
          content: `<task-notification>
<task-id>ae5eb9a</task-id>
<status>completed</status>
<summary>Agent "Review code" completed</summary>
<result>Found 3 issues in the codebase.

1. Missing error handling in auth module.
2. Unused import in utils.ts.
3. Race condition in fetchData.</result>
</task-notification>`,
        },
      ];

      const results = collectAsyncSubagentResults(entries);

      expect(results.size).toBe(1);
      const entry = results.get('ae5eb9a')!;
      expect(entry.status).toBe('completed');
      expect(entry.result).toContain('Found 3 issues');
      expect(entry.result).toContain('Race condition in fetchData.');
    });

    it('collects multiple queue-operation entries', () => {
      const entries: SDKNativeMessage[] = [
        {
          type: 'queue-operation',
          operation: 'enqueue',
          content: '<task-notification><task-id>agent-1</task-id><status>completed</status><result>Result 1</result></task-notification>',
        },
        {
          type: 'queue-operation',
          operation: 'enqueue',
          content: '<task-notification><task-id>agent-2</task-id><status>error</status><result>Task failed</result></task-notification>',
        },
      ];

      const results = collectAsyncSubagentResults(entries);

      expect(results.size).toBe(2);
      expect(results.get('agent-1')!.status).toBe('completed');
      expect(results.get('agent-2')!.status).toBe('error');
      expect(results.get('agent-2')!.result).toBe('Task failed');
    });

    it('skips dequeue operations', () => {
      const entries: SDKNativeMessage[] = [
        {
          type: 'queue-operation',
          operation: 'dequeue',
          sessionId: 'session-1',
        },
      ];

      const results = collectAsyncSubagentResults(entries);
      expect(results.size).toBe(0);
    });

    it('skips entries without task-notification content', () => {
      const entries: SDKNativeMessage[] = [
        {
          type: 'queue-operation',
          operation: 'enqueue',
          content: 'some other content',
        },
      ];

      const results = collectAsyncSubagentResults(entries);
      expect(results.size).toBe(0);
    });

    it('skips notifications without a task-id or status', () => {
      const entries: SDKNativeMessage[] = [
        {
          type: 'queue-operation',
          operation: 'enqueue',
          content: '<task-notification><status>completed</status><result>No task-id</result></task-notification>',
        },
        {
          type: 'queue-operation',
          operation: 'enqueue',
          content: '<task-notification><task-id>no-status</task-id><result>Done</result></task-notification>',
        },
      ];

      const results = collectAsyncSubagentResults(entries);
      expect(results.size).toBe(0);
    });

    it('describes a notification without result or summary by its status', () => {
      const entries: SDKNativeMessage[] = [
        {
          type: 'queue-operation',
          operation: 'enqueue',
          content: '<task-notification><task-id>has-id</task-id><status>completed</status></task-notification>',
        },
      ];

      expect(collectAsyncSubagentResults(entries).get('has-id'))
        .toEqual({ result: 'Background task completed.', status: 'completed', summaryOnly: true });
    });

    it('reads a summary-only notification as the live notification parser does', () => {
      const content = '<task-notification><task-id>failed-agent</task-id><status>failed</status>'
        + '<summary>Agent "Review code" failed</summary></task-notification>';

      expect(parseClaudeTaskNotification(content)).toEqual({ taskId: 'failed-agent', content: 'Agent "Review code" failed', hasResult: false });
      expect(collectAsyncSubagentResults([{ type: 'queue-operation', operation: 'enqueue', content }]).get('failed-agent'))
        .toEqual({ result: 'Agent "Review code" failed', status: 'failed', summaryOnly: true });
    });

    it('ignores non-queue-operation messages', () => {
      const entries: SDKNativeMessage[] = [
        { type: 'user', uuid: 'u1', message: { content: 'hello' } },
        { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'hi' }] } },
      ];

      const results = collectAsyncSubagentResults(entries);
      expect(results.size).toBe(0);
    });
  });

  describe('resolveToolUseResultStatus', () => {
    it('preserves orphaned fallback when the tool result has no stronger signal', () => {
      expect(resolveToolUseResultStatus(undefined, 'orphaned')).toBe('orphaned');
      expect(resolveToolUseResultStatus({ status: 'unknown' }, 'orphaned')).toBe('orphaned');
    });

    it('maps task notification failure statuses to error', () => {
      expect(resolveToolUseResultStatus({ status: 'failed' }, 'completed')).toBe('error');
      expect(resolveToolUseResultStatus({ status: 'stopped' }, 'completed')).toBe('error');
      expect(resolveToolUseResultStatus({ status: 'killed' }, 'completed')).toBe('error');
    });
  });

});
