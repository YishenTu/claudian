import { mapOpencodeMessages } from '../../../../src/providers/opencode/history/OpencodeHistoryStore';

describe('mapOpencodeMessages', () => {
  it('maps stored OpenCode messages into Claudian chat messages', () => {
    const messages = mapOpencodeMessages([
      {
        info: {
          id: 'msg-user',
          role: 'user',
          time: { created: 1_000 },
        },
        parts: [
          {
            id: 'part-user',
            text: 'Summarize this\n\n<current_note>\nnotes/today.md\n</current_note>',
            type: 'text',
          },
        ],
      },
      {
        info: {
          id: 'msg-assistant',
          role: 'assistant',
          time: { created: 2_000, completed: 4_000 },
        },
        parts: [
          {
            id: 'part-thinking',
            text: 'Thinking...',
            time: { start: 2_000, end: 3_000 },
            type: 'reasoning',
          },
          {
            callID: 'tool-1',
            id: 'part-tool',
            state: {
              input: { path: 'notes/today.md' },
              output: 'read ok',
              status: 'completed',
            },
            tool: 'read',
            type: 'tool',
          },
          {
            id: 'part-text',
            text: 'Done.',
            type: 'text',
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        assistantMessageId: undefined,
        content: 'Summarize this',
        id: 'msg-user',
        role: 'user',
        timestamp: 1_000,
        userMessageId: 'msg-user',
      },
      {
        assistantMessageId: 'msg-assistant',
        content: 'Done.',
        contentBlocks: [
          { content: 'Thinking...', durationSeconds: 1, type: 'thinking' },
          { toolId: 'tool-1', type: 'tool_use' },
          { content: 'Done.', type: 'text' },
        ],
        durationSeconds: 2,
        id: 'msg-assistant',
        role: 'assistant',
        timestamp: 2_000,
        toolCalls: [{
          id: 'tool-1',
          input: { path: 'notes/today.md' },
          name: 'read',
          result: 'read ok',
          status: 'completed',
        }],
      },
    ]);
  });
});
