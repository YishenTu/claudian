import type { SessionMessage } from '@qoder-ai/qoder-agent-sdk';

import {
  mapQoderSessionMessages,
  sliceQoderSessionMessagesAt,
} from '@/providers/qoder/history/QoderConversationHistoryService';

function message(
  type: SessionMessage['type'],
  uuid: string,
  content: unknown[],
): SessionMessage {
  return {
    message: { content, role: type },
    parent_tool_use_id: null,
    session_id: 'session',
    timestamp: '2026-07-24T00:00:00.000Z',
    type,
    uuid,
  };
}

describe('Qoder conversation history', () => {
  const nativeMessages: SessionMessage[] = [
    message('user', 'user-1', [
      { text: 'Inspect the vault', type: 'text' },
      {
        source: {
          data: 'aGVsbG8=',
          media_type: 'image/png',
          type: 'base64',
        },
        type: 'image',
      },
    ]),
    message('assistant', 'assistant-thinking', [{
      thinking: 'I should list files.',
      type: 'thinking',
    }]),
    message('assistant', 'assistant-tool', [{
      id: 'tool-1',
      input: { path: '.' },
      name: 'Read',
      type: 'tool_use',
    }]),
    message('user', 'tool-result', [{
      content: 'done',
      tool_use_id: 'tool-1',
      type: 'tool_result',
    }]),
    message('assistant', 'assistant-final', [{ text: 'Finished.', type: 'text' }]),
  ];

  it('rebuilds turns and attaches synthetic tool results to their assistant', () => {
    expect(mapQoderSessionMessages(nativeMessages)).toEqual([
      expect.objectContaining({
        content: 'Inspect the vault',
        images: [{
          data: 'aGVsbG8=',
          id: 'qoder-img-user-1-0',
          mediaType: 'image/png',
          name: 'image-1',
          size: 5,
          source: 'paste',
        }],
        role: 'user',
        userMessageId: 'user-1',
      }),
      expect.objectContaining({
        assistantMessageId: 'assistant-final',
        content: 'Finished.',
        contentBlocks: [
          { content: 'I should list files.', type: 'thinking' },
          { toolId: 'tool-1', type: 'tool_use' },
          { content: 'Finished.', type: 'text' },
        ],
        role: 'assistant',
        toolCalls: [{
          id: 'tool-1',
          input: { path: '.' },
          name: 'Read',
          result: 'done',
          status: 'completed',
        }],
      }),
    ]);
  });

  it('slices a pending fork at its exact native checkpoint', () => {
    expect(sliceQoderSessionMessagesAt(nativeMessages, 'assistant-tool')).toEqual(
      nativeMessages.slice(0, 3),
    );
    expect(sliceQoderSessionMessagesAt(nativeMessages, 'missing')).toEqual([]);
  });
});
