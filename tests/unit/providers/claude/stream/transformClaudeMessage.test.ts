import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildSDKMessage } from '@test/helpers/sdkMessages';

import {
  createTransformStreamState,
  createTransformUsageState,
  type TransformOptions,
  transformSDKMessage,
} from '@/providers/claude/stream/transformClaudeMessage';

const msg = buildSDKMessage;

function transform(message: SDKMessage, options: Partial<TransformOptions> = {}) {
  return [...transformSDKMessage(message, {
    streamState: createTransformStreamState(),
    usageState: createTransformUsageState(),
    ...options,
  })];
}

describe('transformSDKMessage', () => {
  describe('system messages', () => {
    it('yields session_init event for init subtype with session_id', () => {
      const message = msg({
        type: 'system',
        subtype: 'init',
        session_id: 'test-session-123',
      });

      const results = transform(message);

      expect(results).toEqual([
        {
          type: 'session_init',
          sessionId: 'test-session-123',
          permissionMode: 'default',
        },
      ]);
    });

    it('yields nothing for system messages without init subtype', () => {
      const message = msg({
        type: 'system',
        subtype: 'status',
        session_id: 'test-session',
      });

      const results = transform(message);

      expect(results).toEqual([]);
    });

    it('emits an authoritative blocked tool result for permission denials', () => {
      const message = {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'tool-123',
        decision_reason: 'Denied by policy',
        message: 'The tool was not run.',
        uuid: 'message-123',
        session_id: 'test-session',
      } as any;

      const results = transform(message);

      expect(results).toEqual([{
        type: 'tool_result',
        id: 'tool-123',
        content: 'The tool was not run.',
        isError: true,
        isBlocked: true,
      }]);
    });

    it('yields context_compacted event for compact_boundary subtype', () => {
      const message = msg({
        type: 'system',
        subtype: 'compact_boundary',
      });

      const results = transform(message);

      expect(results).toEqual([
        { type: 'context_compacted' },
      ]);
    });

    it('captures permissionMode from init message', () => {
      const message = msg({
        type: 'system',
        subtype: 'init',
        session_id: 'test-session-789',
        permissionMode: 'plan',
      });

      const results = transform(message);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        type: 'session_init',
        sessionId: 'test-session-789',
        permissionMode: 'plan',
      });
    });

    it('normalizes task_notification into a scoped completion event', () => {
      const message = msg({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-123',
        tool_use_id: 'task-123',
        status: 'completed',
        output_file: '/tmp/agent-123.output',
        summary: 'Agent completed successfully.',
      } as any);

      const results = transform(message);

      expect(results).toEqual([
        {
          type: 'async_subagent_completion',
          providerSessionId: 'test-session',
          taskId: 'agent-123',
          toolUseId: 'task-123',
          status: 'completed',
          result: 'Agent completed successfully.',
        },
      ]);
    });

    it('maps non-completed task_notification statuses to async subagent errors', () => {
      const message = msg({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-failed',
        status: 'failed',
        output_file: '/tmp/agent-failed.output',
        summary: 'Agent failed.',
      } as any);

      const results = transform(message);

      expect(results).toEqual([
        {
          type: 'async_subagent_completion',
          providerSessionId: 'test-session',
          taskId: 'agent-failed',
          status: 'error',
          result: 'Agent failed.',
        },
      ]);
    });
  });

  describe('assistant messages', () => {

    it('normalizes mixed assistant blocks in order without inventing usage', () => {
      const message = msg({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me think about this...' },
            { type: 'text', text: 'Hello, world!' },
            { type: 'tool_use', id: 'tool-123', name: 'Read', input: { file_path: '/test/file.ts' } },
          ],
        },
      });

      const results = transform(message);

      expect(results).toEqual([
        { type: 'thinking', content: 'Let me think about this...' },
        { type: 'text', content: 'Hello, world!' },
        { type: 'tool_use', id: 'tool-123', name: 'Read', input: { file_path: '/test/file.ts' } },
      ]);
    });

    it('yields subagent_tool_use for assistant tool_use in subagent context', () => {
      const message = msg({
        type: 'assistant',
        parent_tool_use_id: 'parent-tool-abc',
        message: {
          content: [
            { type: 'tool_use', id: 'child-tool-1', name: 'Read', input: { file_path: 'subagent.md' } },
          ],
        },
      });

      const results = transform(message);

      expect(results).toEqual([
        {
          type: 'subagent_tool_use',
          subagentId: 'parent-tool-abc',
          id: 'child-tool-1',
          name: 'Read',
          input: { file_path: 'subagent.md' },
        },
      ]);
    });

    it('handles empty content array', () => {
      const message = msg({
        type: 'assistant',
        message: { content: [] },
      });

      const results = transform(message);

      expect(results).toEqual([]);
    });

    it('handles missing message.content', () => {
      const message = msg({
        type: 'assistant',
        message: {},
      });

      const results = transform(message);

      expect(results).toEqual([]);
    });

    it('skips empty text blocks', () => {
      const message = msg({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '' },
            { type: 'text', text: 'Valid text' },
          ],
        },
      });

      const results = transform(message);

      expect(results).toEqual([
        { type: 'text', content: 'Valid text' },
      ]);
    });

    it('skips "(no content)" placeholder text blocks', () => {
      const message = msg({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '(no content)' },
            { type: 'tool_use', id: 'tool-1', name: 'Skill', input: { skill: 'md2docx' } },
          ],
        },
      });

      const results = transform(message);

      expect(results).toEqual([
        { type: 'tool_use', id: 'tool-1', name: 'Skill', input: { skill: 'md2docx' } },
      ]);
    });

    it('skips empty thinking blocks', () => {
      const message = msg({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'thinking', thinking: 'Valid thinking' },
          ],
        },
      });

      const results = transform(message);

      expect(results).toEqual([
        { type: 'thinking', content: 'Valid thinking' },
      ]);
    });

    it('yields error event for assistant message with error field', () => {
      const message = msg({
        type: 'assistant',
        error: 'rate_limit',
        message: {
          content: [
            { type: 'text', text: 'Partial response' },
          ],
        },
      });

      const results = transform(message);

      expect(results).toEqual([
        { type: 'error', content: 'Claude rate limit reached. Try again later.' },
        { type: 'text', content: 'Partial response' },
      ]);
    });
  });

  describe('user messages', () => {
    it('yields tool_result for tool_use_result with parent_tool_use_id', () => {
      const message = msg({
        type: 'user',
        parent_tool_use_id: 'tool-123',
        tool_use_result: 'File contents here',
      });

      const results = transform(message);

      expect(results).toEqual([
        {
          type: 'subagent_tool_result',
          subagentId: 'tool-123',
          id: 'tool-123',
          content: 'File contents here',
          isError: false,
          toolUseResult: 'File contents here',
        },
      ]);
    });

    it('stringifies non-string tool_use_result', () => {
      const message = msg({
        type: 'user',
        parent_tool_use_id: 'tool-123',
        tool_use_result: { status: 'success', data: [1, 2, 3] },
      });

      const results = transform(message);

      expect(results.length).toBe(1);
      expect(results[0].type).toBe('subagent_tool_result');
      expect((results[0] as any).content).toContain('"status": "success"');
    });

    it('extracts text from array-based tool_use_result content', () => {
      const toolUseResult = [
        { type: 'text', text: 'Agent completed successfully.' },
        { type: 'text', text: 'Saved summary to notes.md' },
      ];
      const message = msg({
        type: 'user',
        parent_tool_use_id: 'tool-123',
        tool_use_result: toolUseResult,
      });

      const results = transform(message);

      expect(results).toEqual([
        {
          type: 'subagent_tool_result',
          subagentId: 'tool-123',
          id: 'tool-123',
          content: 'Agent completed successfully.\nSaved summary to notes.md',
          isError: false,
          toolUseResult,
        },
      ]);
    });

    it('yields tool_result from message.content blocks', () => {
      const message = msg({
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
      });

      const results = transform(message);

      expect(results).toEqual([
        {
          type: 'tool_result',
          id: 'tool-456',
          content: 'Result content',
          isError: false,
        },
      ]);
    });

    it('omits base64 image payloads from tool_result content', () => {
      const data = 'a'.repeat(4096);
      const message = msg({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-image',
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
              is_error: false,
            },
          ],
        },
      });

      const [result] = transform(message);

      expect(result.type).toBe('tool_result');
      expect(result).toMatchObject({ id: 'tool-image', isError: false });
      const content = 'content' in result ? result.content : undefined;
      expect(content).not.toContain(data);
      expect(JSON.parse(content as string)).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
      ]);
    });

    it('handles tool_result with is_error flag', () => {
      const message = msg({
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
      });

      const results = transform(message);

      expect(results).toEqual([
        {
          type: 'tool_result',
          id: 'tool-error',
          content: 'Error: File not found',
          isError: true,
        },
      ]);
    });

    it('extracts text from array content in tool_result blocks', () => {
      const message = msg({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-agent',
              content: [
                { type: 'text', text: 'Agent completed successfully.' },
                { type: 'text', text: 'Next step queued.' },
              ],
            },
          ],
        },
      });

      const results = transform(message);

      expect(results).toEqual([
        {
          type: 'tool_result',
          id: 'tool-agent',
          content: 'Agent completed successfully.\nNext step queued.',
          isError: false,
        },
      ]);
    });

    it('stringifies non-string object content in tool_result blocks', () => {
      const message = msg({
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
      });

      const results = transform(message);

      expect(results.length).toBe(1);
      expect((results[0] as any).content).toContain('"key": "value"');
    });

    it('preserves tool_reference array content in tool_result blocks', () => {
      const toolRefs = [
        { type: 'tool_reference', tool_name: 'WebSearch' },
        { type: 'tool_reference', tool_name: 'Grep' },
      ];
      const message = msg({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-search-1',
              content: toolRefs,
            },
          ],
        },
      });

      const results = transform(message);

      expect(results.length).toBe(1);
      expect((results[0] as any).content).toBe(JSON.stringify(toolRefs, null, 2));
    });

    it('emits one result for a subagent frame carrying both structured output and its tool_result block', () => {
      const message = msg({
        type: 'user',
        parent_tool_use_id: 'task-1',
        tool_use_result: { stdout: 'child output', stderr: '', interrupted: false },
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'child-1', content: 'child output' },
          ],
        },
      });

      const results = transform(message);

      expect(results).toEqual([
        {
          type: 'subagent_tool_result',
          subagentId: 'task-1',
          id: 'child-1',
          content: 'child output',
          isError: false,
          toolUseResult: { stdout: 'child output', stderr: '', interrupted: false },
        },
      ]);
    });

    it('yields nothing for user messages without tool results', () => {
      const message = msg({
        type: 'user',
      });

      const results = transform(message);

      expect(results).toEqual([]);
    });
  });

  describe('stream_event messages', () => {
    it('yields tool_use for content_block_start with tool_use', () => {
      const message = msg({
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
      });

      const results = transform(message);

      expect(results).toEqual([
        {
          type: 'tool_use',
          id: 'stream-tool-1',
          name: 'Write',
          input: { file_path: '/test.ts' },
        },
      ]);
    });

    it('yields cumulative tool_use updates for input_json_delta', () => {
      const streamState = createTransformStreamState();
      const startMessage = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'stream-tool-1',
            name: 'Write',
            input: {},
          },
        },
      });
      const firstDeltaMessage = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"file_path":"notes.md"',
          },
        },
      });
      const secondDeltaMessage = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: ',"content":"Hello"',
          },
        },
      });

      expect(transform(startMessage, { streamState })).toEqual([
        {
          type: 'tool_use',
          id: 'stream-tool-1',
          name: 'Write',
          input: {},
        },
      ]);
      expect(transform(firstDeltaMessage, { streamState })).toEqual([
        {
          type: 'tool_use',
          id: 'stream-tool-1',
          name: 'Write',
          input: { file_path: 'notes.md' },
        },
      ]);
      expect(transform(secondDeltaMessage, { streamState })).toEqual([
        {
          type: 'tool_use',
          id: 'stream-tool-1',
          name: 'Write',
          input: { file_path: 'notes.md', content: 'Hello' },
        },
      ]);
    });

    it('reparses streamed tool input only when a delta can change the parsed snapshot', () => {
      const streamState = createTransformStreamState();
      const usageState = createTransformUsageState();
      const input = {
        file_path: 'notes.md',
        content: 'She said "hi", then left.\\n{not: json} [x], '.repeat(40),
      };
      const serialized = JSON.stringify(input);
      const deltas: string[] = [];
      for (let offset = 0; offset < serialized.length; offset += 3) {
        deltas.push(serialized.slice(offset, offset + 3));
      }
      const streamEvent = (event: Record<string, unknown>) => msg({ type: 'stream_event', event: { index: 0, ...event } });
      transform(streamEvent({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'stream-tool-1', name: 'Write', input: {} },
      }), { streamState, usageState });

      const parseSpy = jest.spyOn(JSON, 'parse');
      const emitted: unknown[] = [];
      try {
        for (const partialJson of deltas) {
          emitted.push(...transform(streamEvent({
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: partialJson },
          }), { streamState, usageState }));
        }
        expect(parseSpy.mock.calls.length).toBeLessThan(deltas.length / 20);
      } finally {
        parseSpy.mockRestore();
      }

      expect(deltas.length).toBeGreaterThan(500);
      expect(emitted.at(-1)).toEqual({ type: 'tool_use', id: 'stream-tool-1', name: 'Write', input });
      expect(emitted).toContainEqual({
        type: 'tool_use', id: 'stream-tool-1', name: 'Write', input: { file_path: 'notes.md' },
      });
    });

    it('yields thinking for content_block_start with thinking', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'thinking',
            thinking: 'Initial thinking...',
          },
        },
      });

      const results = transform(message);

      expect(results).toEqual([
        { type: 'thinking', content: 'Initial thinking...' },
      ]);
    });

    it('yields text for content_block_start with text', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'text',
            text: 'Starting response...',
          },
        },
      });

      const results = transform(message);

      expect(results).toEqual([
        { type: 'text', content: 'Starting response...' },
      ]);
    });

    it('yields thinking for thinking_delta', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'thinking_delta',
            thinking: 'More thinking...',
          },
        },
      });

      const results = transform(message);

      expect(results).toEqual([
        { type: 'thinking', content: 'More thinking...' },
      ]);
    });

    it('yields text for text_delta', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: ' additional text',
          },
        },
      });

      const results = transform(message);

      expect(results).toEqual([
        { type: 'text', content: ' additional text' },
      ]);
    });

    it('yields nothing for empty thinking in content_block_start', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'thinking',
            thinking: '',
          },
        },
      });

      const results = transform(message);

      expect(results).toEqual([]);
    });

    it('yields nothing for empty text in content_block_start', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'text',
            text: '',
          },
        },
      });

      const results = transform(message);

      expect(results).toEqual([]);
    });

    it('yields nothing for empty thinking_delta', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'thinking_delta',
            thinking: '',
          },
        },
      });

      const results = transform(message);

      expect(results).toEqual([]);
    });

    it('yields nothing for empty text_delta', () => {
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: '',
          },
        },
      });

      const results = transform(message);

      expect(results).toEqual([]);
    });

    it('suppresses subagent text deltas in stream events', () => {
      const message = msg({
        type: 'stream_event',
        parent_tool_use_id: 'subagent-parent',
        event: {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: 'Subagent stream text',
          },
        },
      });

      const results = transform(message);

      expect(results).toEqual([]);
    });

    it('handles missing event property', () => {
      const message = msg({
        type: 'stream_event',
        event: undefined,
      });

      const results = transform(message);

      expect(results).toEqual([]);
    });

    it('yields usage when Anthropic-compatible message_delta carries prompt tokens', () => {
      const usageState = createTransformUsageState();
      const startMessage = msg({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 0,
              output_tokens: 0,
            },
          },
        },
      });
      const deltaMessage = msg({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            input_tokens: 16,
            output_tokens: 6,
            cache_read_input_tokens: 0,
          },
        },
      });

      expect(transform(startMessage, {
        intendedModel: 'glm-5.1',
        usageState,
      })).toEqual([]);

      const results = transform(deltaMessage, {
        intendedModel: 'glm-5.1',
        usageState,
      });

      expect(results).toEqual([
        {
          type: 'usage',
          usage: {
            model: 'glm-5.1',
            inputTokens: 16,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 0,
            contextTokens: 16,
            percentage: 0,
          },
        },
      ]);
    });

    it('keeps standard message_start prompt usage on the final assistant usage path', () => {
      const usageState = createTransformUsageState();
      const startMessage = msg({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
      });
      const deltaMessage = msg({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            input_tokens: 10,
            output_tokens: 4,
          },
        },
      });
      const assistantMessage = msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });

      const startResults = transform(startMessage, {
        intendedModel: 'sonnet',
        usageState,
      });
      const deltaResults = transform(deltaMessage, {
        intendedModel: 'sonnet',
        usageState,
      });
      const assistantResults = transform(assistantMessage, {
        intendedModel: 'sonnet',
        usageState,
      });

      expect(startResults).toEqual([]);
      expect(deltaResults).toEqual([]);
      expect(assistantResults).toEqual([
        { type: 'text', content: 'Hello' },
        {
          type: 'usage',
          usage: {
            model: 'sonnet',
            inputTokens: 10,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 0,
            contextTokens: 10,
            percentage: 0,
          },
        },
      ]);
    });

    it('uses a context window reported by the SDK runtime', () => {
      const usageState = createTransformUsageState();
      const assistantMessage = msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 250000,
            output_tokens: 4,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });

      expect(transform(assistantMessage, {
        intendedModel: 'custom-model',
        reportedContextWindow: 1_000_000,
        usageState,
      })).toEqual([
        { type: 'text', content: 'Hello' },
        {
          type: 'usage',
          usage: {
            model: 'custom-model',
            inputTokens: 250000,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 1_000_000,
            contextTokens: 250000,
            percentage: 25,
          },
        },
      ]);
    });

    it('emits message_start prompt usage at result when no assistant usage arrives', () => {
      const usageState = createTransformUsageState();
      const startMessage = msg({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
      });
      const deltaMessage = msg({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            output_tokens: 4,
          },
        },
      });
      const resultMessage = msg({
        type: 'result',
        subtype: 'success',
        modelUsage: undefined,
      });

      expect(transform(startMessage, {
        intendedModel: 'sonnet',
        usageState,
      })).toEqual([]);
      expect(transform(deltaMessage, {
        intendedModel: 'sonnet',
        usageState,
      })).toEqual([]);

      expect(transform(resultMessage, {
        intendedModel: 'sonnet',
        usageState,
      })).toEqual([
        {
          type: 'usage',
          usage: {
            model: 'sonnet',
            inputTokens: 10,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 0,
            contextTokens: 10,
            percentage: 0,
          },
        },
      ]);
    });

    it('ignores standard message_delta usage that only contains output tokens', () => {
      const usageState = createTransformUsageState();
      const message = msg({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: {
            output_tokens: 6,
          },
        },
      });

      const results = transform(message, { usageState });

      expect(results).toEqual([]);
    });

    it('ignores subagent stream usage deltas', () => {
      const usageState = createTransformUsageState();
      const message = msg({
        type: 'stream_event',
        parent_tool_use_id: 'subagent-parent',
        event: {
          type: 'message_delta',
          usage: {
            input_tokens: 16,
            output_tokens: 6,
          },
        },
      });

      const results = transform(message, { usageState });

      expect(results).toEqual([]);
    });

    it('ignores subagent message_start usage', () => {
      const usageState = createTransformUsageState();
      const message = msg({
        type: 'stream_event',
        parent_tool_use_id: 'subagent-parent',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 16,
              output_tokens: 0,
            },
          },
        },
      });

      const results = transform(message, { usageState });

      expect(results).toEqual([]);
      expect(transform(msg({
        type: 'result',
        subtype: 'success',
        modelUsage: undefined,
      }), { usageState })).toEqual([]);
    });
  });

  describe('result messages', () => {
    it('yields context_window for successful result messages with modelUsage', () => {
      const message = msg({
        type: 'result',
        modelUsage: {
          'claude-sonnet-4-5-20250514': {
            inputTokens: 1000,
            cacheCreationInputTokens: 500,
            cacheReadInputTokens: 200,
            outputTokens: 300,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 200000,
            maxOutputTokens: 8192,
          },
        },
      });

      const results = transform(message);

      expect(results).toEqual([
        { type: 'context_window', contextWindow: 200000 },
      ]);
    });

    it('yields error and context_window for failed result messages', () => {
      const message = msg({
        type: 'result',
        subtype: 'error_max_turns',
        errors: ['Hit maximum turn limit'],
      });

      const results = transform(message);

      expect(results).toEqual([
        { type: 'context_window', contextWindow: 200000 },
        { type: 'error', content: 'Hit maximum turn limit' },
      ]);
    });

    it('yields context_window with 1M for [1m] models', () => {
      const message = msg({
        type: 'result',
        modelUsage: {
          'claude-opus-4-6[1m]': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 32000,
          },
        },
      });

      const results = transform(message);

      expect(results).toEqual([
        { type: 'context_window', contextWindow: 1000000 },
      ]);
    });

    it('prefers the exact intended model when modelUsage includes multiple entries', () => {
      const message = msg({
        type: 'result',
        modelUsage: {
          'custom-subagent-model': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 32000,
          },
          'custom-main-model': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 200000,
            maxOutputTokens: 32000,
          },
        },
      });

      const results = transform(message, { intendedModel: 'custom-main-model' });

      expect(results).toEqual([
        { type: 'context_window', contextWindow: 200000 },
      ]);
    });

    it('matches built-in aliases against SDK modelUsage keys when unambiguous', () => {
      const message = msg({
        type: 'result',
        modelUsage: {
          'claude-sonnet-4-5-20250514': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 200000,
            maxOutputTokens: 32000,
          },
          'claude-opus-4-6[1m]': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 32000,
          },
        },
      });

      const results = transform(message, { intendedModel: 'opus[1m]' });

      expect(results).toEqual([
        { type: 'context_window', contextWindow: 1000000 },
      ]);
    });

    it('matches fable family against SDK modelUsage keys via a version-profile suffix', () => {
      const message = msg({
        type: 'result',
        modelUsage: {
          'claude-haiku-4-5-20251001': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 200000,
            maxOutputTokens: 32000,
          },
          'claude-fable-5-v1:0': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 32000,
          },
        },
      });

      const results = transform(message, { intendedModel: 'fable' });

      expect(results).toEqual([
        { type: 'context_window', contextWindow: 1000000 },
      ]);
    });

    it('matches provider-qualified custom model ids against SDK modelUsage keys', () => {
      const message = msg({
        type: 'result',
        modelUsage: {
          'claude-haiku-4-5-20251001': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 200000,
            maxOutputTokens: 32000,
          },
          'claude-opus-4-6[1m]': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 32000,
          },
        },
      });

      const results = transform(message, { intendedModel: 'anthropic/claude-opus-4-6[1m]' });

      expect(results).toEqual([
        { type: 'context_window', contextWindow: 1000000 },
      ]);
    });

    it('preserves literal exact matches when provider-qualified entries normalize to the same Claude id', () => {
      const message = msg({
        type: 'result',
        modelUsage: {
          'eu.anthropic.claude-opus-4-6[1m]': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 32000,
          },
          'us.anthropic.claude-opus-4-6[1m]': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 500000,
            maxOutputTokens: 32000,
          },
        },
      });

      const results = transform(message, { intendedModel: 'eu.anthropic.claude-opus-4-6[1m]' });

      expect(results).toEqual([
        { type: 'context_window', contextWindow: 1000000 },
      ]);
    });

    it('matches provider-qualified custom model ids with uppercase 1M suffixes', () => {
      const message = msg({
        type: 'result',
        modelUsage: {
          'claude-haiku-4-5-20251001': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 200000,
            maxOutputTokens: 32000,
          },
          'claude-opus-4-6[1m]': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 32000,
          },
        },
      });

      const results = transform(message, { intendedModel: 'anthropic/claude-opus-4-6[1M]' });

      expect(results).toEqual([
        { type: 'context_window', contextWindow: 1000000 },
      ]);
    });

    it('does not heuristically match different custom model ids', () => {
      const message = msg({
        type: 'result',
        modelUsage: {
          'claude-haiku-4-5-20251001': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 200000,
            maxOutputTokens: 32000,
          },
          'claude-opus-4-6[1m]': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 32000,
          },
        },
      });

      const results = transform(message, { intendedModel: 'anthropic/claude-opus-4-6' });

      expect(results).toEqual([]);
    });

    it('matches an explicit model id against the SDK canonical model of provider-specific keys', () => {
      const usage = (contextWindow: number, canonicalModel: string) => ({
        inputTokens: 1000,
        outputTokens: 300,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.01,
        contextWindow,
        maxOutputTokens: 32000,
        canonicalModel,
      });
      const message = msg({
        type: 'result',
        modelUsage: {
          'arn:aws:bedrock:us-east-1:123:application-inference-profile/haiku': usage(200000, 'claude-haiku-4-5'),
          'arn:aws:bedrock:us-east-1:123:application-inference-profile/opus': usage(1000000, 'claude-opus-4-7'),
        },
      });

      expect(transform(message, { intendedModel: 'claude-opus-4-7' })).toEqual([
        { type: 'context_window', contextWindow: 1000000 },
      ]);
    });

    it('does not override the heuristic when multi-model result usage is ambiguous', () => {
      const message = msg({
        type: 'result',
        modelUsage: {
          'claude-sonnet-4-5-20250514': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 200000,
            maxOutputTokens: 32000,
          },
          'claude-sonnet-4-6-20260101': {
            inputTokens: 1000,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 500000,
            maxOutputTokens: 32000,
          },
        },
      });

      const results = transform(message, { intendedModel: 'sonnet' });

      expect(results).toEqual([]);
    });
  });

  describe('assistant message usage extraction', () => {
    it('yields usage info from main agent assistant message', () => {
      const message = msg({
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
        },
      });

      const results = transform(message, { intendedModel: 'sonnet' });

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(1);

      const usage = (usageResults[0] as any).usage;
      expect(usage.inputTokens).toBe(1000);
      expect(usage.cacheCreationInputTokens).toBe(300);
      expect(usage.cacheReadInputTokens).toBe(200);
      expect(usage.contextTokens).toBe(1500); // 1000 + 300 + 200
      expect(usage.contextWindow).toBe(0);
      expect(usage.percentage).toBe(0); // No reported window
    });

    it('yields usage from assistant message when usage state has no stream prompt usage', () => {
      const usageState = createTransformUsageState();
      const message = msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 200,
          },
        },
      });

      const results = transform(message, {
        intendedModel: 'sonnet',
        usageState,
      });

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(1);
      expect((usageResults[0] as any).usage).toEqual({
        model: 'sonnet',
        inputTokens: 1000,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 200,
        contextWindow: 0,
        contextTokens: 1500,
        percentage: 0,
      });
    });

    it('skips usage extraction for subagent messages', () => {
      const message = msg({
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
        },
      });

      const results = transform(message);

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(0);
    });

    it('handles missing token fields with defaults', () => {
      const message = msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {}, // Empty usage object
        },
      });

      const results = transform(message, { intendedModel: 'sonnet' });

      const usageResults = results.filter(r => r.type === 'usage');
      expect(usageResults).toHaveLength(1);

      const usage = (usageResults[0] as any).usage;
      expect(usage.inputTokens).toBe(0);
      expect(usage.cacheCreationInputTokens).toBe(0);
      expect(usage.cacheReadInputTokens).toBe(0);
      expect(usage.contextTokens).toBe(0);
    });

    it('emits final zero usage with usage state when no stream prompt usage exists', () => {
      const usageState = createTransformUsageState();
      const message = msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 0,
            output_tokens: 6,
          },
        },
      });

      const results = transform(message, {
        intendedModel: 'sonnet',
        usageState,
      });

      expect(results).toEqual([
        { type: 'text', content: 'Hello' },
        {
          type: 'usage',
          usage: {
            model: 'sonnet',
            inputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            contextWindow: 0,
            contextTokens: 0,
            percentage: 0,
          },
        },
      ]);
    });

    it('does not let final zero assistant usage overwrite positive stream usage', () => {
      const usageState = createTransformUsageState();
      const deltaMessage = msg({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: {
            input_tokens: 16,
            output_tokens: 6,
          },
        },
      });
      const assistantMessage = msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 0,
            output_tokens: 6,
          },
        },
      });

      const streamResults = transform(deltaMessage, {
        intendedModel: 'glm-5.1',
        usageState,
      });
      const assistantResults = transform(assistantMessage, {
        intendedModel: 'glm-5.1',
        usageState,
      });

      expect(streamResults.filter(r => r.type === 'usage')).toHaveLength(1);
      expect(assistantResults).toEqual([
        { type: 'text', content: 'Hello' },
      ]);
    });
  });

  describe('error messages', () => {
    it('yields error event from assistant message with error field', () => {
      const message = msg({
        type: 'assistant',
        error: 'unknown',
        message: { content: [] },
      });

      const results = transform(message);

      expect(results).toEqual([
        { type: 'error', content: 'Claude API request failed.' },
      ]);
    });
  });

  describe('unhandled message types', () => {
    it('yields nothing for tool_progress messages', () => {
      const message = msg({
        type: 'tool_progress',
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
        elapsed_time_seconds: 5,
      });

      const results = transform(message);

      expect(results).toEqual([]);
    });

    it('yields nothing for auth_status messages', () => {
      const message = msg({
        type: 'auth_status',
        isAuthenticating: true,
        output: [],
      });

      const results = transform(message);

      expect(results).toEqual([]);
    });
  });
});
