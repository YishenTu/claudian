import type { ChatMessage, ImageAttachment } from '@/core/types';
import { ChatState } from '@/features/chat/state';

describe('ChatState persistence', () => {
  it('strips base64 data when persisting messages but keeps references', () => {
    const state = new ChatState();

    const images: ImageAttachment[] = [
      {
        id: 'img-1',
        name: 'cached.png',
        mediaType: 'image/png',
        size: 10,
        cachePath: '.claudian-cache/images/cached.png',
        filePath: 'images/cached.png',
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

    expect(persisted[0].images?.[0].data).toBeUndefined();
    expect(persisted[0].images?.[0].cachePath).toBe('.claudian-cache/images/cached.png');
    expect(persisted[0].images?.[0].filePath).toBe('images/cached.png');
  });
});
