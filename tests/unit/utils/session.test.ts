import type { ChatMessage, ToolCallInfo } from '@/core/types';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
  formatToolCallForContext,
  isSessionMissingError,
} from '@/utils/session';

describe('session utilities', () => {
  describe('isSessionMissingError', () => {

    it('returns true for the Claude missing-conversation error', () => {
      const error = new Error('No conversation found with session ID: session-123');
      expect(isSessionMissingError(error)).toBe(true);
      expect(isSessionMissingError(error, 'session-123')).toBe(true);
      expect(isSessionMissingError(error, 'different-session')).toBe(false);
    });

    it('does not classify generic not-found wording as confirmed provider deletion', () => {
      expect(isSessionMissingError(new Error('Session not found'))).toBe(false);
      expect(isSessionMissingError(new Error('No conversation found'))).toBe(false);
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
        result: 'Access denied by user approval',
      };

      const result = formatToolCallForContext(toolCall);

      expect(result).toBe('[Tool Bash input: command=rm -rf / status=blocked] error: Access denied by user approval');
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
  });

  describe('buildContextFromHistory', () => {
    it.each([
      ['short', 'short'],
      ['x'.repeat(500), 'x'.repeat(500)],
      ['x'.repeat(700), 'x'.repeat(500) + '... (truncated)'],
    ])('bounds failed tool results in compact history (%#)', (result, expected) => {
      const messages: ChatMessage[] = [{
        id: 'assistant', role: 'assistant', content: '', timestamp: 1000,
        toolCalls: [{ id: 'tool', name: 'Bash', input: {}, status: 'error', result }],
      }];
      expect(buildContextFromHistory(messages)).toBe(`Assistant:\n[Tool Bash status=error] error: ${expected}`);
    });

    it.each([undefined, ''])('omits absent Linked content from history (%#)', (linkedContentPath) => {
      const messages: ChatMessage[] = [{
        id: 'user', role: 'user', content: 'Hello', timestamp: 1000, linkedContentPath,
      }];
      expect(buildContextFromHistory(messages)).toBe('User: Hello');
    });

    it.each(['error', 'blocked'] as const)('preserves the full %s tool result in captured context', (status) => {
      const diagnostic = `${'Diagnostic detail.\n'.repeat(40)}Recovery requires restoring project-48271.`;
      const messages: ChatMessage[] = [{
        id: 'msg-1',
        role: 'assistant',
        content: '',
        timestamp: 1000,
        toolCalls: [{ id: 'tool-1', name: 'Bash', input: {}, status, result: diagnostic }],
      }];

      const captured = buildContextFromHistory(messages, { preserveCapturedContext: true });
      const compact = buildContextFromHistory(messages);

      expect(captured).toContain(diagnostic);
      expect(compact).toContain('(truncated)');
      expect(compact).not.toContain('Recovery requires restoring project-48271.');
    });

    it('retains complete structured tool arguments in the initial captured context', () => {
      const content = `${'original line\n'.repeat(30)}Keep project-48271`;
      const history: ChatMessage[] = [{
        id: 'assistant-1', role: 'assistant', content: '', timestamp: 1,
        toolCalls: [{
          id: 'tool-1', name: 'Write', status: 'completed', result: 'Written',
          input: { content, operations: [{ replacement: 'nested-value', previous: null }] },
        }],
      }];
      const context = buildContextFromHistory(history, { preserveCapturedContext: true });
      expect(context).toContain('Keep project-48271');
      expect(context).toContain('"operations":[{"replacement":"nested-value","previous":null}]');
    });

    it('includes canonical Linked content context for user messages', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          role: 'user',
          content: 'Analyze this note',
          timestamp: 1000,
          linkedContentPath: 'notes/important.md',
        },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toBe('User: <linked_content path="notes/important.md" />\n\nAnalyze this note');
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

      expect(result).toBe('User: Test\n\nAssistant: Response\n[Tool Success status=completed]\n[Tool Failed status=error] error: error msg');

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

  describe('buildPromptWithHistoryContext', () => {
    it('retains a repeated question when the previous occurrence already has an answer', () => {
      const history: ChatMessage[] = [
        { id: 'u1', role: 'user', content: 'Continue', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'Prior answer', timestamp: 2 },
      ];
      expect(buildPromptWithHistoryContext(
        'User: Continue\n\nAssistant: Prior answer', 'Continue', 'Continue', history,
      )).toBe('User: Continue\n\nAssistant: Prior answer\n\nUser: Continue');
    });

    it('does not duplicate the latest unanswered input followed by an empty assistant placeholder', () => {
      const history: ChatMessage[] = [
        { id: 'u0', role: 'user', content: 'Earlier question', timestamp: 0 },
        { id: 'a0', role: 'assistant', content: 'Earlier answer', timestamp: 1 },
        { id: 'u1', role: 'user', content: 'Continue', timestamp: 2 },
        { id: 'a1', role: 'assistant', content: '', timestamp: 3 },
      ];
      expect(buildPromptWithHistoryContext('User: Continue', 'Continue', 'Continue', history))
        .toBe('User: Continue');
    });

    it('returns prompt unchanged when historyContext is null', () => {
      const prompt = '<query>\nhello\n</query>';
      const result = buildPromptWithHistoryContext(null, prompt, 'hello', []);

      expect(result).toBe(prompt);
    });

    it('appends the current prompt when the matching historical question already has an answer', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'hello', timestamp: 1000 },
        { id: 'msg-2', role: 'assistant', content: 'hi', timestamp: 2000 },
      ];
      const historyContext = 'User: hello\n\nAssistant: hi';
      const prompt = '<query>\nhello\n</query>';
      const actualPrompt = 'hello';

      const result = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, messages);

      expect(result).toBe(`${historyContext}\n\nUser: ${prompt}`);
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

    it.each<{ messages: ChatMessage[] }>([
      { messages: [] },
      { messages: [{ id: 'msg-1', role: 'assistant', content: 'welcome', timestamp: 1000 }] },
    ])('appends prompt when no user messages in history (%#)', ({ messages }) => {
      const historyContext = 'Assistant: welcome';
      const prompt = '<query>\nhello\n</query>';
      const actualPrompt = 'hello';

      const result = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, messages);

      expect(result).toBe('Assistant: welcome\n\nUser: <query>\nhello\n</query>');
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

    describe('new format (user content before XML context)', () => {
      it('avoids duplication when actualPrompt matches last user message', () => {
        const prompt = 'Explain this\n\n<linked_note>\ntest.md\n</linked_note>';
        const actualPrompt = 'Explain this\n\n<linked_note>\ntest.md\n</linked_note>';
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            role: 'user',
            content: prompt,
            displayContent: 'Explain this',
            timestamp: 1000,
          },
        ];
        const historyContext = 'User: Explain this';

        const result = buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, messages);

        expect(result).toBe(historyContext);
      });

      it('appends prompt when actualPrompt differs from last user message', () => {
        const oldPrompt = 'First question\n\n<linked_note>\nold.md\n</linked_note>';
        const newPrompt = 'Second question\n\n<linked_note>\nnew.md\n</linked_note>';
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            role: 'user',
            content: oldPrompt,
            displayContent: 'First question',
            timestamp: 1000,
          },
        ];
        const historyContext = 'User: First question\n\nAssistant: response';

        const result = buildPromptWithHistoryContext(historyContext, newPrompt, newPrompt, messages);

        expect(result).toContain(historyContext);
        expect(result).toContain('User: Second question');
      });

      it('extracts user query from editor_selection format', () => {
        const prompt = 'Refactor this\n\n<editor_selection path="src/main.ts">\ncode here\n</editor_selection>';
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            role: 'user',
            content: prompt,
            displayContent: 'Refactor this',
            timestamp: 1000,
          },
        ];
        const historyContext = 'User: Refactor this';

        const result = buildPromptWithHistoryContext(historyContext, prompt, prompt, messages);

        expect(result).toBe(historyContext);
      });

      it('extracts user query from content with multiple XML context tags', () => {
        const prompt = 'Update code\n\n<linked_note>\ntest.md\n</linked_note>\n\n<editor_selection path="test.md">\nselected\n</editor_selection>';
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            role: 'user',
            content: prompt,
            displayContent: 'Update code',
            timestamp: 1000,
          },
        ];
        const historyContext = 'User: Update code';

        const result = buildPromptWithHistoryContext(historyContext, prompt, prompt, messages);

        expect(result).toBe(historyContext);
      });

      it('falls back to extractUserQuery when displayContent is not available', () => {
        const prompt = 'Help me\n\n<linked_note>\nfile.md\n</linked_note>';
        const messages: ChatMessage[] = [
          {
            id: 'msg-1',
            role: 'user',
            content: prompt,
            // No displayContent - should extract from content
            timestamp: 1000,
          },
        ];
        const historyContext = 'User: Help me';

        const result = buildPromptWithHistoryContext(historyContext, prompt, prompt, messages);

        expect(result).toBe(historyContext);
      });
    });
  });

  describe('formatToolCallForContext edge cases', () => {
    it('formats tool call with object input value', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-1',
        name: 'Write',
        input: { config: { nested: true }, count: 42 },
        status: 'completed',
      };

      const result = formatToolCallForContext(toolCall);

      expect(result).toContain('config=[object]');
      expect(result).toContain('count=42');
    });

    it('skips null and undefined input values', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-1',
        name: 'Read',
        input: { path: '/file.md', optional: null, missing: undefined },
        status: 'completed',
      };

      const result = formatToolCallForContext(toolCall);

      expect(result).toContain('path=/file.md');
      expect(result).not.toContain('optional');
      expect(result).not.toContain('missing');
    });

    it('truncates long overall input string', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-1',
        name: 'Bash',
        input: {
          a: 'x'.repeat(80),
          b: 'y'.repeat(80),
          c: 'z'.repeat(80),
        },
        status: 'completed',
      };

      const result = formatToolCallForContext(toolCall);

      expect(result).toBe(
        '[Tool Bash input: a=' + 'x'.repeat(80) + ', b=' + 'y'.repeat(80)
        + ', c=' + 'z'.repeat(30) + '... status=completed]',
      );
    });

    it('formats whitespace-only result for failed tool without error detail', () => {
      const toolCall: ToolCallInfo = {
        id: 'tool-1',
        name: 'Bash',
        input: {},
        status: 'error',
        result: '   \n  ',
      };

      const result = formatToolCallForContext(toolCall);

      expect(result).toBe('[Tool Bash status=error]');
    });
  });

  describe('buildContextFromHistory edge cases', () => {
    it('skips interrupt messages', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Start task', timestamp: 1000 },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Working on it...',
          timestamp: 2000,
        },
        {
          id: 'msg-3',
          role: 'user',
          content: '',
          timestamp: 3000,
          isInterrupt: true,
        },
        {
          id: 'msg-4',
          role: 'assistant',
          content: 'Stopped.',
          timestamp: 4000,
        },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('User: Start task');
      expect(result).toContain('Assistant: Working on it...');
      expect(result).toContain('Assistant: Stopped.');
      // Interrupt message should not appear as a user message
      expect(result.match(/User:/g)?.length).toBe(1);
    });

    it('includes contentful interrupted assistant messages', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Compare options', timestamp: 1000 },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Option A is safer, while option B is faster.',
          timestamp: 2000,
          isInterrupt: true,
        },
        { id: 'msg-3', role: 'user', content: 'Use option B instead', timestamp: 3000 },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('Assistant: Option A is safer, while option B is faster.');
      expect(result).toContain('User: Use option B instead');
    });

    it('skips empty interrupted assistant signals', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Start task', timestamp: 1000 },
        {
          id: 'msg-2',
          role: 'assistant',
          content: '',
          timestamp: 2000,
          isInterrupt: true,
        },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toBe('User: Start task');
    });

    it('includes assistant message with only thinking blocks and no text', () => {
      const messages: ChatMessage[] = [
        { id: 'msg-1', role: 'user', content: 'Think hard', timestamp: 1000 },
        {
          id: 'msg-2',
          role: 'assistant',
          content: '',
          timestamp: 2000,
          contentBlocks: [
            { type: 'thinking', content: 'Deep thought...', durationSeconds: 10 },
          ],
        },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('[Thinking: 1 block(s), 10.0s total]');
    });

    it('handles user message with currentNote but no content', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          role: 'user',
          content: '',
          timestamp: 1000,
          currentNote: 'notes/active.md',
        },
      ];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('notes/active.md');
    });

    it('skips messages with unknown roles', () => {
      const messages = [
        { id: 'msg-1', role: 'user', content: 'Hello', timestamp: 1000 },
        { id: 'msg-2', role: 'system' as any, content: 'System msg', timestamp: 1500 },
        { id: 'msg-3', role: 'assistant', content: 'Response', timestamp: 2000 },
      ] as ChatMessage[];

      const result = buildContextFromHistory(messages);

      expect(result).toContain('User: Hello');
      expect(result).toContain('Assistant: Response');
      expect(result).not.toContain('System msg');
    });
  });
});
