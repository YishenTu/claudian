import { transformSDKMessage } from '@/core/sdk/transformSDKMessage';
import type { SDKMessage } from '@/core/types';

describe('transformSDKMessage', () => {
  describe('system messages', () => {
    it('yields session_init event for init subtype with session_id', () => {
      const message: SDKMessage = {
        type: 'system',
        subtype: 'init',
        session_id: 'test-session-123',
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'session_init', sessionId: 'test-session-123' },
      ]);
    });

    it('yields nothing for system messages without init subtype', () => {
      const message: SDKMessage = {
        type: 'system',
        subtype: 'status',
        session_id: 'test-session',
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('yields compact_boundary event for compact_boundary subtype', () => {
      const message: SDKMessage = {
        type: 'system',
        subtype: 'compact_boundary',
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'compact_boundary' },
      ]);
    });

    it('yields nothing for init messages without session_id', () => {
      const message: SDKMessage = {
        type: 'system',
        subtype: 'init',
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('captures agents from init message', () => {
      const message: SDKMessage = {
        type: 'system',
        subtype: 'init',
        session_id: 'test-session-456',
        agents: ['Explore', 'Plan', 'custom-agent'],
        skills: ['commit', 'review-pr'],
        slash_commands: ['clear', 'add-dir'],
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        type: 'session_init',
        sessionId: 'test-session-456',
        agents: ['Explore', 'Plan', 'custom-agent'],
      });
    });
  });

  describe('assistant messages', () => {
    it('yields text content block', () => {
      const message: SDKMessage = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello, world!' },
          ],
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'text', content: 'Hello, world!', parentToolUseId: null },
      ]);
    });

    it('yields thinking content block', () => {
      const message: SDKMessage = {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me think about this...' },
          ],
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'thinking', content: 'Let me think about this...', parentToolUseId: null },
      ]);
    });

    it('yields tool_use content block with all fields', () => {
      const message: SDKMessage = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-123',
              name: 'Read',
              input: { file_path: '/test/file.ts' },
            },
          ],
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        {
          type: 'tool_use',
          id: 'tool-123',
          name: 'Read',
          input: { file_path: '/test/file.ts' },
          parentToolUseId: null,
        },
      ]);
    });

    it('generates fallback id for tool_use without id', () => {
      const message: SDKMessage = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash' },
          ],
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results.length).toBe(1);
      expect(results[0].type).toBe('tool_use');
      expect((results[0] as any).id).toMatch(/^tool-\d+-\w+$/);
      expect((results[0] as any).name).toBe('Bash');
      expect((results[0] as any).input).toEqual({});
    });

    it('handles multiple content blocks', () => {
      const message: SDKMessage = {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Thinking...' },
            { type: 'text', text: 'Here is my response' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
          ],
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ type: 'thinking', content: 'Thinking...', parentToolUseId: null });
      expect(results[1]).toEqual({ type: 'text', content: 'Here is my response', parentToolUseId: null });
      expect(results[2]).toMatchObject({ type: 'tool_use', id: 'tool-1', name: 'Read' });
    });

    it('preserves parent_tool_use_id for subagent context', () => {
      const message: SDKMessage = {
        type: 'assistant',
        parent_tool_use_id: 'parent-tool-abc',
        message: {
          content: [
            { type: 'text', text: 'Subagent response' },
          ],
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'text', content: 'Subagent response', parentToolUseId: 'parent-tool-abc' },
      ]);
    });

    it('handles empty content array', () => {
      const message: SDKMessage = {
        type: 'assistant',
        message: { content: [] },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('handles missing message.content', () => {
      const message: SDKMessage = {
        type: 'assistant',
        message: {},
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('skips empty text blocks', () => {
      const message: SDKMessage = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '' },
            { type: 'text', text: 'Valid text' },
          ],
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'text', content: 'Valid text', parentToolUseId: null },
      ]);
    });

    it('skips empty thinking blocks', () => {
      const message: SDKMessage = {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'thinking', thinking: 'Valid thinking' },
          ],
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'thinking', content: 'Valid thinking', parentToolUseId: null },
      ]);
    });
  });

  describe('user messages', () => {
    it('yields blocked event for blocked tool calls', () => {
      const message = {
        type: 'user' as const,
        _blocked: true,
        _blockReason: 'Command blocked: rm -rf /',
      };

      const results = [...transformSDKMessage(message as SDKMessage)];

      expect(results).toEqual([
        { type: 'blocked', content: 'Command blocked: rm -rf /' },
      ]);
    });

    it('yields tool_result for tool_use_result with parent_tool_use_id', () => {
      const message: SDKMessage = {
        type: 'user',
        parent_tool_use_id: 'tool-123',
        tool_use_result: 'File contents here',
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        {
          type: 'tool_result',
          id: 'tool-123',
          content: 'File contents here',
          isError: false,
          parentToolUseId: 'tool-123',
          toolUseResult: 'File contents here',
        },
      ]);
    });

    it('stringifies non-string tool_use_result', () => {
      const message: SDKMessage = {
        type: 'user',
        parent_tool_use_id: 'tool-123',
        tool_use_result: { status: 'success', data: [1, 2, 3] },
      };

      const results = [...transformSDKMessage(message)];

      expect(results.length).toBe(1);
      expect(results[0].type).toBe('tool_result');
      expect((results[0] as any).content).toContain('"status": "success"');
    });

    it('yields tool_result from message.content blocks', () => {
      const message: SDKMessage = {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-456',
              content: 'Result content',
              is_error: false,
            },
          ],
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        {
          type: 'tool_result',
          id: 'tool-456',
          content: 'Result content',
          isError: false,
          parentToolUseId: null,
        },
      ]);
    });

    it('handles tool_result with is_error flag', () => {
      const message: SDKMessage = {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-error',
              content: 'Error: File not found',
              is_error: true,
            },
          ],
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        {
          type: 'tool_result',
          id: 'tool-error',
          content: 'Error: File not found',
          isError: true,
          parentToolUseId: null,
        },
      ]);
    });

    it('stringifies non-string content in tool_result blocks', () => {
      const message: SDKMessage = {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-obj',
              content: { key: 'value' },
            },
          ],
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results.length).toBe(1);
      expect((results[0] as any).content).toContain('"key": "value"');
    });

    it('uses parent_tool_use_id as fallback for tool_result id', () => {
      const message: SDKMessage = {
        type: 'user',
        parent_tool_use_id: 'fallback-id',
        message: {
          content: [
            { type: 'tool_result', content: 'Some result' },
          ],
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results.length).toBe(1);
      expect((results[0] as any).id).toBe('fallback-id');
    });

    it('yields nothing for user messages without tool results', () => {
      const message: SDKMessage = {
        type: 'user',
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });
  });

  describe('stream_event messages', () => {
    it('yields tool_use for content_block_start with tool_use', () => {
      const message: SDKMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'stream-tool-1',
            name: 'Write',
            input: { file_path: '/test.ts' },
          },
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        {
          type: 'tool_use',
          id: 'stream-tool-1',
          name: 'Write',
          input: { file_path: '/test.ts' },
          parentToolUseId: null,
        },
      ]);
    });

    it('generates fallback id for content_block_start without id', () => {
      const message: SDKMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            name: 'Glob',
          },
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results.length).toBe(1);
      expect((results[0] as any).id).toMatch(/^tool-\d+$/);
    });

    it('yields thinking for content_block_start with thinking', () => {
      const message: SDKMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'thinking',
            thinking: 'Initial thinking...',
          },
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'thinking', content: 'Initial thinking...', parentToolUseId: null },
      ]);
    });

    it('yields text for content_block_start with text', () => {
      const message: SDKMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'text',
            text: 'Starting response...',
          },
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'text', content: 'Starting response...', parentToolUseId: null },
      ]);
    });

    it('yields thinking for thinking_delta', () => {
      const message: SDKMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'thinking_delta',
            thinking: 'More thinking...',
          },
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'thinking', content: 'More thinking...', parentToolUseId: null },
      ]);
    });

    it('yields text for text_delta', () => {
      const message: SDKMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: ' additional text',
          },
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'text', content: ' additional text', parentToolUseId: null },
      ]);
    });

    it('yields nothing for empty thinking in content_block_start', () => {
      const message: SDKMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'thinking',
            thinking: '',
          },
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('yields nothing for empty text in content_block_start', () => {
      const message: SDKMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'text',
            text: '',
          },
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('yields nothing for empty thinking_delta', () => {
      const message: SDKMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'thinking_delta',
            thinking: '',
          },
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('yields nothing for empty text_delta', () => {
      const message: SDKMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: '',
          },
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });

    it('preserves parent_tool_use_id in stream events', () => {
      const message: SDKMessage = {
        type: 'stream_event',
        parent_tool_use_id: 'subagent-parent',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: 'Subagent stream text',
          },
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'text', content: 'Subagent stream text', parentToolUseId: 'subagent-parent' },
      ]);
    });

    it('handles missing event property', () => {
      const message: SDKMessage = {
        type: 'stream_event',
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });
  });

  describe('result messages', () => {
    it('yields nothing for result messages (usage extracted from assistant messages now)', () => {
      // Usage is now extracted from assistant messages for accuracy.
      // Result message usage is aggregated across main + subagents, causing inaccurate spikes.
      const message: SDKMessage = {
        type: 'result',
        model: 'claude-sonnet-4-5-20250514',
        modelUsage: {
          'claude-sonnet-4-5-20250514': {
            inputTokens: 1000,
            cacheCreationInputTokens: 500,
            cacheReadInputTokens: 200,
          },
        },
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });
  });

  describe('assistant message usage extraction', () => {
    it('yields usage info from main agent assistant message', () => {
      const message: SDKMessage = {
        type: 'assistant',
        parent_tool_use_id: null, // Main agent
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 200,
          },
        } as any,
      };

      const results = [...transformSDKMessage(message, { intendedModel: 'sonnet' })];

      // Should have text chunk + usage chunk
      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(1);

      const usage = (usageResults[0] as any).usage;
      expect(usage.inputTokens).toBe(1000);
      expect(usage.cacheCreationInputTokens).toBe(300);
      expect(usage.cacheReadInputTokens).toBe(200);
      expect(usage.contextTokens).toBe(1500); // 1000 + 300 + 200
      expect(usage.contextWindow).toBe(200000); // Standard context window
      expect(usage.percentage).toBe(1); // 1500 / 200000 * 100 rounded
    });

    it('skips usage extraction for subagent messages', () => {
      const message: SDKMessage = {
        type: 'assistant',
        parent_tool_use_id: 'subagent-task-123', // Subagent
        message: {
          content: [{ type: 'text', text: 'Subagent response' }],
          usage: {
            input_tokens: 5000,
            output_tokens: 1000,
            cache_creation_input_tokens: 500,
            cache_read_input_tokens: 100,
          },
        } as any,
      };

      const results = [...transformSDKMessage(message)];

      // Should only have text chunk, no usage (subagent messages filtered)
      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(0);
    });

    it('uses 1M context window when is1MEnabled is true for sonnet', () => {
      const message: SDKMessage = {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 50000,
            output_tokens: 10000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        } as any,
      };

      const results = [...transformSDKMessage(message, { intendedModel: 'sonnet', is1MEnabled: true })];

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(1);

      const usage = (usageResults[0] as any).usage;
      expect(usage.contextWindow).toBe(1000000); // 1M context window
      expect(usage.percentage).toBe(5); // 50000 / 1000000 * 100 = 5%
    });

    it('uses custom context limits when provided', () => {
      const message: SDKMessage = {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 50000,
            output_tokens: 10000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        } as any,
      };

      const results = [...transformSDKMessage(message, {
        intendedModel: 'custom-model',
        customContextLimits: { 'custom-model': 500000 },
      })];

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(1);

      const usage = (usageResults[0] as any).usage;
      expect(usage.contextWindow).toBe(500000); // Custom context limit
      expect(usage.percentage).toBe(10); // 50000 / 500000 * 100 = 10%
    });

    it('prioritizes custom context limits over 1M setting', () => {
      const message: SDKMessage = {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 100000,
            output_tokens: 10000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        } as any,
      };

      const results = [...transformSDKMessage(message, {
        intendedModel: 'sonnet',
        is1MEnabled: true,
        customContextLimits: { 'sonnet': 256000 },
      })];

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(1);

      const usage = (usageResults[0] as any).usage;
      expect(usage.contextWindow).toBe(256000); // Custom limit takes precedence over 1M
      expect(usage.percentage).toBe(39); // 100000 / 256000 * 100 ≈ 39%
    });

    it('handles missing usage field gracefully', () => {
      const message: SDKMessage = {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
      };

      const results = [...transformSDKMessage(message)];

      // Should only have text chunk, no usage
      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(0);
    });

    it('handles missing token fields with defaults', () => {
      const message: SDKMessage = {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {}, // Empty usage object
        } as any,
      };

      const results = [...transformSDKMessage(message, { intendedModel: 'sonnet' })];

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(1);

      const usage = (usageResults[0] as any).usage;
      expect(usage.inputTokens).toBe(0);
      expect(usage.cacheCreationInputTokens).toBe(0);
      expect(usage.cacheReadInputTokens).toBe(0);
      expect(usage.contextTokens).toBe(0);
    });
  });

  describe('error messages', () => {
    it('yields error event with error content', () => {
      const message: SDKMessage = {
        type: 'error',
        error: 'Something went wrong',
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([
        { type: 'error', content: 'Something went wrong' },
      ]);
    });

    it('yields nothing for error message without error field', () => {
      const message: SDKMessage = {
        type: 'error',
      };

      const results = [...transformSDKMessage(message)];

      expect(results).toEqual([]);
    });
  });
});
