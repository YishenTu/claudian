import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { testDate, testTime } from '@test/helpers/testClock';

import type { Conversation, ToolCallInfo } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import type { SDKSessionLocation } from '@/providers/claude/history/ClaudeHistoryPathResolver';
import * as historyStore from '@/providers/claude/history/ClaudeHistoryStore';

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
      const availabilitySpy = vi.spyOn(historyStore, 'locateSDKSession')
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
      const availabilitySpy = vi.spyOn(historyStore, 'locateSDKSession')
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
      const availabilitySpy = vi.spyOn(historyStore, 'locateSDKSession');
      const service = new ClaudeConversationHistoryService();

      await expect(service.getConversationSessionAvailability(
        createConversation({ sessionId: null }),
        '/vault',
      )).resolves.toBe('unknown');
      expect(availabilitySpy).not.toHaveBeenCalled();

      availabilitySpy.mockRestore();
    });

    it('checks the source session for a pending fork', async () => {
      const availabilitySpy = vi.spyOn(historyStore, 'locateSDKSession')
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


  describe('prepareRelocatedConversationSession', () => {
    it('clears the resume pointer and retains the session for history replay', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation({
        providerState: {
          providerSessionId: 'session-1',
          previousProviderSessionIds: ['session-previous'],
        },
      });
      const locationSpy = vi.spyOn(historyStore, 'locateSDKSessions')
        .mockImplementation(async (_vaultPath, sessionIds) => new Map(
          sessionIds.map(sessionId => [sessionId, {
            availability: 'available' as const,
            sessionPath: `/vault/${sessionId}.jsonl`,
          }]),
        ));
      const loadSpy = vi.spyOn(historyStore, 'loadSDKSessionMessages')
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
      const currentLocationSpy = vi.spyOn(historyStore, 'locateSDKSession')
        .mockResolvedValue({
          availability: 'relocated',
          sessionPath: '/old-project/session-1.jsonl',
        });
      const locationSpy = vi.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map([['session-previous', { availability: 'unknown' }]]));
      const loadSpy = vi.spyOn(historyStore, 'loadSDKSessionMessages')
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

  describe('sessions retired by an earlier version', () => {
    it('reads every retired session without restoring the latest one as the binding', async () => {
      const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-retired-binding-'));
      const vaultPath = path.join(configDir, 'vault');
      const pathContext = { environment: { CLAUDE_CONFIG_DIR: configDir }, vaultPath };
      const sessionDir = path.join(historyStore.getSDKProjectsPath(pathContext), historyStore.encodeVaultPathForSDK(vaultPath));
      const providerState = { previousProviderSessionIds: ['session-0', 'session-1'] };
      try {
        await fs.mkdir(sessionDir, { recursive: true });
        // Both transcripts are still in the configured store, which once restored the latest one.
        await Promise.all(providerState.previousProviderSessionIds.map((sessionId, index) => fs.writeFile(
          path.join(sessionDir, `${sessionId}.jsonl`),
          JSON.stringify({
            type: 'user', uuid: `u${index}`, sessionId, timestamp: testTime({ seconds: index }), message: { content: `Question ${index}` },
          }),
        )));

        const update = await new ClaudeConversationHistoryService().hydrateConversationHistory(
          createConversation({ sessionId: null, providerState: structuredClone(providerState) }),
          vaultPath,
          pathContext,
        );

        expect(update.messages?.map(message => message.content)).toEqual(['Question 0', 'Question 1']);
        expect(update.sessionId).toBeNull();
        expect(update.providerState).toEqual(providerState);
      } finally {
        await fs.rm(configDir, { recursive: true, force: true });
      }
    });
  });

  describe('hydrateConversationHistory', () => {

    it('replaces live turn projections with native history, keeping unconsumed notifications and the unconfirmed tail', async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-live-projection-'));
      const sessionPath = path.join(directory, 'session-1.jsonl');
      const notification = '<task-notification><task-id>bg-1</task-id><tool-use-id>bash</tool-use-id>'
        + '<status>completed</status><summary>Background command completed (exit code 0).</summary></task-notification>';
      const rows = [
        { type: 'user', uuid: 'command', timestamp: testTime({ seconds: 0 }), message: { content:
          '<command-message>bg-test</command-message>\n<command-name>/bg-test</command-name>\n<command-args>hello world</command-args>' } },
        { type: 'user', uuid: 'skill-body', isMeta: true, timestamp: testTime({ seconds: 0 }),
          message: { content: [{ type: 'text', text: 'Base directory for this skill' }] } },
        { type: 'assistant', uuid: 'launch', timestamp: testTime({ seconds: 1 }), message: { stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'sleep 20', run_in_background: true } }] } },
        { type: 'user', uuid: 'launched', timestamp: testTime({ seconds: 2 }), toolUseResult: {},
          message: { content: [{ type: 'tool_result', tool_use_id: 'bash', content: 'Started' }] } },
        { type: 'assistant', uuid: 'first-final', timestamp: testTime({ seconds: 3 }),
          message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Background task started.' }] } },
        { type: 'user', uuid: 'notification', timestamp: testTime({ seconds: 23 }), message: { content: notification } },
        { type: 'assistant', uuid: 'notified-final', timestamp: testTime({ seconds: 24 }),
          message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'It finished.' }] } },
      ];
      await fs.writeFile(sessionPath, rows.map((row, index) => JSON.stringify({
        ...row, parentUuid: rows[index - 1]?.uuid ?? null,
      })).join('\n'));
      const locationSpy = vi.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map([['session-1', { availability: 'relocated', sessionPath }]]));
      // The tab's transcript after the turn and the background response, as saved to the repository.
      const live: Conversation['messages'] = [
        { id: 'local-user', role: 'user', content: '/bg-test hello world', displayContent: '/bg-test hello world',
          timestamp: testDate({ seconds: 0 }).getTime(), userMessageId: 'sent-uuid' },
        { id: 'local-response', role: 'assistant', content: 'Background task started.', timestamp: testDate({ seconds: 0 }).getTime(),
          assistantMessageId: 'first-final', toolCalls: [{ id: 'bash', name: 'Bash', input: {}, status: 'completed' }] },
        { id: 'local-unconsumed', role: 'assistant', isAutomaticResponse: true, content: '', timestamp: testDate({ seconds: 10 }).getTime(),
          contentBlocks: [{ type: 'task_notification', content: 'Another task finished.' }] },
        { id: 'local-notification', role: 'assistant', isAutomaticResponse: true, content: '', timestamp: testDate({ seconds: 23 }).getTime(),
          contentBlocks: [{ type: 'task_notification', content: 'Background command completed (exit code 0).' }] },
        { id: 'local-background', role: 'assistant', isAutomaticResponse: true, content: 'It finished.',
          timestamp: testDate({ seconds: 23 }).getTime(), assistantMessageId: 'notified-final' },
        { id: 'local-pending', role: 'user', content: 'Next question', timestamp: testDate({ seconds: 30 }).getTime() },
      ];

      try {
        const hydrated = await new ClaudeConversationHistoryService()
          .hydrateConversationHistory(createConversation({ messages: live }), '/vault');

        expect(hydrated.messages?.map(message => [message.id, message.displayContent ?? message.content])).toEqual([
          ['command', '/bg-test hello world'],
          ['launch', 'Background task started.'],
          ['local-unconsumed', ''],
          ['notification', 'It finished.'],
          ['local-pending', 'Next question'],
        ]);
      } finally {
        locationSpy.mockRestore();
        await fs.rm(directory, { recursive: true, force: true });
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
      const locationSpy = vi.spyOn(historyStore, 'locateSDKSessions')
        .mockImplementation(async (_vaultPath, sessionIds, pathContext) => new Map(
          sessionIds.map(sessionId => [sessionId, {
            availability: 'available' as const,
            sessionPath: `${pathContext?.environment?.CLAUDE_CONFIG_DIR}/${sessionId}.jsonl`,
          }]),
        ));
      const loadSpy = vi.spyOn(historyStore, 'loadSDKSessionMessages')
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
      const currentLocationSpy = vi.spyOn(historyStore, 'locateSDKSession')
        .mockResolvedValueOnce({
          availability: 'relocated',
          sessionPath: '/old-project/session-1.jsonl',
        })
        .mockResolvedValueOnce({
          availability: 'available',
          sessionPath: '/vault/session-1.jsonl',
        });
      const locationsSpy = vi.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map());
      const loadSpy = vi.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockResolvedValue({ messages: [], skippedLines: 0 });

      await service.getConversationSessionAvailability(conversation, '/vault');
      await service.getConversationSessionAvailability(conversation, '/vault');
      Object.assign(conversation, await service.hydrateConversationHistory(conversation, '/vault'));

      expect(loadSpy).toHaveBeenCalledWith('/vault', 'session-1', undefined, undefined, undefined, 'latest-branch');

      currentLocationSpy.mockRestore();
      locationsSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('retains a known relocated path when a later availability check is inconclusive', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation();
      const currentLocationSpy = vi.spyOn(historyStore, 'locateSDKSession')
        .mockResolvedValueOnce({
          availability: 'relocated',
          sessionPath: '/old-project/session-1.jsonl',
        })
        .mockResolvedValueOnce({ availability: 'unknown' });
      const locationsSpy = vi.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValue(new Map());
      const loadSpy = vi.spyOn(historyStore, 'loadSDKSessionMessages')
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
        'latest-branch',
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
      let notifyPreviousStarted!: () => void;
      const previousStarted = new Promise<void>(resolve => { notifyPreviousStarted = resolve; });
      let notifyCurrentStarted!: () => void;
      const currentStarted = new Promise<void>(resolve => { notifyCurrentStarted = resolve; });
      const locationSpy = vi.spyOn(historyStore, 'locateSDKSessions')
        .mockImplementation(async (_vaultPath, sessionIds) => new Map(
          sessionIds.map(sessionId => [sessionId, { availability: 'available' as const, sessionPath: `/${sessionId}.jsonl` }]),
        ));
      const loadSpy = vi.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockResolvedValue({ messages: [], skippedLines: 0 });
      const pending = new Map<string, (toolCalls: ToolCallInfo[]) => void>();
      const sidecarSpy = vi.spyOn(historyStore, 'loadSubagentToolCalls')
        .mockImplementation((_vaultPath, sessionId, agentId) => new Promise(resolve => {
          pending.set(`${sessionId}:${agentId}`, resolve);
          if (pending.has('session-previous:agent-a') && pending.has('session-previous:agent-b')) notifyPreviousStarted();
          if (sessionId === 'session-current') notifyCurrentStarted();
        }));

      try {
        const hydration = service.hydrateConversationHistory(conversation, '/vault');
        await previousStarted;
        expect([...pending.keys()]).toEqual(['session-previous:agent-a', 'session-previous:agent-b']);

        pending.get('session-previous:agent-a')!([{ id: 'a-tool', name: 'Read', input: {}, status: 'completed' }]);
        pending.get('session-previous:agent-b')!([]);
        await currentStarted;
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
      const locationSpy = vi.spyOn(historyStore, 'locateSDKSessions')
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
      const loadSpy = vi.spyOn(historyStore, 'loadSDKSessionMessages')
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
        'latest-branch',
      );
      expect(loadSpy).toHaveBeenCalledWith(
        '/vault',
        'session-current',
        undefined,
        '/old-project/session-current.jsonl',
        undefined,
        'latest-branch',
      );

      locationSpy.mockRestore();
      loadSpy.mockRestore();
    });

    it('retries hydration after an all-missing result', async () => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation();
      const locationSpy = vi.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValueOnce(new Map([['session-1', { availability: 'missing' }]]))
        .mockResolvedValue(new Map([['session-1', {
          availability: 'relocated',
          sessionPath: '/old-project/session-1.jsonl',
        }]]));
      const loadSpy = vi.spyOn(historyStore, 'loadSDKSessionMessages')
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
      const locationSpy = vi.spyOn(historyStore, 'locateSDKSessions')
        .mockImplementation(async (_vaultPath, sessionIds) => new Map(
          sessionIds.map(sessionId => [sessionId, {
            availability: 'available' as const,
            sessionPath: `/vault/${sessionId}.jsonl`,
          }]),
        ));
      let currentAttempts = 0;
      const loadSpy = vi.spyOn(historyStore, 'loadSDKSessionMessages')
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

    it.each(['missing', 'unknown'] as const)('preserves cached history and retries when one session segment is %s', async availability => {
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation({
        providerState: {
          previousProviderSessionIds: ['session-previous'],
          providerSessionId: 'session-1',
        },
        // Cached messages are the live projection under Claudian-local ids.
        messages: [
          {
            id: 'local-previous-user',
            role: 'user',
            content: 'previous question',
            userMessageId: 'user-previous',
            timestamp: testDate({ seconds: 1 }).getTime(),
          },
          {
            id: 'local-user',
            role: 'user',
            content: 'question',
            userMessageId: 'user-1',
            timestamp: testDate({ seconds: 2 }).getTime(),
          },
          {
            id: 'local-assistant',
            role: 'assistant',
            content: 'answer',
            assistantMessageId: 'assistant-1',
            timestamp: testDate({ seconds: 3 }).getTime(),
          },
        ],
      });
      const available = (sessionId: string) => ({
        availability: 'available' as const,
        sessionPath: `/vault/${sessionId}.jsonl`,
      });
      const locationSpy = vi.spyOn(historyStore, 'locateSDKSessions')
        .mockResolvedValueOnce(new Map<string, SDKSessionLocation>([
          ['session-previous', { availability }],
          ['session-1', available('session-1')],
        ]))
        .mockResolvedValueOnce(new Map<string, SDKSessionLocation>([
          ['session-previous', available('session-previous')],
          ['session-1', available('session-1')],
        ]));
      const loadSpy = vi.spyOn(historyStore, 'loadSDKSessionMessages')
        .mockImplementation(async (_vaultPath, sessionId) => ({
          messages: sessionId === 'session-previous'
            ? [{
              id: 'native-previous-user',
              role: 'user',
              content: 'previous question',
              userMessageId: 'user-previous',
              timestamp: testDate({ seconds: 1 }).getTime(),
            }]
            : [
              {
                id: 'native-user',
                role: 'user',
                content: 'question',
                userMessageId: 'user-1',
                timestamp: testDate({ seconds: 2 }).getTime(),
              },
              {
                id: 'native-assistant',
                role: 'assistant',
                content: 'answer',
                assistantMessageId: 'assistant-1',
                timestamp: testDate({ seconds: 3 }).getTime(),
              },
            ],
          skippedLines: 0,
        }));

      try {
        Object.assign(conversation, await service.hydrateConversationHistory(conversation, '/vault'));
        // Native history supersedes the copies it reflects; the unreadable segment's copy stays.
        expect(conversation.messages.map(message => message.id)).toEqual([
          'local-previous-user',
          'native-user',
          'native-assistant',
        ]);
        Object.assign(conversation, await service.hydrateConversationHistory(conversation, '/vault'));

        expect(conversation.messages.map(message => message.id)).toEqual([
          'native-previous-user',
          'native-user',
          'native-assistant',
        ]);
        expect(locationSpy).toHaveBeenCalledTimes(2);
        expect(loadSpy).toHaveBeenCalledTimes(3);
      } finally {
        locationSpy.mockRestore();
        loadSpy.mockRestore();
      }
    });
  });
});
