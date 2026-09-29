import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { testDate, testTime } from '@test/helpers/testClock';

import type { Conversation, ToolCallInfo } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import * as historyStore from '@/providers/claude/history/ClaudeHistoryStore';
import type { SDKSessionLocation } from '@/providers/claude/history/sdkSessionPaths';

function createConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conversation-1',
    providerId: 'claude',
    title: 'Conversation',
    createdAt: 1,
    lastActivityAt: 1,
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
      expect(availabilitySpy).toHaveBeenCalledWith('/vault', 'session-1', undefined);

      availabilitySpy.mockRestore();
    });

    it('uses the effective SDK environment when locating a native session', async () => {
      const availabilitySpy = jest.spyOn(historyStore, 'locateSDKSession')
        .mockResolvedValue({ availability: 'available', sessionPath: '/custom/session-1.jsonl' });
      const service = new ClaudeConversationHistoryService();
      const pathContext = {
        environment: { CLAUDE_CONFIG_DIR: '/custom/claude' },
        vaultPath: '/vault',
      };

      await expect(service.getConversationSessionAvailability(
        createConversation(),
        '/vault',
        pathContext,
      )).resolves.toBe('available');

      expect(availabilitySpy).toHaveBeenCalledWith('/vault', 'session-1', pathContext);
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
      expect(availabilitySpy).toHaveBeenCalledWith('/vault', 'source-session', undefined);

      availabilitySpy.mockRestore();
    });
  });

  describe('recoverConversationModelSelection', () => {
    it('recovers the last model across transcript segments at the resume checkpoint', async () => {
      const locationsSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map([
          ['session-previous', {
            availability: 'available',
            sessionPath: '/vault/session-previous.jsonl',
          }],
          ['session-current', {
            availability: 'available',
            sessionPath: '/vault/session-current.jsonl',
          }],
        ]));
      const modelSpy = jest.spyOn(historyStore, 'loadSDKSessionModel')
        .mockResolvedValueOnce('claude-sonnet-4-5')
        .mockResolvedValueOnce('claude-opus-4-6');
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation({
        sessionId: 'session-current',
        resumeAtMessageId: 'assistant-checkpoint',
        providerState: {
          previousProviderSessionIds: ['session-previous'],
          providerSessionId: 'session-current',
        },
      });

      await expect(service.recoverConversationModelSelection(
        conversation,
        '/vault',
      )).resolves.toBe('claude-code/claude-opus-4-6');
      expect(modelSpy).toHaveBeenNthCalledWith(
        1,
        '/vault',
        'session-previous',
        undefined,
        '/vault/session-previous.jsonl',
        undefined,
      );
      expect(modelSpy).toHaveBeenNthCalledWith(
        2,
        '/vault',
        'session-current',
        'assistant-checkpoint',
        '/vault/session-current.jsonl',
        undefined,
      );

      locationsSpy.mockRestore();
      modelSpy.mockRestore();
    });

    it('does not recover an older model when the current segment is unresolved', async () => {
      const locationsSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map([
          ['session-previous', {
            availability: 'available',
            sessionPath: '/vault/session-previous.jsonl',
          }],
          ['session-current', {
            availability: 'available',
            sessionPath: '/vault/session-current.jsonl',
          }],
        ]));
      const modelSpy = jest.spyOn(historyStore, 'loadSDKSessionModel')
        .mockResolvedValueOnce('claude-sonnet-4-5')
        .mockResolvedValueOnce(null);
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation({
        sessionId: 'session-current',
        resumeAtMessageId: 'missing-checkpoint',
        providerState: {
          previousProviderSessionIds: ['session-previous'],
          providerSessionId: 'session-current',
        },
      });

      await expect(service.recoverConversationModelSelection(
        conversation,
        '/vault',
      )).resolves.toBeNull();

      locationsSpy.mockRestore();
      modelSpy.mockRestore();
    });

    it('does not recover an older model when the final preserved segment is unresolved', async () => {
      const locationsSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map([
          ['session-older', {
            availability: 'available',
            sessionPath: '/vault/session-older.jsonl',
          }],
          ['session-newest', {
            availability: 'available',
            sessionPath: '/vault/session-newest.jsonl',
          }],
        ]));
      const modelSpy = jest.spyOn(historyStore, 'loadSDKSessionModel')
        .mockResolvedValueOnce('claude-sonnet-4-5')
        .mockResolvedValueOnce(null);
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation({
        sessionId: null,
        providerState: {
          previousProviderSessionIds: ['session-older', 'session-newest'],
        },
      });

      await expect(service.recoverConversationModelSelection(
        conversation,
        '/vault',
      )).resolves.toBeNull();

      locationsSpy.mockRestore();
      modelSpy.mockRestore();
    });
  });

  describe('conversation open without a stored model', () => {
    it.each([false, true])('parses the transcript once unless it changes before hydration (changed: %s)', async (changed) => {
      const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-model-read-'));
      const vaultPath = path.join(configDir, 'vault');
      const pathContext = { environment: { CLAUDE_CONFIG_DIR: configDir }, vaultPath };
      const sessionDir = path.join(historyStore.getSDKProjectsPath(pathContext), historyStore.encodeVaultPathForSDK(vaultPath));
      const sessionPath = path.join(sessionDir, 'session-1.jsonl');
      const entry = (value: Record<string, unknown>) => JSON.stringify(value);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(sessionPath, [
        entry({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { content: 'Question' } }),
        entry({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-01-01T00:00:01Z',
          message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Answer' }] } }),
      ].join('\n'));
      // Spy on the module object that the history reader's namespace import delegates to.
      const readSpy = jest.spyOn(jest.requireActual<typeof fs>('fs/promises'), 'readFile');
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation();

      try {
        // The repository hands each call its own copy of the conversation.
        await expect(service.recoverConversationModelSelection(structuredClone(conversation), vaultPath, pathContext))
          .resolves.toBe('claude-code/claude-opus-4-6');
        if (changed) {
          await fs.appendFile(sessionPath, '\n' + entry({ type: 'user', uuid: 'u2', parentUuid: 'a1',
            timestamp: '2026-01-01T00:00:02Z', message: { content: 'Follow-up' } }));
        }
        const history = await service.hydrateConversationHistory(structuredClone(conversation), vaultPath, pathContext);

        expect(history.messages?.map(message => message.content))
          .toEqual(changed ? ['Question', 'Answer', 'Follow-up'] : ['Question', 'Answer']);
        expect(readSpy.mock.calls.filter(([file]) => file === sessionPath)).toHaveLength(changed ? 2 : 1);
      } finally {
        readSpy.mockRestore();
        await fs.rm(configDir, { recursive: true, force: true });
      }
    });

    it('releases an unused parsed transcript after 30 seconds without another history read', async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-read-expiry-'));
      const sessionPath = path.join(directory, 'session-1.jsonl');
      await fs.writeFile(sessionPath, JSON.stringify({
        type: 'assistant', uuid: 'a1', timestamp: testTime(),
        message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Answer' }] },
      }));
      jest.useFakeTimers({ now: testDate().getTime() });
      // Observe release without accessing history again, which would hide lazy expiry.
      const deleteSpy = jest.spyOn(Map.prototype, 'delete');
      try {
        await expect(historyStore.loadSDKSessionModel(directory, 'session-1', undefined, sessionPath))
          .resolves.toBe('claude-opus-4-6');
        deleteSpy.mockClear();
        jest.advanceTimersByTime(29_999);
        expect(deleteSpy).not.toHaveBeenCalledWith(sessionPath);
        jest.advanceTimersByTime(1);
        expect(deleteSpy).toHaveBeenCalledWith(sessionPath);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        deleteSpy.mockRestore();
        jest.useRealTimers();
        await fs.rm(directory, { recursive: true, force: true });
      }
    });

    it('cancels expiry timers when a pending parse is replaced, evicted, or consumed', async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-read-lifecycle-'));
      const sessionPaths = Array.from({ length: 5 }, (_, index) => path.join(directory, `${index}.jsonl`));
      const entry = JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: testTime(),
        message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Answer' }] } });
      await Promise.all(sessionPaths.map(sessionPath => fs.writeFile(sessionPath, entry)));
      jest.useFakeTimers({ now: testDate().getTime() });
      const read = (sessionPath: string) => historyStore.loadSDKSessionModel(directory, 'session', undefined, sessionPath);
      try {
        await read(sessionPaths[0]);
        jest.advanceTimersByTime(10_000);
        await read(sessionPaths[0]);
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(20_000);
        expect(jest.getTimerCount()).toBe(1);
        for (const sessionPath of sessionPaths.slice(1)) await read(sessionPath);
        expect(jest.getTimerCount()).toBe(4);
        await historyStore.loadSDKSessionMessages(directory, 'session', undefined, sessionPaths[4]);
        expect(jest.getTimerCount()).toBe(3);
        jest.advanceTimersByTime(30_000);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
        await fs.rm(directory, { recursive: true, force: true });
      }
    });

    it('shares relocated session lookups between copies of the same session state only', async () => {
      const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-relocated-open-'));
      const vaultPath = path.join(configDir, 'vault');
      const pathContext = { environment: { CLAUDE_CONFIG_DIR: configDir }, vaultPath };
      const projectsPath = historyStore.getSDKProjectsPath(pathContext);
      const writeSession = async (project: string, sessionId: string, text: string) => {
        const sessionPath = path.join(projectsPath, project, `${sessionId}.jsonl`);
        await fs.mkdir(path.dirname(sessionPath), { recursive: true });
        await fs.writeFile(sessionPath, [
          JSON.stringify({ type: 'user', uuid: `${sessionId}-u`, timestamp: testTime(), message: { content: text } }),
          JSON.stringify({ type: 'assistant', uuid: `${sessionId}-a`, parentUuid: `${sessionId}-u`,
            timestamp: testTime({ seconds: 1 }), message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Answer' }] } }),
        ].join('\n'));
        return sessionPath;
      };
      const sessionPath = await writeSession('old-project', 'session-1', 'Relocated');
      await writeSession('other-project', 'session-2', 'Replacement');
      const actualFs = jest.requireActual<typeof fs>('fs/promises');
      const readdirSpy = jest.spyOn(actualFs, 'readdir');
      const readSpy = jest.spyOn(actualFs, 'readFile');
      const rootScans = () => readdirSpy.mock.calls.filter(([directory]) => directory === projectsPath).length;
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation();

      try {
        // The repository hands each call its own copy of the conversation.
        await expect(service.getConversationSessionAvailability(structuredClone(conversation), vaultPath, pathContext))
          .resolves.toBe('relocated');
        await expect(service.recoverConversationModelSelection(structuredClone(conversation), vaultPath, pathContext))
          .resolves.toBe('claude-code/claude-opus-4-6');
        const history = await service.hydrateConversationHistory(structuredClone(conversation), vaultPath, pathContext);

        expect(history.messages?.map(message => message.content)).toEqual(['Relocated', 'Answer']);
        expect(rootScans()).toBe(1);
        expect(readSpy.mock.calls.filter(([file]) => file === sessionPath)).toHaveLength(1);

        const replaced = await service.hydrateConversationHistory(
          createConversation({ sessionId: 'session-2' }),
          vaultPath,
          pathContext,
        );
        expect(replaced.messages?.map(message => message.content)).toEqual(['Replacement', 'Answer']);
        expect(rootScans()).toBe(2);
      } finally {
        readdirSpy.mockRestore();
        readSpy.mockRestore();
        await fs.rm(configDir, { recursive: true, force: true });
      }
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

      const update1 = await service.prepareRelocatedConversationSession(
        conversation,
        '/vault',
      );
      expect(update1).not.toBeNull();
      Object.assign(conversation, update1);
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
      const update2 = await service.prepareRelocatedConversationSession(
        conversation,
        '/vault',
      );
      expect(update2).toBeNull();
      Object.assign(conversation, update2);

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

      const update3 = await service.resolveMissingConversationSession(
        conversation,
        '/vault',
        'session-1',
      );
      expect(update3.outcome).toBe('delete');
      Object.assign(conversation, update3.changes);
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

      const update4 = await service.resolveMissingConversationSession(
        conversation,
        '/vault',
        'session-1',
      );
      expect(update4.outcome).toBe('reset');
      Object.assign(conversation, update4.changes);
      expect(conversation.sessionId).toBeNull();
      expect(conversation.providerState).toEqual({
        previousProviderSessionIds: ['session-previous'],
      });

      locationSpy.mockRestore();
    });
  });

  describe('hydrateConversationHistory', () => {
    it('recovers an unlinked native transcript from the conversation timestamps', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation({
        sessionId: null,
        providerState: undefined,
        createdAt: 1_000,
        lastActivityAt: 2_000,
      });
      const recoverySpy = jest.spyOn(historyStore, 'recoverSDKSessionIdByTime')
        .mockResolvedValue('recovered-session');

      const update5 = await service.recoverConversationSessionReference(
        conversation,
        '/vault',
      );
      expect(update5).not.toBeNull();
      Object.assign(conversation, update5);

      expect(recoverySpy).toHaveBeenCalledWith('/vault', {
        createdAt: 1_000,
        lastActivityAt: 2_000,
      }, undefined);
      expect(conversation).toMatchObject({
        sessionId: 'recovered-session',
        providerState: { providerSessionId: 'recovered-session' },
      });

      recoverySpy.mockRestore();
    });

    it('uses native recovery instead of old conversation backup headers', async () => {
      const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-retired-backup-'));
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation({ sessionId: null, providerState: undefined });
      const recoverySpy = jest.spyOn(historyStore, 'recoverSDKSessionIdByTime').mockResolvedValue(null);
      try {
        const folder = path.join(vaultPath, '.claude', 'sessions');
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(path.join(folder, conversation.id + '.jsonl'), JSON.stringify({
          type: 'meta', id: conversation.id, sessionId: 'retired-session',
        }));
        const update6 = await service.recoverConversationSessionReference(conversation, vaultPath);
      expect(update6).toBeNull();
      Object.assign(conversation, update6);
        expect(recoverySpy).toHaveBeenCalled();
        expect(conversation.sessionId).toBeNull();
        expect(conversation.providerState).toBeUndefined();
      } finally {
        recoverySpy.mockRestore();
        await fs.rm(vaultPath, { recursive: true, force: true });
      }
    });

    it('re-resolves history when the effective Claude config directory changes', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation();
      const contextA = {
        environment: { CLAUDE_CONFIG_DIR: '/config-a' },
        vaultPath: '/vault',
      };
      const contextB = {
        environment: { CLAUDE_CONFIG_DIR: '/config-b' },
        vaultPath: '/vault',
      };
      const locationSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockImplementation(async (_vaultPath, sessionIds, pathContext) => new Map(
          sessionIds.map(sessionId => [sessionId, {
            availability: 'available' as const,
            sessionPath: `${pathContext?.environment?.CLAUDE_CONFIG_DIR}/${sessionId}.jsonl`,
          }]),
        ));
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockImplementation(async (_vaultPath, _sessionId, _resumeAt, _sessionPath, pathContext) => {
          const configDir = pathContext?.environment?.CLAUDE_CONFIG_DIR;
          return {
            messages: [{
              id: `message-${configDir}`,
              role: 'user',
              content: configDir ?? '',
              timestamp: configDir === '/config-a' ? 1 : 2,
            }],
            skippedLines: 0,
          };
        });

      const first = await service.hydrateConversationHistory(conversation, '/vault', contextA);
      expect(conversation.messages).toEqual([]);
      expect(await service.hydrateConversationHistory(conversation, '/vault', contextA)).toEqual(first);
      Object.assign(conversation, first);
      Object.assign(conversation, await service.hydrateConversationHistory(conversation, '/vault', contextB));

      expect(conversation.messages.map(message => message.content)).toEqual([
        '/config-a',
        '/config-b',
      ]);
      expect(loadSpy).toHaveBeenCalledTimes(3);

      locationSpy.mockRestore();
      loadSpy.mockRestore();
    });

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
      Object.assign(conversation, await service.hydrateConversationHistory(conversation, '/vault'));

      expect(loadSpy).toHaveBeenCalledWith('/vault', 'session-1', undefined, undefined, undefined);

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

      await expect(service.getConversationSessionAvailability(conversation, '/vault'))
        .resolves.toBe('relocated');
      await service.getConversationSessionAvailability(conversation, '/vault');
      Object.assign(conversation, await service.hydrateConversationHistory(conversation, '/vault'));

      expect(loadSpy).toHaveBeenCalledWith(
        '/vault',
        'session-1',
        undefined,
        '/old-project/session-1.jsonl',
        undefined,
      );

      currentLocationSpy.mockRestore();
      locationsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('loads cached async subagent sidecars concurrently and searches segments in order', async () => {
      const service = new ClaudeConversationHistoryService();
      const subagent = (agentId: string) => ({
        id: `task-${agentId}`, description: agentId, mode: 'async' as const, status: 'completed' as const,
        asyncStatus: 'completed' as const, agentId, isExpanded: false, toolCalls: [],
      });
      const conversation = createConversation({
        sessionId: 'session-current',
        providerState: {
          previousProviderSessionIds: ['session-previous'],
          providerSessionId: 'session-current',
          subagentData: { 'task-agent-a': subagent('agent-a'), 'task-agent-b': subagent('agent-b') },
        },
      });
      const settle = async () => {
        for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setTimeout(resolve, 0));
      };
      const locationSpy = jest.spyOn(historyStore, 'locateSDKSessions')
        .mockImplementation(async (_vaultPath, sessionIds) => new Map(
          sessionIds.map(sessionId => [sessionId, { availability: 'available' as const, sessionPath: `/${sessionId}.jsonl` }]),
        ));
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockResolvedValue({ messages: [], skippedLines: 0 });
      const pending = new Map<string, (toolCalls: ToolCallInfo[]) => void>();
      const sidecarSpy = jest.spyOn(historyStore, 'loadSubagentToolCalls')
        .mockImplementation((_vaultPath, sessionId, agentId) => new Promise(resolve => {
          pending.set(`${sessionId}:${agentId}`, resolve);
        }));

      try {
        const hydration = service.hydrateConversationHistory(conversation, '/vault');
        await settle();
        expect([...pending.keys()]).toEqual(['session-previous:agent-a', 'session-previous:agent-b']);

        pending.get('session-previous:agent-a')!([{ id: 'a-tool', name: 'Read', input: {}, status: 'completed' }]);
        pending.get('session-previous:agent-b')!([]);
        await settle();
        expect([...pending.keys()]).toContain('session-current:agent-b');
        pending.get('session-current:agent-b')!([{ id: 'b-tool', name: 'Grep', input: {}, status: 'completed' }]);

        const history = await hydration;
        const toolCallIds = (id: string) => history.messages?.flatMap(message => message.toolCalls ?? [])
          .find(toolCall => toolCall.id === id)?.subagent?.toolCalls.map(toolCall => toolCall.id);
        expect(toolCallIds('task-agent-a')).toEqual(['a-tool']);
        expect(toolCallIds('task-agent-b')).toEqual(['b-tool']);
        expect(sidecarSpy).toHaveBeenCalledTimes(3);
      } finally {
        locationSpy.mockRestore();
        loadSpy.mockRestore();
        sidecarSpy.mockRestore();
      }
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
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started: string[] = [];
      let notifyStarted!: () => void;
      const firstStarted = new Promise<void>(resolve => { notifyStarted = resolve; });
      const loadSpy = jest.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockImplementation(async (_vaultPath, sessionId) => {
          started.push(sessionId);
          notifyStarted();
          await gate;
          return { messages: [{
            id: `message-${sessionId}`,
            role: 'user',
            content: sessionId,
            timestamp: sessionId === 'session-previous' ? 1 : 2,
          }],
          skippedLines: 0 };
        });

      const pending = service.hydrateConversationHistory(conversation, '/vault');
      await firstStarted;
      await Promise.resolve();
      const startedBeforeRelease = [...started];
      release();
      Object.assign(conversation, await pending);
      expect(startedBeforeRelease).toEqual(['session-previous', 'session-current']);

      expect(conversation.messages.map(message => message.content)).toEqual([
        'session-previous',
        'session-current',
      ]);
      expect(loadSpy).toHaveBeenCalledWith(
        '/vault',
        'session-previous',
        undefined,
        '/old-project/session-previous.jsonl',
        undefined,
      );
      expect(loadSpy).toHaveBeenCalledWith(
        '/vault',
        'session-current',
        undefined,
        '/old-project/session-current.jsonl',
        undefined,
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

      Object.assign(conversation, await service.hydrateConversationHistory(conversation, '/vault'));
      Object.assign(conversation, await service.hydrateConversationHistory(conversation, '/vault'));

      expect(conversation.messages).toHaveLength(1);
      expect(locationSpy).toHaveBeenCalledTimes(2);

      locationSpy.mockRestore();
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

      Object.assign(conversation, await service.hydrateConversationHistory(conversation, '/vault'));
      Object.assign(conversation, await service.hydrateConversationHistory(conversation, '/vault'));

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

      Object.assign(conversation, await service.hydrateConversationHistory(conversation, '/vault'));
      Object.assign(conversation, await service.hydrateConversationHistory(conversation, '/vault'));

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
