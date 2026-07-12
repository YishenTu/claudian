import type { Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import * as historyStore from '@/providers/claude/history/ClaudeHistoryStore';
import type { SDKSessionLocation } from '@/providers/claude/history/sdkSessionPaths';

function createConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conversation-1',
    providerId: 'claude',
    title: 'Conversation',
    createdAt: 1,
    updatedAt: 1,
    sessionId: 'session-1',
    messages: [],
    ...overrides,
  };
}

describe('ClaudeConversationHistoryService', () => {
  describe('getConversationSessionAvailability', () => {
    it('reports a missing native session', async () => {
      const availabilitySpy = jest.spyOn(historyStore, 'locateSDKSession')
        .mockResolvedValue({ availability: 'missing' });
      const service = new ClaudeConversationHistoryService();

      await expect(service.getConversationSessionAvailability(
        createConversation(),
        '/vault',
      )).resolves.toBe('missing');
      expect(availabilitySpy).toHaveBeenCalledWith('/vault', 'session-1');

      availabilitySpy.mockRestore();
    });

    it('reports an available native session', async () => {
      const availabilitySpy = jest.spyOn(historyStore, 'locateSDKSession')
        .mockResolvedValue({ availability: 'available', sessionPath: '/vault/session-1.jsonl' });
      const service = new ClaudeConversationHistoryService();

      await expect(service.getConversationSessionAvailability(
        createConversation(),
        '/vault',
      )).resolves.toBe('available');

      availabilitySpy.mockRestore();
    });

    it('reports a native session from a previous vault path as relocated', async () => {
      const availabilitySpy = jest.spyOn(historyStore, 'locateSDKSession')
        .mockResolvedValue({
          availability: 'relocated',
          sessionPath: '/old-vault/session-1.jsonl',
        });
      const service = new ClaudeConversationHistoryService();

      await expect(service.getConversationSessionAvailability(
        createConversation(),
        '/vault',
      )).resolves.toBe('relocated');

      availabilitySpy.mockRestore();
    });

    it('preserves conversations without a resumable session', async () => {
      const availabilitySpy = jest.spyOn(historyStore, 'locateSDKSession');
      const service = new ClaudeConversationHistoryService();

      await expect(service.getConversationSessionAvailability(
        createConversation({ sessionId: null }),
        '/vault',
      )).resolves.toBe('unknown');
      expect(availabilitySpy).not.toHaveBeenCalled();

      availabilitySpy.mockRestore();
    });

    it('checks the source session for a pending fork', async () => {
      const availabilitySpy = jest.spyOn(historyStore, 'locateSDKSession')
        .mockResolvedValue({ availability: 'missing' });
      const service = new ClaudeConversationHistoryService();

      await expect(service.getConversationSessionAvailability(
        createConversation({
          sessionId: null,
          providerState: {
            forkSource: { sessionId: 'source-session', resumeAt: 'assistant-1' },
          },
        }),
        '/vault',
      )).resolves.toBe('missing');
      expect(availabilitySpy).toHaveBeenCalledWith('/vault', 'source-session');

      availabilitySpy.mockRestore();
    });
  });

  describe('prepareRelocatedConversationSession', () => {
    it('clears the resume pointer and retains the session for history replay', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation({
        providerState: {
          providerSessionId: 'session-1',
          previousProviderSessionIds: ['session-previous'],
        },
      });
      const locationSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockImplementation(async (_vaultPath, sessionIds) => new Map(
          sessionIds.map(sessionId => [sessionId, {
            availability: 'available' as const,
            sessionPath: `/vault/${sessionId}.jsonl`,
          }]),
        ));
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockResolvedValue({ messages: [], skippedLines: 0 });

      await expect(service.prepareRelocatedConversationSession(
        conversation,
        '/vault',
      )).resolves.toBe(true);
      expect(conversation.sessionId).toBeNull();
      expect(conversation.providerState).toEqual({
        previousProviderSessionIds: ['session-previous', 'session-1'],
      });

      locationSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('does not clear resume metadata while an older segment is inaccessible', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation({
        providerState: {
          providerSessionId: 'session-1',
          previousProviderSessionIds: ['session-previous'],
        },
      });
      const currentLocationSpy = jest.spyOn(historyStore, 'locateSDKSession')
        .mockResolvedValue({
          availability: 'relocated',
          sessionPath: '/old-project/session-1.jsonl',
        });
      const locationSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map([['session-previous', { availability: 'unknown' }]]));
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockResolvedValue({ messages: [], skippedLines: 0 });

      await service.getConversationSessionAvailability(conversation, '/vault');
      await expect(service.prepareRelocatedConversationSession(
        conversation,
        '/vault',
      )).resolves.toBe(false);

      expect(conversation.sessionId).toBe('session-1');
      expect(conversation.providerState).toEqual({
        providerSessionId: 'session-1',
        previousProviderSessionIds: ['session-previous'],
      });

      currentLocationSpy.mockRestore();
      locationSpy.mockRestore();
      loadSpy.mockRestore();
    });
  });

  describe('resolveMissingConversationSession', () => {
    it('deletes only when every transcript segment is definitively missing', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation();
      const locationSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map([['session-1', { availability: 'missing' }]]));

      await expect(service.resolveMissingConversationSession(
        conversation,
        '/vault',
        'session-1',
      )).resolves.toBe('delete');
      expect(conversation.sessionId).toBe('session-1');

      locationSpy.mockRestore();
    });

    it('resets the resume pointer when an older segment is inaccessible', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation({
        providerState: {
          providerSessionId: 'session-1',
          previousProviderSessionIds: ['session-previous'],
        },
      });
      const locationSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map([
          ['session-previous', { availability: 'unknown' }],
          ['session-1', { availability: 'missing' }],
        ]));

      await expect(service.resolveMissingConversationSession(
        conversation,
        '/vault',
        'session-1',
      )).resolves.toBe('reset');
      expect(conversation.sessionId).toBeNull();
      expect(conversation.providerState).toEqual({
        previousProviderSessionIds: ['session-previous'],
      });

      locationSpy.mockRestore();
    });
  });

  describe('hydrateConversationHistory', () => {
    it('drops a stale relocated path after the session appears in the current project', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation();
      const currentLocationSpy = jest.spyOn(historyStore, 'locateSDKSession')
        .mockResolvedValueOnce({
          availability: 'relocated',
          sessionPath: '/old-project/session-1.jsonl',
        })
        .mockResolvedValueOnce({
          availability: 'available',
          sessionPath: '/vault/session-1.jsonl',
        });
      const locationsSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map());
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockResolvedValue({ messages: [], skippedLines: 0 });

      await service.getConversationSessionAvailability(conversation, '/vault');
      await service.getConversationSessionAvailability(conversation, '/vault');
      await service.hydrateConversationHistory(conversation, '/vault');

      expect(loadSpy).toHaveBeenCalledWith('/vault', 'session-1', undefined);

      currentLocationSpy.mockRestore();
      locationsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('retains a known relocated path when a later availability check is inconclusive', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation();
      const currentLocationSpy = jest.spyOn(historyStore, 'locateSDKSession')
        .mockResolvedValueOnce({
          availability: 'relocated',
          sessionPath: '/old-project/session-1.jsonl',
        })
        .mockResolvedValueOnce({ availability: 'unknown' });
      const locationsSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map());
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockResolvedValue({ messages: [], skippedLines: 0 });

      await service.getConversationSessionAvailability(conversation, '/vault');
      await service.getConversationSessionAvailability(conversation, '/vault');
      await service.hydrateConversationHistory(conversation, '/vault');

      expect(loadSpy).toHaveBeenCalledWith(
        '/vault',
        'session-1',
        undefined,
        '/old-project/session-1.jsonl',
      );

      currentLocationSpy.mockRestore();
      locationsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('replays every relocated session segment from its discovered path', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation({
        sessionId: null,
        providerState: {
          previousProviderSessionIds: ['session-previous', 'session-current'],
        },
      });
      const locationSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockImplementation(async (_vaultPath, sessionIds) => new Map(
          sessionIds.map(sessionId => [sessionId, {
            availability: 'relocated' as const,
            sessionPath: `/old-project/${sessionId}.jsonl`,
          }]),
        ));
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockImplementation(async (_vaultPath, sessionId) => ({
          messages: [{
            id: `message-${sessionId}`,
            role: 'user',
            content: sessionId,
            timestamp: sessionId === 'session-previous' ? 1 : 2,
          }],
          skippedLines: 0,
        }));

      await service.hydrateConversationHistory(conversation, '/vault');

      expect(conversation.messages.map(message => message.content)).toEqual([
        'session-previous',
        'session-current',
      ]);
      expect(loadSpy).toHaveBeenCalledWith(
        '/vault',
        'session-previous',
        undefined,
        '/old-project/session-previous.jsonl',
      );
      expect(loadSpy).toHaveBeenCalledWith(
        '/vault',
        'session-current',
        undefined,
        '/old-project/session-current.jsonl',
      );

      locationSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('retries hydration after an all-missing result', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation();
      const locationSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValueOnce(new Map([['session-1', { availability: 'missing' }]]))
        .mockResolvedValue(new Map([['session-1', {
          availability: 'relocated',
          sessionPath: '/old-project/session-1.jsonl',
        }]]));
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockResolvedValue({
          messages: [{
            id: 'recovered-message',
            role: 'user',
            content: 'Recovered',
            timestamp: 1,
          }],
          skippedLines: 0,
        });

      await service.hydrateConversationHistory(conversation, '/vault');
      await service.hydrateConversationHistory(conversation, '/vault');

      expect(conversation.messages).toHaveLength(1);
      expect(locationSpy).toHaveBeenCalledTimes(2);

      locationSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('re-hydrates when the live transcript changed on disk since the last hydration', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation();
      const signatureSpy = jest.spyOn(historyStore, 'getSDKSessionSignature')
        .mockResolvedValueOnce('100:1')
        .mockResolvedValueOnce('220:2');
      const locationsSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map([['session-1', {
          availability: 'available' as const,
          sessionPath: '/vault/session-1.jsonl',
        }]]));
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockResolvedValueOnce({
          messages: [{ id: 'message-1', role: 'user', content: 'First', timestamp: 1 }],
          skippedLines: 0,
        })
        .mockResolvedValueOnce({
          messages: [
            { id: 'message-1', role: 'user', content: 'First', timestamp: 1 },
            { id: 'message-2', role: 'assistant', content: 'Appended externally', timestamp: 2 },
          ],
          skippedLines: 0,
        });

      await service.hydrateConversationHistory(conversation, '/vault');
      expect(conversation.messages.map(message => message.id)).toEqual(['message-1']);

      // e.g. a terminal `claude --resume session-1` appended a turn
      await service.hydrateConversationHistory(conversation, '/vault');

      expect(loadSpy).toHaveBeenCalledTimes(2);
      expect(conversation.messages.map(message => message.id)).toEqual(['message-1', 'message-2']);

      signatureSpy.mockRestore();
      locationsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('does not duplicate locally-created turns when re-hydrating', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation();
      const signatureSpy = jest.spyOn(historyStore, 'getSDKSessionSignature')
        .mockResolvedValueOnce('100:1')
        .mockResolvedValueOnce('300:2');
      const locationsSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map([['session-1', {
          availability: 'available' as const,
          sessionPath: '/vault/session-1.jsonl',
        }]]));
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockResolvedValueOnce({
          messages: [{ id: 'uuid-0', role: 'user', content: 'Old turn', timestamp: 1 }],
          skippedLines: 0,
        })
        .mockResolvedValueOnce({
          messages: [
            { id: 'uuid-0', role: 'user', content: 'Old turn', timestamp: 1 },
            // Transcript twins of the locally-created turn below.
            { id: 'uuid-1', role: 'user', content: 'Local question', timestamp: 2 },
            { id: 'uuid-2', role: 'assistant', content: 'Local answer', timestamp: 3 },
            // Genuinely external turn (e.g. terminal `claude --resume`).
            { id: 'uuid-3', role: 'assistant', content: 'External turn', timestamp: 4 },
          ],
          skippedLines: 0,
        });

      await service.hydrateConversationHistory(conversation, '/vault');

      // A turn sent in the app afterwards: generated ids, provider uuids in metadata.
      conversation.messages = [
        ...conversation.messages,
        { id: 'msg-local-1', role: 'user', content: 'Local question', timestamp: 2, userMessageId: 'uuid-1' },
        { id: 'msg-local-2', role: 'assistant', content: 'Local answer', timestamp: 3, assistantMessageId: 'uuid-2' },
      ];

      await service.hydrateConversationHistory(conversation, '/vault');

      expect(conversation.messages.map(message => message.id)).toEqual([
        'uuid-0',
        'msg-local-1',
        'msg-local-2',
        'uuid-3',
      ]);

      signatureSpy.mockRestore();
      locationsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('hydrates only once while the live transcript is unchanged', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation();
      const signatureSpy = jest.spyOn(historyStore, 'getSDKSessionSignature')
        .mockResolvedValue('100:1');
      const locationsSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map([['session-1', {
          availability: 'available' as const,
          sessionPath: '/vault/session-1.jsonl',
        }]]));
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockResolvedValue({
          messages: [{ id: 'message-1', role: 'user', content: 'First', timestamp: 1 }],
          skippedLines: 0,
        });

      await service.hydrateConversationHistory(conversation, '/vault');
      await service.hydrateConversationHistory(conversation, '/vault');

      expect(loadSpy).toHaveBeenCalledTimes(1);

      signatureSpy.mockRestore();
      locationsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('does not re-hydrate when no live transcript signature is readable', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation();
      const signatureSpy = jest.spyOn(historyStore, 'getSDKSessionSignature')
        .mockResolvedValue(null);
      const locationsSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map([['session-1', {
          availability: 'available' as const,
          sessionPath: '/vault/session-1.jsonl',
        }]]));
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockResolvedValue({
          messages: [{ id: 'message-1', role: 'user', content: 'First', timestamp: 1 }],
          skippedLines: 0,
        });

      await service.hydrateConversationHistory(conversation, '/vault');
      await service.hydrateConversationHistory(conversation, '/vault');

      expect(loadSpy).toHaveBeenCalledTimes(1);

      signatureSpy.mockRestore();
      locationsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('retries hydration when one session segment has a transient read error', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation({
        providerState: {
          previousProviderSessionIds: ['session-previous'],
          providerSessionId: 'session-1',
        },
      });
      const locationSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockImplementation(async (_vaultPath, sessionIds) => new Map(
          sessionIds.map(sessionId => [sessionId, {
            availability: 'available' as const,
            sessionPath: `/vault/${sessionId}.jsonl`,
          }]),
        ));
      let currentAttempts = 0;
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockImplementation(async (_vaultPath, sessionId) => {
          if (sessionId === 'session-1' && currentAttempts++ === 0) {
            return { messages: [], skippedLines: 0, error: 'EIO' };
          }
          return {
            messages: [{
              id: `message-${sessionId}`,
              role: 'user',
              content: sessionId,
              timestamp: sessionId === 'session-previous' ? 1 : 2,
            }],
            skippedLines: 0,
          };
        });

      await service.hydrateConversationHistory(conversation, '/vault');
      await service.hydrateConversationHistory(conversation, '/vault');

      expect(conversation.messages.map(message => message.content)).toEqual([
        'session-previous',
        'session-1',
      ]);
      expect(locationSpy).toHaveBeenCalledTimes(2);
      expect(loadSpy).toHaveBeenCalledTimes(4);

      locationSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('retries hydration when one session segment has unknown availability', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation({
        providerState: {
          previousProviderSessionIds: ['session-previous'],
          providerSessionId: 'session-1',
        },
      });
      const available = (sessionId: string) => ({
        availability: 'available' as const,
        sessionPath: `/vault/${sessionId}.jsonl`,
      });
      const locationSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValueOnce(new Map<string, SDKSessionLocation>([
          ['session-previous', { availability: 'unknown' }],
          ['session-1', available('session-1')],
        ]))
        .mockResolvedValueOnce(new Map<string, SDKSessionLocation>([
          ['session-previous', available('session-previous')],
          ['session-1', available('session-1')],
        ]));
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockImplementation(async (_vaultPath, sessionId) => ({
          messages: [{
            id: `message-${sessionId}`,
            role: 'user',
            content: sessionId,
            timestamp: sessionId === 'session-previous' ? 1 : 2,
          }],
          skippedLines: 0,
        }));

      await service.hydrateConversationHistory(conversation, '/vault');
      await service.hydrateConversationHistory(conversation, '/vault');

      expect(conversation.messages.map(message => message.content)).toEqual([
        'session-previous',
        'session-1',
      ]);
      expect(locationSpy).toHaveBeenCalledTimes(2);
      expect(loadSpy).toHaveBeenCalledTimes(3);

      locationSpy.mockRestore();
      loadSpy.mockRestore();
    });
  });
});
