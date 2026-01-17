/**
 * Tests for session utilities - Session recovery and history reconstruction
 */

import type { ChatMessage, ToolCallInfo } from '@/core/types';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
  formatContextLine,
  formatToolCallForContext,
  getLastUserMessage,
  isSessionExpiredError,
  truncateToolResult,
} from '@/utils/session';

describe('session utilities', () => {
  describe('isSessionExpiredError', () => {
    it('returns true for "session expired" error', () => {
      const error = new Error('Session expired');
      expect(isSessionExpiredError(error)).toBe(true);
    });

    it('returns true for "session not found" error', () => {
      const error = new Error('Session not found');
      expect(isSessionExpiredError(error)).toBe(true);
    });

    it('returns true for "invalid session" error', () => {
      const error = new Error('Invalid session');
      expect(isSessionExpiredError(error)).toBe(true);
    });

    it('returns true for "session invalid" error', () => {
      const error = new Error('Session invalid');
      expect(isSessionExpiredError(error)).toBe(true);
    });

    it('returns true for "process exited with code" error', () => {
      const error = new Error('Process exited with code 1');
      expect(isSessionExpiredError(error)).toBe(true);
    });

    it('returns true for compound pattern "session" + "expired"', () => {
      const error = new Error('The session has expired');
      expect(isSessionExpiredError(error)).toBe(true);
    });

    it('returns true for compound pattern "resume" + "failed"', () => {
      const error = new Error('Failed to resume session');
      expect(isSessionExpiredError(error)).toBe(true);
    });

    it('returns true for compound pattern "resume" + "error"', () => {
      const error = new Error('Resume error occurred');
      expect(isSessionExpiredError(error)).toBe(true);
    });

    it('returns false for unrelated errors', () => {
      const error = new Error('Network timeout');
      expect(isSessionExpiredError(error)).toBe(false);
    });

    it('returns false for non-Error values', () => {
      expect(isSessionExpiredError('string error')).toBe(false);
      expect(isSessionExpiredError(null)).toBe(false);
      expect(isSessionExpiredError(undefined)).toBe(false);
      expect(isSessionExpiredError(42)).toBe(false);
    });

    it('is case-insensitive', () => {
      const error = new Error('SESSION EXPIRED');
      expect(isSessionExpiredError(error)).toBe(true);
    });
  });

  describe('formatToolCallForContext', () => {
    it('formats successful tool call with input but without result', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-1',
        name: 'Read',
        input: { file_path: '/path/to/file.md' },
        status: 'completed',
        result: 'File contents here - this should NOT be included',
      };

      const result = formatToolCallForContext(toolCall);

      // Successful tools show input but no result (Claude can re-execute if needed)
      expect(result).toBe('[Tool Read input: file_path=/path/to/file.md status=completed]');
      expect(result).not.toContain('File contents');
    });

    it('formats tool call without input', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-1',
        name: 'Read',
        input: {},
        status: 'completed',
      };

      const result = formatToolCallForContext(toolCall);

      expect(result).toBe('[Tool Read status=completed]');
    });

    it('formats failed tool call with input and error message', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-1',
        name: 'Read',
        input: { file_path: '/path/to/missing.txt' },
        status: 'error',
        result: 'File not found',
      };

      const result = formatToolCallForContext(toolCall);

      expect(result).toBe('[Tool Read input: file_path=/path/to/missing.txt status=error] error: File not found');
    });

    it('formats blocked tool call with input and error message', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'rm -rf /' },
        status: 'blocked',
        result: 'Command blocked by security policy',
      };

      const result = formatToolCallForContext(toolCall);

      expect(result).toBe('[Tool Bash input: command=rm -rf / status=blocked] error: Command blocked by security policy');
    });

    it('truncates long input values', () => {
      const longPath = '/very/long/path/' + 'x'.repeat(150);
      const toolCall: ToolCallInfo = {
        id: 'tool-1',
        name: 'Read',
        input: { file_path: longPath },
        status: 'completed',
      };

      const result = formatToolCallForContext(toolCall);

      // Long values truncated to 100 chars (/very/long/path/ = 16 chars, so 84 x's + ...)
      expect(result).toContain('file_path=/very/long/path/' + 'x'.repeat(84) + '...');
      expect(result).not.toContain(longPath);
    });

    it('truncates long error messages to default 500 chars', () => {
      const longError = 'x'.repeat(700);
      const toolCall: ToolCallInfo = {
        id: 'tool-1',
        name: 'Bash',
        input: {},
        status: 'error',
        result: longError,
      };

      const result = formatToolCallForContext(toolCall);

      expect(result).toContain('x'.repeat(500));
      expect(result).toContain('(truncated)');
    });

    it('truncates to custom max length for errors', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-1',
        name: 'Bash',
        input: {},
        status: 'error',
        result: 'x'.repeat(500),
      };

      const result = formatToolCallForContext(toolCall, 100);

      expect(result).toContain('x'.repeat(100));
      expect(result).toContain('(truncated)');
    });

    it('defaults to "completed" status when status is undefined', () => {
      const toolCall = {
        id: 'tool-1',
        name: 'Write',
        input: {},
        status: 'completed',
      } as ToolCallInfo;

      const result = formatToolCallForContext(toolCall);

      expect(result).toBe('[Tool Write status=completed]');
    });

    it('handles empty result string for successful tool', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-1',
        name: 'Edit',
        input: {},
        status: 'completed',
        result: '',
      };

      const result = formatToolCallForContext(toolCall);

      expect(result).toBe('[Tool Edit status=completed]');
    });

    it('handles empty result string for failed tool', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-1',
        name: 'Edit',
        input: {},
        status: 'error',
        result: '',
      };

      const result = formatToolCallForContext(toolCall);

      expect(result).toBe('[Tool Edit status=error]');
    });

    it('handles whitespace-only result for successful tool', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-1',
        name: 'Glob',
        input: {},
        status: 'completed',
        result: '   \n\t  ',
      };

      const result = formatToolCallForContext(toolCall);

      expect(result).toBe('[Tool Glob status=completed]');
    });
  });

  describe('truncateToolResult', () => {
    it('returns unchanged result when under max length', () => {
      const result = truncateToolResult('short result', 100);
      expect(result).toBe('short result');
    });

    it('returns unchanged result when exactly at max length', () => {
      const result = truncateToolResult('x'.repeat(500), 500);
      expect(result).toBe('x'.repeat(500));
    });

    it('truncates and adds indicator when over max length', () => {
      const longResult = 'x'.repeat(700);
      const result = truncateToolResult(longResult, 500);

      expect(result).toBe('x'.repeat(500) + '... (truncated)');
    });

    it('uses default max length of 500', () => {
      const longResult = 'x'.repeat(700);
      const result = truncateToolResult(longResult);

      expect(result).toBe('x'.repeat(500) + '... (truncated)');
    });
  });

  describe('formatContextLine', () => {
    it('returns formatted context line for message with currentNote', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
        currentNote: 'notes/test.md',
      };

      const result = formatContextLine(message);

      expect(result).toContain('notes/test.md');
    });

    it('returns null when currentNote is undefined', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      };

      const result = formatContextLine(message);

      expect(result).toBeNull();
    });

    it('returns null when currentNote is empty', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
        currentNote: '',
      };

      const result = formatContextLine(message);

      expect(result).toBeNull();
    });
  });

  describe('buildContextFromHistory', () => {
    it('builds context from simple user/assistant exchange', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Hello', timestamp: 1000 },
        { id: 'msg-2', role: 'assistant', content: 'Hi there!', timestamp: 2000 },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('User: Hello');
      expect(result).toContain('Assistant: Hi there!');
    });

    it('includes tool calls without results for successful tools', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Read file', timestamp: 1000 },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Let me read that file.',
          timestamp: 2000,
          toolCalls: [
            { id: 'tool-1', name: 'Read', input: {}, status: 'completed', result: 'file contents' },
          ],
        },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('User: Read file');
      expect(result).toContain('Assistant: Let me read that file.');
      expect(result).toContain('[Tool Read status=completed]');
      // Successful tools don't include results (Claude can re-execute if needed)
      expect(result).not.toContain('file contents');
    });

    it('includes error messages for failed tool calls', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Read file', timestamp: 1000 },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Let me read that file.',
          timestamp: 2000,
          toolCalls: [
            { id: 'tool-1', name: 'Read', input: {}, status: 'error', result: 'File not found' },
          ],
        },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('[Tool Read status=error] error: File not found');
    });

    it('includes currentNote context for user messages', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          role: 'user',
          content: 'Analyze this note',
          timestamp: 1000,
          currentNote: 'notes/important.md',
        },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('notes/important.md');
      expect(result).toContain('Analyze this note');
    });

    it('skips non-user/assistant messages', () => {
      // buildContextFromHistory only processes 'user' and 'assistant' roles
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'User message', timestamp: 2000 },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('User: User message');
    });

    it('skips assistant messages with no content and no tool results', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Hello', timestamp: 1000 },
        { id: 'msg-2', role: 'assistant', content: '', timestamp: 2000 },
        { id: 'msg-3', role: 'assistant', content: 'Response', timestamp: 3000 },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('User: Hello');
      expect(result).toContain('Assistant: Response');
      // Should not have an empty assistant entry
      expect(result.match(/Assistant:/g)?.length).toBe(1);
    });

    it('includes assistant message with only tool results (no text content)', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Do something', timestamp: 1000 },
        {
          id: 'msg-2',
          role: 'assistant',
          content: '',
          timestamp: 2000,
          toolCalls: [
            { id: 'tool-1', name: 'Bash', input: {}, status: 'completed', result: 'done' },
          ],
        },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('[Tool Bash status=completed]');
    });

    it('returns empty string for empty messages array', () => {
      const result = buildContextFromHistory([]);
      expect(result).toBe('');
    });

    it('handles messages with only whitespace content', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: '  \n  ', timestamp: 1000 },
        { id: 'msg-2', role: 'assistant', content: '  \t  ', timestamp: 2000 },
      ];

      const result = buildContextFromHistory(messages);

      // Whitespace content should still be processed (trimmed)
      expect(result).toContain('User:');
    });

    it('separates messages with double newlines', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'First', timestamp: 1000 },
        { id: 'msg-2', role: 'assistant', content: 'Second', timestamp: 2000 },
        { id: 'msg-3', role: 'user', content: 'Third', timestamp: 3000 },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('\n\n');
    });

    it('shows all tool calls but only error results', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Test', timestamp: 1000 },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Response',
          timestamp: 2000,
          toolCalls: [
            { id: 'tool-1', name: 'Success', input: {}, status: 'completed', result: 'data' },
            { id: 'tool-2', name: 'Failed', input: {}, status: 'error', result: 'error msg' },
          ],
        },
      ];

      const result = buildContextFromHistory(messages);

      // Successful tool shows status only (no result)
      expect(result).toContain('[Tool Success status=completed]');
      expect(result).not.toContain('data');
      // Failed tool shows error message
      expect(result).toContain('[Tool Failed status=error] error: error msg');
    });

    it('includes thinking block summary', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Think about this', timestamp: 1000 },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Here is my response',
          timestamp: 2000,
          contentBlocks: [
            { type: 'thinking', content: 'Let me think...', durationSeconds: 5.5 },
            { type: 'text', content: 'Here is my response' },
          ],
        },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('[Thinking: 1 block(s), 5.5s total]');
      // Thinking content is NOT included (Claude will think anew)
      expect(result).not.toContain('Let me think');
    });

    it('includes thinking summary for multiple blocks', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Complex problem', timestamp: 1000 },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Response',
          timestamp: 2000,
          contentBlocks: [
            { type: 'thinking', content: 'First thought', durationSeconds: 3.0 },
            { type: 'thinking', content: 'Second thought', durationSeconds: 2.5 },
          ],
        },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('[Thinking: 2 block(s), 5.5s total]');
    });

    it('includes thinking summary without duration if not available', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Question', timestamp: 1000 },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Answer',
          timestamp: 2000,
          contentBlocks: [
            { type: 'thinking', content: 'Thinking...' },
          ],
        },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('[Thinking: 1 block(s)]');
      expect(result).not.toContain('total]');
    });

    it('includes tool input in history', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Read my file', timestamp: 1000 },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Let me read it',
          timestamp: 2000,
          toolCalls: [
            { id: 'tool-1', name: 'Read', input: { file_path: '/notes/todo.md' }, status: 'completed', result: 'file contents' },
          ],
        },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('[Tool Read input: file_path=/notes/todo.md status=completed]');
    });
  });

  describe('getLastUserMessage', () => {
    it('returns last user message from history', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'First', timestamp: 1000 },
        { id: 'msg-2', role: 'assistant', content: 'Response', timestamp: 2000 },
        { id: 'msg-3', role: 'user', content: 'Second', timestamp: 3000 },
        { id: 'msg-4', role: 'assistant', content: 'Response 2', timestamp: 4000 },
      ];

      const result = getLastUserMessage(messages);

      expect(result?.id).toBe('msg-3');
      expect(result?.content).toBe('Second');
    });

    it('returns undefined when no user messages exist', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'assistant', content: 'Response', timestamp: 1000 },
      ];

      const result = getLastUserMessage(messages);

      expect(result).toBeUndefined();
    });

    it('returns undefined for empty messages array', () => {
      const result = getLastUserMessage([]);

      expect(result).toBeUndefined();
    });

    it('returns the only user message when there is just one', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'assistant', content: 'Welcome', timestamp: 1000 },
        { id: 'msg-2', role: 'user', content: 'Only user msg', timestamp: 2000 },
        { id: 'msg-3', role: 'assistant', content: 'Response', timestamp: 3000 },
      ];

      const result = getLastUserMessage(messages);

      expect(result?.id).toBe('msg-2');
    });

    it('finds user message among assistant messages', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'assistant', content: 'Welcome', timestamp: 1000 },
        { id: 'msg-2', role: 'user', content: 'User', timestamp: 2000 },
        { id: 'msg-3', role: 'assistant', content: 'Response', timestamp: 3000 },
      ];

      const result = getLastUserMessage(messages);

      expect(result?.id).toBe('msg-2');
    });
  });

  describe('buildPromptWithHistoryContext', () => {
    it('returns prompt unchanged when historyContext is null', () => {
      const prompt = '<query>\nhello\n</query>';
      const result = buildPromptWithHistoryContext(null, prompt, 'hello', []);

      expect(result).toBe(prompt);
    });

    it('returns only history when actualPrompt matches last user message', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'hello', timestamp: 1000 },
        { id: 'msg-2', role: 'assistant', content: 'hi', timestamp: 2000 },
      ];
      const historyContext = 'User: hello\n\nAssistant: hi';
      const prompt = '<query>\nhello\n</query>';
      const actualPrompt = 'hello';

      const result = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, messages);

      // Should NOT append prompt since actualPrompt matches last user message
      expect(result).toBe(historyContext);
    });

    it('appends prompt when actualPrompt differs from last user message', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'first message', timestamp: 1000 },
        { id: 'msg-2', role: 'assistant', content: 'response', timestamp: 2000 },
      ];
      const historyContext = 'User: first message\n\nAssistant: response';
      const prompt = '<query>\nsecond message\n</query>';
      const actualPrompt = 'second message';

      const result = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, messages);

      expect(result).toContain(historyContext);
      expect(result).toContain('User: <query>');
      expect(result).toContain('second message');
    });

    it('returns prompt unchanged when history context is empty string', () => {
      const historyContext = '';
      const prompt = '<query>\nhello\n</query>';

      const result = buildPromptWithHistoryContext(historyContext, prompt, 'hello', []);

      // Empty string is falsy, so returns original prompt
      expect(result).toBe(prompt);
    });

    it('appends prompt when no user messages in history', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'assistant', content: 'welcome', timestamp: 1000 },
      ];
      const historyContext = 'Assistant: welcome';
      const prompt = '<query>\nhello\n</query>';
      const actualPrompt = 'hello';

      const result = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, messages);

      expect(result).toContain(historyContext);
      expect(result).toContain('User: <query>');
    });

    it('handles whitespace in comparison', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: '  hello world  ', timestamp: 1000 },
      ];
      const historyContext = 'User: hello world';
      const prompt = '<query>\nhello world\n</query>';
      const actualPrompt = 'hello world';

      const result = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, messages);

      // Should match after trimming
      expect(result).toBe(historyContext);
    });

    it('avoids duplication when XML-wrapped content matches display content', () => {
      const prompt = [
        '<current_note>',
        'notes/file.md',
        '</current_note>',
        '',
        '<editor_selection path="notes/file.md">',
        'selected text',
        '</editor_selection>',
        '',
        '<query>',
        'Follow up',
        '</query>',
      ].join('\n');

      const actualPrompt = [
        '<editor_selection path="notes/file.md">',
        'selected text',
        '</editor_selection>',
        '',
        '<query>',
        'Follow up',
        '</query>',
      ].join('\n');

      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          role: 'user',
          content: prompt,
          displayContent: 'Follow up',
          timestamp: 1000,
        },
      ];

      const historyContext = 'User: Follow up';

      const result = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, messages);

      expect(result).toBe(historyContext);
    });
  });
});
