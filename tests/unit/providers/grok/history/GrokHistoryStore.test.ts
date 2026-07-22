import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  parseGrokHistoryContent,
  resolveGrokPromptIndexAfterAssistant,
} from '@/providers/grok/history/GrokHistoryStore';

describe('GrokHistoryStore', () => {
  it('hydrates complete turns while tolerating malformed, unknown, and incomplete tails', () => {
    const content = fs.readFileSync(path.join(
      process.cwd(),
      'tests/fixtures/providers/grok/history/multi-turn-updates.jsonl',
    ), 'utf8');

    const parsed = parseGrokHistoryContent(content, 'session-fixture');

    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[0]).toMatchObject({
      content: 'Inspect the sample file.',
      id: 'user-1',
      role: 'user',
      timestamp: 1_700_000_000_000,
    });
    expect(parsed.messages[1]).toMatchObject({
      content: 'Done.',
      role: 'assistant',
      toolCalls: [{
        id: 'tool-1',
        input: { path: 'notes/sample.md' },
        name: 'Read',
        result: 'sample text',
        status: 'completed',
      }],
    });
    expect(parsed.messages[1].toolCalls?.[0].result).not.toContain('output_bytes');
    expect(parsed.messages[1].toolCalls?.[0].result).not.toContain('output_file');
    expect(parsed.messages[1].contentBlocks).toEqual([
      { content: 'I will read it.', type: 'thinking' },
      { toolId: 'tool-1', type: 'tool_use' },
      { content: 'Done.', type: 'text' },
    ]);
    expect(parsed.messages[2]).toMatchObject({ content: 'Stop now.', role: 'user' });
    expect(parsed.messages[3]).toMatchObject({ content: 'Stopping.', role: 'assistant' });
    expect(parsed.messages.some(message => message.content.includes('Incomplete'))).toBe(false);
    expect(parsed.lastUsage).toEqual(expect.objectContaining({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 16,
    }));
  });

  it('rehydrates only the active branch after a native rewind marker', () => {
    const updates = [
      {
        _meta: { promptIndex: 0 },
        content: { text: 'First prompt', type: 'text' },
        messageId: 'user-first',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'First answer', type: 'text' },
        messageId: 'assistant-first',
        sessionUpdate: 'agent_message_chunk',
      },
      { sessionUpdate: 'turn_completed', usage: { totalTokens: 10 } },
      {
        _meta: { promptIndex: 1 },
        content: { text: 'Abandoned prompt', type: 'text' },
        messageId: 'user-abandoned',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'Abandoned answer', type: 'text' },
        messageId: 'assistant-abandoned',
        sessionUpdate: 'agent_message_chunk',
      },
      { sessionUpdate: 'turn_completed', usage: { totalTokens: 20 } },
      { sessionUpdate: 'rewind_marker', target_prompt_index: 1 },
      {
        _meta: { promptIndex: 1 },
        content: { text: 'Replacement prompt', type: 'text' },
        messageId: 'user-replacement',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'Replacement answer', type: 'text' },
        messageId: 'assistant-replacement',
        sessionUpdate: 'agent_message_chunk',
      },
      { sessionUpdate: 'turn_completed', usage: { totalTokens: 15 } },
    ];
    const content = updates.map((update, index) => JSON.stringify({
      method: '_x.ai/session/update',
      params: { sessionId: 'session-rewind', update },
      timestamp: 1_000 + index,
    })).join('\n');

    const parsed = parseGrokHistoryContent(content, 'session-rewind');

    expect(parsed.messages.map(message => message.content)).toEqual([
      'First prompt',
      'First answer',
      'Replacement prompt',
      'Replacement answer',
    ]);
    expect(parsed.messages.map(message => message.id)).not.toContain('assistant-abandoned');
    expect(parsed.lastUsage).toEqual({ totalTokens: 15 });
  });

  it('handles repeated rewinds to zero without resurrecting abandoned turns', () => {
    const turn = (
      promptIndex: number,
      suffix: string,
    ): Array<Record<string, unknown>> => [{
      _meta: { promptIndex },
      content: { text: `${suffix} prompt`, type: 'text' },
      messageId: `user-${suffix}`,
      sessionUpdate: 'user_message_chunk',
    }, {
      content: { text: `${suffix} answer`, type: 'text' },
      messageId: `assistant-${suffix}`,
      sessionUpdate: 'agent_message_chunk',
    }, {
      sessionUpdate: 'turn_completed',
    }];
    const updates = [
      ...turn(0, 'original'),
      ...turn(1, 'second'),
      { sessionUpdate: 'rewind_marker', target_prompt_index: 1 },
      ...turn(1, 'first-replacement'),
      { sessionUpdate: 'rewind_marker', target_prompt_index: 0 },
      ...turn(0, 'root-replacement'),
    ];
    const content = updates.map((update, index) => JSON.stringify({
      method: '_x.ai/session/update',
      params: { sessionId: 'session-repeated-rewind', update },
      timestamp: 2_000 + index,
    })).join('\n');

    expect(parseGrokHistoryContent(content, 'session-repeated-rewind').messages.map(
      message => message.content,
    )).toEqual([
      'root-replacement prompt',
      'root-replacement answer',
    ]);
  });

  it('discards interjections owned by a rewound prompt while preserving earlier ones', () => {
    const updates = [
      {
        _meta: { promptIndex: 0 },
        content: { text: 'Kept prompt', type: 'text' },
        messageId: 'user-kept',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'Kept answer', type: 'text' },
        messageId: 'assistant-kept',
        sessionUpdate: 'agent_message_chunk',
      },
      { sessionUpdate: 'turn_completed' },
      {
        _meta: { promptIndex: 1 },
        content: { text: 'Discarded prompt', type: 'text' },
        messageId: 'user-discarded',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'Partial answer', type: 'text' },
        messageId: 'assistant-partial',
        sessionUpdate: 'agent_message_chunk',
      },
      {
        _meta: { modelId: 'grok-4.5' },
        content: { text: 'Discarded steer', type: 'text' },
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'Discarded steered answer', type: 'text' },
        messageId: 'assistant-steered',
        sessionUpdate: 'agent_message_chunk',
      },
      { sessionUpdate: 'turn_completed' },
      { sessionUpdate: 'rewind_marker', target_prompt_index: 1 },
    ];
    const content = updates.map((update, index) => JSON.stringify({
      method: '_x.ai/session/update',
      params: { sessionId: 'session-rewind-interjection', update },
      timestamp: 3_000 + index,
    })).join('\n');

    expect(parseGrokHistoryContent(content, 'session-rewind-interjection').messages.map(
      message => message.content,
    )).toEqual(['Kept prompt', 'Kept answer']);
  });

  it('uses deterministic ids when native message and prompt ids are absent', () => {
    const content = [
      JSON.stringify({
        method: 'session/update',
        params: {
          sessionId: 'session-no-ids',
          update: {
            content: { text: 'Hello', type: 'text' },
            sessionUpdate: 'user_message_chunk',
          },
        },
        timestamp: 100,
      }),
      JSON.stringify({
        method: 'session/update',
        params: {
          sessionId: 'session-no-ids',
          update: {
            content: { text: 'Hi', type: 'text' },
            sessionUpdate: 'agent_message_chunk',
          },
        },
        timestamp: 101,
      }),
      JSON.stringify({
        method: '_x.ai/session/update',
        params: {
          sessionId: 'session-no-ids',
          update: { sessionUpdate: 'turn_completed' },
        },
        timestamp: 102,
      }),
    ].join('\n');

    expect(parseGrokHistoryContent(content, 'session-no-ids').messages.map(message => message.id))
      .toEqual([
        'grok-session-no-ids-turn-0-user',
        'grok-session-no-ids-turn-0-assistant',
      ]);
  });

  it('rehydrates image attachments, including image-only user turns', () => {
    const records = [
      {
        content: { text: 'Compare these', type: 'text' },
        messageId: 'user-images-1',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' },
        messageId: 'user-images-1',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'First answer', type: 'text' },
        messageId: 'assistant-images-1',
        sessionUpdate: 'agent_message_chunk',
      },
      { sessionUpdate: 'turn_completed' },
      {
        content: { data: 'd29ybGQ=', mimeType: 'image/webp', type: 'image' },
        messageId: 'user-images-2',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'Second answer', type: 'text' },
        messageId: 'assistant-images-2',
        sessionUpdate: 'agent_message_chunk',
      },
      { sessionUpdate: 'turn_completed' },
    ].map((update, index) => JSON.stringify({
      method: '_x.ai/session/update',
      params: { sessionId: 'session-images', update },
      timestamp: 600 + index,
    })).join('\n');

    const messages = parseGrokHistoryContent(records, 'session-images').messages;

    expect(messages[0]).toMatchObject({
      content: 'Compare these',
      images: [{
        data: 'aGVsbG8=',
        id: 'grok-session-images-turn-0-image-0',
        mediaType: 'image/png',
        name: 'Grok image 1.png',
        size: 5,
        source: 'file',
      }],
      role: 'user',
    });
    expect(messages[2]).toMatchObject({
      content: '',
      images: [{
        data: 'd29ybGQ=',
        id: 'grok-session-images-turn-1-image-0',
        mediaType: 'image/webp',
        name: 'Grok image 1.webp',
        size: 5,
        source: 'file',
      }],
      role: 'user',
    });
    expect(messages[3]).toMatchObject({ content: 'Second answer', role: 'assistant' });
  });

  it('maps an assistant checkpoint to the following zero-based Grok prompt index', () => {
    const content = fs.readFileSync(path.join(
      process.cwd(),
      'tests/fixtures/providers/grok/history/multi-turn-updates.jsonl',
    ), 'utf8');

    expect(resolveGrokPromptIndexAfterAssistant(
      content,
      'session-fixture',
      'assistant-1',
    )).toBe(1);
    expect(resolveGrokPromptIndexAfterAssistant(
      content,
      'session-fixture',
      'assistant-2',
    )).toBe(2);
    expect(resolveGrokPromptIndexAfterAssistant(
      content,
      'session-fixture',
      'missing-assistant',
    )).toBeNull();
  });

  it('maps persisted notification metadata IDs when chunks omit message IDs', () => {
    const records = [{
      _meta: { promptIndex: 0 },
      content: { text: 'Prompt', type: 'text' },
      sessionUpdate: 'user_message_chunk',
    }, {
      content: { text: 'Answer', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    }, {
      prompt_id: 'prompt-id',
      sessionUpdate: 'turn_completed',
    }].map((update, index) => JSON.stringify({
      method: '_x.ai/session/update',
      params: {
        _meta: {
          eventId: index === 0 ? 'user-event-id' : 'assistant-event-id',
          promptId: 'prompt-id',
        },
        sessionId: 'session-outer-meta',
        update,
      },
      timestamp: index,
    })).join('\n');

    const parsed = parseGrokHistoryContent(records, 'session-outer-meta');

    expect(parsed.messages[0]).toMatchObject({
      id: 'user-event-id',
      userMessageId: 'user-event-id',
    });
    expect(parsed.messages[1]).toMatchObject({
      assistantMessageId: 'assistant-event-id',
      id: 'assistant-event-id',
    });
    expect(resolveGrokPromptIndexAfterAssistant(
      records,
      'session-outer-meta',
      'assistant-event-id',
    )).toBe(1);
  });

  it('does not expose a fork action or increment the prompt index for stored interjections', () => {
    const records = [
      {
        _meta: { promptIndex: 0 },
        content: { text: 'Initial prompt', type: 'text' },
        messageId: 'user-initial',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'Initial response', type: 'text' },
        messageId: 'assistant-before-steer',
        sessionUpdate: 'agent_message_chunk',
      },
      {
        _meta: { modelId: 'grok-4.5' },
        content: { text: 'Steer now', type: 'text' },
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'Steered response', type: 'text' },
        messageId: 'assistant-after-steer',
        sessionUpdate: 'agent_message_chunk',
      },
      { sessionUpdate: 'turn_completed' },
      {
        _meta: { promptIndex: 1 },
        content: { text: 'Next prompt', type: 'text' },
        messageId: 'user-next',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'Next response', type: 'text' },
        messageId: 'assistant-next',
        sessionUpdate: 'agent_message_chunk',
      },
      { sessionUpdate: 'turn_completed' },
    ].map((update, index) => JSON.stringify({
      method: '_x.ai/session/update',
      params: { sessionId: 'session-interject', update },
      timestamp: 800 + index,
    })).join('\n');

    const parsed = parseGrokHistoryContent(records, 'session-interject');
    expect(parsed.messages.map(message => message.content)).toEqual([
      'Initial prompt',
      'Initial response',
      'Steer now',
      'Steered response',
      'Next prompt',
      'Next response',
    ]);
    expect(parsed.messages[2]).not.toHaveProperty('userMessageId');
    expect(resolveGrokPromptIndexAfterAssistant(
      records,
      'session-interject',
      'assistant-after-steer',
    )).toBe(1);
    expect(resolveGrokPromptIndexAfterAssistant(
      records,
      'session-interject',
      'assistant-next',
    )).toBe(2);
  });

  it('keeps early and consecutive interjections separate from the original prompt', () => {
    const records = [
      {
        _meta: { promptIndex: 0 },
        content: { text: 'Initial prompt', type: 'text' },
        sessionUpdate: 'user_message_chunk',
      },
      {
        _meta: { promptIndex: 0 },
        content: { data: 'aW5pdGlhbA==', mimeType: 'image/png', type: 'image' },
        sessionUpdate: 'user_message_chunk',
      },
      {
        _meta: { modelId: 'grok-4.5' },
        content: { text: 'First steer', type: 'text' },
        sessionUpdate: 'user_message_chunk',
      },
      {
        _meta: { modelId: 'grok-4.5' },
        content: { data: 'c3RlZXI=', mimeType: 'image/webp', type: 'image' },
        sessionUpdate: 'user_message_chunk',
      },
      {
        _meta: { modelId: 'grok-4.5' },
        content: { text: 'Second steer', type: 'text' },
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'Final response', type: 'text' },
        messageId: 'assistant-final',
        sessionUpdate: 'agent_message_chunk',
      },
      { sessionUpdate: 'turn_completed' },
    ].map((update, index) => JSON.stringify({
      method: '_x.ai/session/update',
      params: { sessionId: 'session-early-interject', update },
      timestamp: 900 + index,
    })).join('\n');

    const parsed = parseGrokHistoryContent(records, 'session-early-interject');

    expect(parsed.messages.map(message => message.content)).toEqual([
      'Initial prompt',
      'First steer',
      'Second steer',
      'Final response',
    ]);
    expect(parsed.messages[0]).toMatchObject({
      images: [{ mediaType: 'image/png' }],
      role: 'user',
      userMessageId: expect.any(String),
    });
    expect(parsed.messages[1]).toMatchObject({
      images: [{ mediaType: 'image/webp' }],
      role: 'user',
    });
    expect(parsed.messages[1]).not.toHaveProperty('userMessageId');
    expect(parsed.messages[2]).not.toHaveProperty('userMessageId');
    expect(resolveGrokPromptIndexAfterAssistant(
      records,
      'session-early-interject',
      'assistant-final',
    )).toBe(1);
  });

  it('preserves absolute Grok prompt indexes after compacted history prefixes', () => {
    const records = [
      {
        _meta: { promptIndex: 12 },
        content: { text: 'Post-compaction prompt', type: 'text' },
        messageId: 'user-compacted',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'Post-compaction response', type: 'text' },
        messageId: 'assistant-compacted',
        sessionUpdate: 'agent_message_chunk',
      },
      { sessionUpdate: 'turn_completed' },
    ].map((update, index) => JSON.stringify({
      method: '_x.ai/session/update',
      params: { sessionId: 'session-compacted', update },
      timestamp: 900 + index,
    })).join('\n');

    expect(resolveGrokPromptIndexAfterAssistant(
      records,
      'session-compacted',
      'assistant-compacted',
    )).toBe(13);
  });

  it('uses a new user message as a fallback turn boundary and renders tool content', () => {
    const records = [
      ['session/update', {
        content: { text: 'Incomplete first', type: 'text' },
        messageId: 'user-old',
        sessionUpdate: 'user_message_chunk',
      }],
      ['session/update', {
        content: { text: 'Replacement', type: 'text' },
        messageId: 'user-new',
        sessionUpdate: 'user_message_chunk',
      }],
      ['session/update', {
        content: [{ content: { text: 'tool text', type: 'text' }, type: 'content' }],
        rawOutput: { output_bytes: [116, 111, 111, 108, 32, 116, 101, 120, 116] },
        status: 'completed',
        title: 'future_tool',
        toolCallId: 'tool-content',
        sessionUpdate: 'tool_call',
      }],
      ['session/update', {
        status: 'completed',
        toolCallId: 'tool-content',
        sessionUpdate: 'tool_call_update',
      }],
      ['_x.ai/session/update', { sessionUpdate: 'turn_completed' }],
    ].map(([method, update], index) => JSON.stringify({
      method,
      params: { sessionId: 'session-boundary', update },
      timestamp: 200 + index,
    })).join('\n');

    const messages = parseGrokHistoryContent(records, 'session-boundary').messages;
    expect(messages[0]).toMatchObject({ content: 'Replacement', id: 'user-new' });
    expect(messages[1].toolCalls?.[0]).toMatchObject({
      name: 'future_tool',
      result: 'tool text',
      status: 'completed',
    });
  });

  it('round-trips unknown raw tool payloads while persisting concise presentation', () => {
    const rawInput = ['opaque', { nested: true }];
    const rawOutput = { future: { bytes: [1, 2, 3] } };
    const records = [
      {
        content: { text: 'Use the future tool', type: 'text' },
        sessionUpdate: 'user_message_chunk',
      },
      {
        rawInput,
        status: 'in_progress',
        title: 'future_tool',
        toolCallId: 'tool-future',
        sessionUpdate: 'tool_call',
      },
      {
        content: [{ content: { text: 'Concise result', type: 'text' }, type: 'content' }],
        rawInput,
        rawOutput,
        status: 'in_progress',
        toolCallId: 'tool-future',
        sessionUpdate: 'tool_call_update',
      },
      {
        status: 'completed',
        toolCallId: 'tool-future',
        sessionUpdate: 'tool_call_update',
      },
      { sessionUpdate: 'turn_completed' },
    ].map((update, index) => JSON.stringify({
      method: '_x.ai/session/update',
      params: { sessionId: 'session-lossless', update },
      timestamp: 400 + index,
    })).join('\n');

    const parsed = parseGrokHistoryContent(records, 'session-lossless');
    const persisted = JSON.parse(JSON.stringify(parsed.messages));
    const toolCall = persisted[1].toolCalls[0];

    expect(toolCall).toMatchObject({
      input: { value: rawInput },
      name: 'future_tool',
      providerPayload: {
        rawInput,
        rawName: 'future_tool',
        rawOutput,
      },
      result: 'Concise result',
      status: 'completed',
    });
    expect(toolCall.result).not.toContain('bytes');
  });

  it('hydrates renderer input aliases without changing persisted Grok payloads', () => {
    const rawInput = { target_directory: 'src/providers' };
    const records = [
      {
        content: { text: 'List providers', type: 'text' },
        sessionUpdate: 'user_message_chunk',
      },
      {
        rawInput,
        status: 'in_progress',
        title: 'list_dir',
        toolCallId: 'tool-list',
        sessionUpdate: 'tool_call',
      },
      {
        content: [{ content: { text: 'provider entries', type: 'text' }, type: 'content' }],
        status: 'completed',
        toolCallId: 'tool-list',
        sessionUpdate: 'tool_call_update',
      },
      { sessionUpdate: 'turn_completed' },
    ].map((update, index) => JSON.stringify({
      method: '_x.ai/session/update',
      params: { sessionId: 'session-list', update },
      timestamp: 450 + index,
    })).join('\n');

    const toolCall = parseGrokHistoryContent(records, 'session-list').messages[1]?.toolCalls?.[0];

    expect(toolCall).toMatchObject({
      input: { path: 'src/providers', target_directory: 'src/providers' },
      name: 'LS',
      providerPayload: { rawInput, rawName: 'list_dir' },
      result: 'provider entries',
      status: 'completed',
    });
  });

  it('replays a late unknown title over a generic kind without losing raw payloads', () => {
    const rawInput = { opaque: ['future'] };
    const rawOutput = { future: { bytes: [1, 2, 3] } };
    const records = [
      {
        content: { text: 'Use the future tool', type: 'text' },
        sessionUpdate: 'user_message_chunk',
      },
      {
        kind: 'execute',
        rawInput,
        status: 'in_progress',
        toolCallId: 'tool-late-title',
        sessionUpdate: 'tool_call',
      },
      {
        rawOutput,
        status: 'in_progress',
        title: 'future_tool',
        toolCallId: 'tool-late-title',
        sessionUpdate: 'tool_call_update',
      },
      {
        content: [{ content: { text: 'Concise result', type: 'text' }, type: 'content' }],
        status: 'completed',
        toolCallId: 'tool-late-title',
        sessionUpdate: 'tool_call_update',
      },
      { sessionUpdate: 'turn_completed' },
    ].map((update, index) => JSON.stringify({
      method: '_x.ai/session/update',
      params: { sessionId: 'session-late-title', update },
      timestamp: 500 + index,
    })).join('\n');

    const parsed = parseGrokHistoryContent(records, 'session-late-title');
    expect(JSON.parse(JSON.stringify(parsed.messages))[1].toolCalls[0]).toMatchObject({
      input: rawInput,
      name: 'future_tool',
      providerPayload: {
        rawInput,
        rawName: 'future_tool',
        rawOutput,
      },
      result: 'Concise result',
      status: 'completed',
    });
  });

  it('finalizes a stable prior turn when the next user message supplies the missing boundary', () => {
    const records = [
      {
        content: { text: 'First question', type: 'text' },
        messageId: 'user-first',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'First answer', type: 'text' },
        messageId: 'assistant-first',
        sessionUpdate: 'agent_message_chunk',
      },
      {
        content: { text: 'Second question', type: 'text' },
        messageId: 'user-second',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'Second answer', type: 'text' },
        messageId: 'assistant-second',
        sessionUpdate: 'agent_message_chunk',
      },
      { sessionUpdate: 'turn_completed' },
    ].map((update, index) => JSON.stringify({
      method: 'session/update',
      params: { sessionId: 'session-fallback', update },
      timestamp: 300 + index,
    })).join('\n');

    expect(parseGrokHistoryContent(records, 'session-fallback').messages).toEqual([
      expect.objectContaining({ content: 'First question', id: 'user-first', role: 'user' }),
      expect.objectContaining({ content: 'First answer', id: 'assistant-first', role: 'assistant' }),
      expect.objectContaining({ content: 'Second question', id: 'user-second', role: 'user' }),
      expect.objectContaining({ content: 'Second answer', id: 'assistant-second', role: 'assistant' }),
    ]);
  });
});
