import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  parseGrokHistoryContent,
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
