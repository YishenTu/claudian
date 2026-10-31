const actualModule0 = await import('node:fs');
const actualModule1 = await import('fs/promises');
const actualModule2 = await import('node:fs');
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { useClaudeSessionFiles } from '@test/helpers/providers/claudeHistory';
import { testDate, testTime } from '@test/helpers/testClock';

import type { Conversation } from '@/core/types';
import { ClaudeConversationHistoryService } from '@/providers/claude/history/ClaudeConversationHistoryService';
import * as historyStore from '@/providers/claude/history/ClaudeHistoryStore';
import type { SDKNativeMessage } from '@/providers/claude/history/sdkHistoryTypes';


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

it.each([false, true])('parses the transcript once unless it changes before hydration (changed: %s)', async (changed) => {
      const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-model-read-'));
      const vaultPath = path.join(configDir, 'vault');
      const pathContext = { environment: { CLAUDE_CONFIG_DIR: configDir }, vaultPath };
      const sessionDir = path.join(historyStore.getSDKProjectsPath(pathContext), historyStore.encodeVaultPathForSDK(vaultPath));
      const sessionPath = path.join(sessionDir, 'session-1.jsonl');
      const entry = (value: Record<string, unknown>) => JSON.stringify(value);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(sessionPath, [
        entry({ type: 'user', uuid: 'u1', timestamp: testTime(), message: { content: 'Question' } }),
        entry({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: testTime({ seconds: 1 }),
          message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Answer' }] } }),
      ].join('\n'));
      // Spy on the module object that the streaming history reader calls through.
      const readSpy = vi.spyOn(actualModule0, 'createReadStream');
      const service = new ClaudeConversationHistoryService();
      const conversation = createConversation();

      try {
        // The repository hands each call its own copy of the conversation.
        await expect(service.recoverConversationModelSelection(structuredClone(conversation), vaultPath, pathContext))
          .resolves.toBe('claude-code/claude-opus-4-6');
        if (changed) {
          await fs.appendFile(sessionPath, '\n' + entry({ type: 'user', uuid: 'u2', parentUuid: 'a1',
            timestamp: testTime({ seconds: 2 }), message: { content: 'Follow-up' } }));
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
      vi.useFakeTimers({ now: testDate().getTime() });
      // Observe release without accessing history again, which would hide lazy expiry.
      const deleteSpy = vi.spyOn(Map.prototype, 'delete');
      try {
        await expect(historyStore.loadSDKSessionModel(directory, 'session-1', undefined, sessionPath))
          .resolves.toBe('claude-opus-4-6');
        deleteSpy.mockClear();
        vi.advanceTimersByTime(29_999);
        expect(deleteSpy).not.toHaveBeenCalledWith(sessionPath);
        vi.advanceTimersByTime(1);
        expect(deleteSpy).toHaveBeenCalledWith(sessionPath);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        deleteSpy.mockRestore();
        vi.useRealTimers();
        await fs.rm(directory, { recursive: true, force: true });
      }
    });

it('cancels expiry timers when a pending parse is replaced, evicted, or consumed', async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-read-lifecycle-'));
      const sessionPaths = Array.from({ length: 5 }, (_, index) => path.join(directory, `${index}.jsonl`));
      const entry = JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: testTime(),
        message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Answer' }] } });
      await Promise.all(sessionPaths.map(sessionPath => fs.writeFile(sessionPath, entry)));
      vi.useFakeTimers({ now: testDate().getTime() });
      const read = (sessionPath: string) => historyStore.loadSDKSessionModel(directory, 'session', undefined, sessionPath);
      try {
        await read(sessionPaths[0]);
        vi.advanceTimersByTime(10_000);
        await read(sessionPaths[0]);
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(20_000);
        expect(vi.getTimerCount()).toBe(1);
        for (const sessionPath of sessionPaths.slice(1)) await read(sessionPath);
        expect(vi.getTimerCount()).toBe(4);
        await historyStore.loadSDKSessionMessages(directory, 'session', undefined, sessionPaths[4]);
        expect(vi.getTimerCount()).toBe(3);
        vi.advanceTimersByTime(30_000);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
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
      const actualFs = actualModule1;
      const readdirSpy = vi.spyOn(actualFs, 'readdir');
      const readSpy = vi.spyOn(actualModule2, 'createReadStream');
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

it.each([false, true])('keeps a pending fork at its checkpoint after the source branches (cached: %s)', async cached => {
      const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-fork-checkpoint-'));
      const vaultPath = path.join(configDir, 'vault');
      const pathContext = { environment: { CLAUDE_CONFIG_DIR: configDir } };
      const sessionDir = path.join(historyStore.getSDKProjectsPath(pathContext), historyStore.encodeVaultPathForSDK(vaultPath));
      const sessionPath = path.join(sessionDir, 'source-session.jsonl');
      const serialize = (entries: SDKNativeMessage[], seconds = 0) => entries.map((entry, index) => JSON.stringify({
        ...entry, timestamp: testTime({ seconds: seconds + index }),
      })).join('\n') + '\n';
      await fs.mkdir(sessionDir, { recursive: true });
      try {
        await fs.writeFile(sessionPath, serialize([
          { type: 'user', uuid: 'u1', parentUuid: null, message: { content: 'Original question' } },
          { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: {
            model: 'claude-sonnet-4-6', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Original answer' }],
          } },
          { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { content: 'Forked question' } },
          { type: 'assistant', uuid: 'tool-left', parentUuid: 'u2', message: {
            stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'left', name: 'Read', input: { file_path: 'left.md' } }],
          } },
          { type: 'assistant', uuid: 'tool-right', parentUuid: 'u2', message: {
            stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'right', name: 'Read', input: { file_path: 'right.md' } }],
          } },
          { type: 'user', uuid: 'result-left', parentUuid: 'tool-left', toolUseResult: {}, message: {
            content: [{ type: 'tool_result', tool_use_id: 'left', content: 'Left result' }],
          } },
          { type: 'user', uuid: 'result-right', parentUuid: 'tool-right', toolUseResult: {}, message: {
            content: [{ type: 'tool_result', tool_use_id: 'right', content: 'Right result' }],
          } },
          { type: 'assistant', uuid: 'a2', parentUuid: 'result-right', message: {
            model: 'claude-sonnet-4-6', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Forked answer' }],
          } },
        ]));
        const service = new ClaudeConversationHistoryService();
        const conversation = createConversation({
          sessionId: null,
          providerState: service.buildForkProviderState('source-session', 'a2'),
        });
        const before = await service.hydrateConversationHistory(conversation, vaultPath, pathContext);
        const expected = ['Original question', 'Original answer', 'Forked question', 'Forked answer'];
        expect(before.messages?.map(message => message.content)).toEqual(expected);

        // Rewind the source to a1 and continue it while the fork remains unsent.
        await fs.appendFile(sessionPath, serialize([
          { type: 'user', uuid: 'u3', parentUuid: 'a1', message: { content: 'Unrelated source branch' } },
          { type: 'assistant', uuid: 'a3', parentUuid: 'u3', message: {
            model: 'claude-opus-4-6', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Unrelated answer' }],
          } },
        ], 8));
        const fork = { ...conversation, messages: cached ? before.messages! : [] };
        const after = await service.hydrateConversationHistory(fork, vaultPath, pathContext);
        expect(after.messages?.map(message => message.content)).toEqual(expected);
        expect(after.messages?.at(-1)?.toolCalls).toMatchObject([
          { id: 'left', result: 'Left result', status: 'completed' },
          { id: 'right', result: 'Right result', status: 'completed' },
        ]);
        await expect(service.recoverConversationModelSelection(fork, vaultPath, pathContext))
          .resolves.toBe('claude-code/claude-sonnet-4-6');
      } finally {
        await fs.rm(configDir, { recursive: true, force: true });
      }
    });

vi.mock('node:fs', async () => ({ ...await vi.importActual<typeof import('node:fs')>('node:fs') }));
vi.mock('fs/promises', async () => ({ ...await vi.importActual<typeof import('fs/promises')>('fs/promises') }));

const writeSession = useClaudeSessionFiles();

it.each([
  ['recovers the last model across transcript segments at the resume checkpoint', 'assistant-checkpoint', false, 'claude-code/claude-opus-4-6'],
  ['does not recover an older model when the current segment is unresolved', 'missing-checkpoint', false, null],
  ['does not recover an older model when the final preserved segment is unresolved', undefined, true, null],
] as const)('%s', async (_name, checkpoint, retired, expected) => {
  const vaultPath = path.resolve('/vault');
  const project = `projects/${historyStore.encodeVaultPathForSDK(vaultPath)}`;
  const previousPath = writeSession([
    { type: 'user', uuid: 'previous-user', timestamp: testTime(), message: { content: 'Earlier question' } },
    { type: 'assistant', uuid: 'previous-answer', parentUuid: 'previous-user', timestamp: testTime({ seconds: 1 }),
      message: { model: 'claude-sonnet-4-5', content: 'Earlier answer' } },
  ], `${project}/session-previous.jsonl`);
  writeSession([
    { type: 'user', uuid: 'current-user', timestamp: testTime({ seconds: 2 }), message: { content: 'Current question' } },
    ...retired ? [] : [
      { type: 'assistant', uuid: 'assistant-checkpoint', parentUuid: 'current-user', timestamp: testTime({ seconds: 3 }),
        message: { model: 'claude-opus-4-6', content: 'Checkpoint answer' } },
      { type: 'user', uuid: 'later-user', parentUuid: 'assistant-checkpoint', timestamp: testTime({ seconds: 4 }), message: { content: 'Later question' } },
      { type: 'assistant', uuid: 'later-answer', parentUuid: 'later-user', timestamp: testTime({ seconds: 5 }),
        message: { model: 'claude-haiku-4-5', content: 'Later answer' } },
    ],
  ], `${project}/session-current.jsonl`);
  const pathContext = { environment: { CLAUDE_CONFIG_DIR: path.dirname(path.dirname(path.dirname(previousPath))) } };
  const conversation = createConversation({
    sessionId: retired ? null : 'session-current',
    resumeAtMessageId: checkpoint,
    providerState: retired
      ? { previousProviderSessionIds: ['session-previous', 'session-current'] }
      : { previousProviderSessionIds: ['session-previous'], providerSessionId: 'session-current' },
  });
  await expect(new ClaudeConversationHistoryService().recoverConversationModelSelection(conversation, vaultPath, pathContext))
    .resolves.toBe(expected);
});
