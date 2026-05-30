import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Conversation } from '@/core/types';
import { PiConversationHistoryService } from '@/providers/pi/history/PiConversationHistoryService';

function createConversation(sessionFile: string): Conversation {
  return {
    createdAt: 1,
    id: 'conv-1',
    messages: [],
    providerId: 'pi',
    providerState: { sessionFile, sessionId: 's1' },
    sessionId: 's1',
    title: 'Pi',
    updatedAt: 1,
  };
}

describe('PiConversationHistoryService', () => {
  it('hydrates from providerState sessionFile', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-'));
    const sessionFile = path.join(dir, 'session.jsonl');
    await fs.writeFile(sessionFile, JSON.stringify({
      id: 'u1',
      message: { content: 'Hello', role: 'user' },
      type: 'entry',
    }));
    const conversation = createConversation(sessionFile);
    const service = new PiConversationHistoryService();

    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]).toMatchObject({
      content: 'Hello',
      role: 'user',
    });
  });

  it('sanitizes persisted provider state and keeps fork disabled', () => {
    const service = new PiConversationHistoryService();
    const conversation = createConversation('/tmp/session.jsonl');
    conversation.providerState = {
      empty: '',
      leafEntryId: 'leaf-1',
      sessionFile: '/tmp/session.jsonl',
      sessionId: 's1',
    };

    expect(service.isPendingForkConversation(conversation)).toBe(false);
    expect(service.buildForkProviderState('s1', 'checkpoint')).toEqual({});
    expect(service.buildPersistedProviderState?.(conversation)).toEqual({
      leafEntryId: 'leaf-1',
      sessionFile: '/tmp/session.jsonl',
      sessionId: 's1',
    });
  });
});
