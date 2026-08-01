import type { Conversation } from '@/core/types';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';
import { getOpencodeState } from '@/providers/opencode/types';

describe('OpenCode provider state', () => {
  it.each([
    { malformed: true },
    42,
    '',
    '   ',
    null,
    ['not-a-path'],
  ])('ignores a malformed database path without losing unknown state: %p', async (databasePath) => {
    const conversation = createConversation({
      databasePath,
      futureResumeCursor: { token: 'cursor-1' },
      ignoredFutureValue: undefined,
    });
    const service = new OpencodeConversationHistoryService();

    await expect(service.hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: '/missing-home', XDG_DATA_HOME: '/missing-data' } },
    )).resolves.toBeUndefined();
    expect(service.buildPersistedProviderState(conversation)).toEqual({
      futureResumeCursor: { token: 'cursor-1' },
    });
  });

  it('trims a valid database path and preserves unknown defined keys', () => {
    expect(getOpencodeState({
      databasePath: '  /tmp/opencode.db  ',
      futureResumeCursor: { token: 'cursor-1' },
      ignoredFutureValue: undefined,
    })).toEqual({
      databasePath: '/tmp/opencode.db',
      futureResumeCursor: { token: 'cursor-1' },
    });
  });

  it.each([true, false])(
    'normalizes the durable native-context marker: %p',
    (nativeConversationContextEstablished) => {
      expect(getOpencodeState({
        futureResumeCursor: { token: 'cursor-1' },
        nativeConversationContextEstablished,
      })).toEqual({
        futureResumeCursor: { token: 'cursor-1' },
        nativeConversationContextEstablished,
      });
    },
  );

  it.each([null, 'true', 1, {}])(
    'drops a malformed native-context marker: %p',
    (nativeConversationContextEstablished) => {
      expect(getOpencodeState({
        futureResumeCursor: { token: 'cursor-1' },
        nativeConversationContextEstablished,
      })).toEqual({
        futureResumeCursor: { token: 'cursor-1' },
      });
    },
  );

  it.each([undefined, null, [], 'invalid', 42])(
    'treats a non-record provider state as empty: %p',
    (providerState) => {
      expect(getOpencodeState(providerState)).toEqual({});
    },
  );
});

function createConversation(providerState: Record<string, unknown>): Conversation {
  return {
    createdAt: 1,
    id: 'conv-opencode-malformed-state',
    messages: [],
    providerId: 'opencode',
    providerState,
    sessionId: null,
    title: 'OpenCode malformed state',
    updatedAt: 1,
  };
}
