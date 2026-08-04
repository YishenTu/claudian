import { parseOmpSessionContent } from '@/providers/omp/history/OmpHistoryStore';

describe('parseOmpSessionContent', () => {
  it('projects OMP user and assistant JSONL messages without mutating native data', () => {
    const content = [
      JSON.stringify({ type: 'session', id: 'session-1' }),
      JSON.stringify({
        id: 'user-1',
        message: { content: [{ type: 'text', text: 'Summarize this.' }], role: 'user', timestamp: '2026-08-04T00:00:00.000Z' },
        type: 'message',
      }),
      JSON.stringify({
        id: 'assistant-1',
        message: {
          content: [{ thinking: 'Thinking', type: 'thinking' }, { text: 'Summary', type: 'text' }],
          role: 'assistant',
          timestamp: '2026-08-04T00:00:01.000Z',
        },
        type: 'message',
      }),
    ].join('\n');

    expect(parseOmpSessionContent(content)).toEqual([
      {
        content: 'Summarize this.',
        id: 'user-1',
        role: 'user',
        timestamp: 1785801600000,
        userMessageId: 'user-1',
      },
      {
        assistantMessageId: 'assistant-1',
        content: 'Summary',
        contentBlocks: [
          { content: 'Thinking', type: 'thinking' },
          { content: 'Summary', type: 'text' },
        ],
        id: 'assistant-1',
        role: 'assistant',
        timestamp: 1785801601000,
      },
    ]);
  });
});
