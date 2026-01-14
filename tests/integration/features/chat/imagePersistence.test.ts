import type { ChatMessage, ImageAttachment } from '@/core/types';
import { ChatState } from '@/features/chat/state';

describe('ChatState persistence', () => {
  it('preserves image data when persisting messages', () => {
    const state = new ChatState();

    const images: ImageAttachment[] = [
      {
        id: 'img-1',
        name: 'test.png',
        mediaType: 'image/png',
        size: 10,
        data: 'YmFzZTY0',
        source: 'paste',
      },
    ];

    const messages: ChatMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now(),
        images,
      },
    ];

    state.messages = messages;

    const persisted = state.getPersistedMessages();

    // Image data is preserved (single source of truth)
    expect(persisted[0].images?.[0].data).toBe('YmFzZTY0');
    expect(persisted[0].images?.[0].name).toBe('test.png');
    expect(persisted[0].images?.[0].mediaType).toBe('image/png');
  });
});
