import type * as fsType from 'fs';
import type * as osType from 'os';
import type * as pathType from 'path';

const fs = jest.requireActual<typeof fsType>('fs');
const os = jest.requireActual<typeof osType>('os');
const path = jest.requireActual<typeof pathType>('path');

import { testDate } from '@test/helpers/testClock';

import { encodeRecoveryPrompt } from '@/core/prompt/recoveryPrompt';
import type { ChatMessage, Conversation } from '@/core/types';
import { codexSettingsReconciler } from '@/providers/codex/env/CodexSettingsReconciler';
import { CodexConversationHistoryService } from '@/providers/codex/history/CodexConversationHistoryService';
import * as CodexHistoryStore from '@/providers/codex/history/CodexHistoryStore';
import { getCodexState } from '@/providers/codex/types';

describe('CodexConversationHistoryService', () => {
  let homeDirSpy: jest.SpyInstance<string, []>;
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-codex-home-'));
    homeDirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
  });

  afterEach(() => {
    homeDirSpy.mockRestore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it.each(['file://vault/path', 'file:///vault/100%notes'])(
    'preserves replay around a failed command with unsupported directory URL %s', async workdir => {
      const sessions = path.join(tempHome, '.codex', 'sessions');
      fs.mkdirSync(sessions, { recursive: true });
      const sessionFilePath = path.join(sessions, 'rollout-thread.jsonl');
      const records = [
        { type: 'session_meta', payload: { id: 'thread' } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the vault' }] } },
        { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'bad-directory', arguments: JSON.stringify({ cmd: 'pwd', workdir }) } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'bad-directory', output: 'Error: Cannot run command: working directory does not exist' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The requested directory was unavailable.' }] } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
      ];
      fs.writeFileSync(sessionFilePath, records.map((record, seconds) => JSON.stringify({
        timestamp: testDate({ seconds }).toISOString(), ...record,
      })).join('\n'));

      const conversation: Conversation = {
        id: 'conversation', sessionId: 'thread', messages: [],
        providerId: 'codex', title: 'Imported conversation',
        createdAt: testDate().getTime(), lastActivityAt: testDate({ seconds: 6 }).getTime(),
        providerState: { threadId: 'thread', sessionFilePath, transcriptRootPath: sessions },
      };
      const result = await new CodexConversationHistoryService().hydrateConversationHistory(conversation, null);

      expect(result.messages?.map(message => message.content)).toEqual(expect.arrayContaining([
        'Inspect the vault', 'The requested directory was unavailable.',
      ]));
      expect(result.messages?.flatMap(message => message.toolCalls ?? [])).toContainEqual(expect.objectContaining({
        id: 'bad-directory', name: 'Bash', result: 'Error: Cannot run command: working directory does not exist',
      }));
    },
  );

  it.each(['normal', 'pending fork', 'established fork'].flatMap(mode =>
    ['raw first', 'raw later', 'native only'].map(events => ({ mode, events })),
  ))('hydrates separate child runs from $mode history with $events events', async ({ mode, events }) => {
    const root = path.join(tempHome, '.codex', 'sessions');
    fs.mkdirSync(root, { recursive: true });
    const record = (type: string, payload: Record<string, unknown>, seconds: number) => JSON.stringify({ type, payload, timestamp: testDate({ seconds }).toISOString() });
    const parentPath = path.join(root, 'rollout-parent.jsonl');
    const followup = record('response_item', { type: 'function_call', call_id: 'followup', name: 'followup_task', namespace: 'collaboration', arguments: '{"target":"helper","message":"Run date"}' }, 6);
    fs.writeFileSync(parentPath, [
      record('event_msg', { type: 'task_started', turn_id: 'parent-turn' }, 0),
      record('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'spawn', kind: 'started', agent_thread_id: 'child', agent_path: '/root/helper' } }, 1),
      record('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'running-message', kind: 'interacted', agent_thread_id: 'child', agent_path: '/root/helper' } }, 2),
      record('event_msg', { type: 'task_complete', turn_id: 'parent-turn' }, 2),
      record('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'done', kind: 'completed', agent_thread_id: 'child', agent_path: '/root/helper' } }, 5),
      record('event_msg', { type: 'task_started', turn_id: 'earlier-idle-turn' }, 5.1),
      record('event_msg', { type: 'item_completed', turn_id: 'earlier-idle-turn', item: { type: 'SubAgentActivity', id: 'earlier-idle-message', kind: 'interacted', agent_thread_id: 'child', agent_path: '/root/helper' } }, 5.2),
      record('event_msg', { type: 'task_complete', turn_id: 'earlier-idle-turn' }, 5.3),
      record('event_msg', { type: 'task_started', turn_id: 'later-parent-turn' }, 6),
      ...(events === 'raw first' ? [followup] : []),
      record('event_msg', { type: 'item_completed', turn_id: 'later-parent-turn', item: { type: 'SubAgentActivity', id: 'followup', kind: 'interacted', agent_thread_id: 'child', agent_path: '/root/helper' } }, 6),
      ...(events === 'raw later' ? [followup] : []),
      record('event_msg', { type: 'item_completed', turn_id: 'later-parent-turn', item: { type: 'SubAgentActivity', id: 'same-turn-message', kind: 'interacted', agent_thread_id: 'child', agent_path: '/root/helper' } }, 7),
      record('event_msg', { type: 'task_complete', turn_id: 'later-parent-turn' }, 7),
      record('event_msg', { type: 'task_started', turn_id: 'steering-parent-turn' }, 8),
      record('event_msg', { type: 'item_completed', turn_id: 'steering-parent-turn', item: { type: 'SubAgentActivity', id: 'followup-running-message', kind: 'interacted', agent_thread_id: 'child', agent_path: '/root/helper' } }, 8),
      record('event_msg', { type: 'item_completed', turn_id: 'later-parent-turn', item: { type: 'SubAgentActivity', id: 'done-2', kind: 'completed', agent_thread_id: 'child', agent_path: '/root/helper' } }, 9),
      record('event_msg', { type: 'task_complete', turn_id: 'steering-parent-turn' }, 10),
      record('event_msg', { type: 'task_started', turn_id: 'idle-parent-turn' }, 11),
      ...(events === 'native only' ? [] : [record('response_item', { type: 'function_call', call_id: 'idle-message', name: 'send_message', arguments: '{"target":"helper","message":"Thanks"}' }, 12)]),
      record('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'idle-message', kind: 'interacted', agent_thread_id: 'child', agent_path: '/root/helper' } }, 12),
      record('event_msg', { type: 'task_complete', turn_id: 'idle-parent-turn' }, 13),
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'rollout-child.jsonl'), [
      record('session_meta', { id: 'child', source: { subagent: { thread_spawn: { agent_nickname: 'Bohr', parent_thread_id: 'parent' } } } }, 1),
      record('session_meta', { id: 'parent', source: 'vscode' }, 0),
      record('response_item', { type: 'function_call', call_id: 'inherited-tool', name: 'parent_only', arguments: '{}' }, 0),
      record('turn_context', { model: 'child-model', effort: 'high' }, 2),
      record('event_msg', { type: 'task_started', turn_id: 'child-turn' }, 2),
      record('response_item', { type: 'custom_tool_call', call_id: 'clock-call', name: 'exec', input: 'const t = await tools.clock__curr_time({}); text(t.current_time);' }, 3),
      record('response_item', { type: 'custom_tool_call_output', call_id: 'clock-call', output: [{ type: 'input_text', text: 'Clock result' }] }, 3),
      record('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Ready.' }] }, 3),
      record('event_msg', { type: 'task_complete', turn_id: 'child-turn' }, 4),
      record('event_msg', { type: 'task_started', turn_id: 'later-child-turn' }, 7),
      record('response_item', { type: 'custom_tool_call', call_id: 'date-call', name: 'exec', input: 'text(await tools.exec_command({cmd: "date"}));' }, 7),
      record('response_item', { type: 'custom_tool_call_output', call_id: 'date-call', output: 'Date result' }, 8),
      record('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Future answer.' }] }, 8),
    ].join('\n'));
    const forkPath = path.join(root, 'rollout-fork.jsonl');
    fs.writeFileSync(forkPath, '');
    const source = { forkSource: { sessionId: 'parent', resumeAt: 'parent-turn' }, forkSourceSessionFilePath: parentPath, forkSourceTranscriptRootPath: root };
    const providerState = mode === 'normal' ? { threadId: 'parent', sessionFilePath: parentPath, transcriptRootPath: root }
      : mode === 'pending fork' ? source : { ...source, threadId: 'fork', sessionFilePath: forkPath, transcriptRootPath: root };
    const openStream = jest.spyOn(fs, 'createReadStream');
    try {
      const result = await new CodexConversationHistoryService().hydrateConversationHistory({
        id: 'conversation', sessionId: mode === 'pending fork' ? null : mode === 'normal' ? 'parent' : 'fork', providerState, messages: [],
      } as any, null);
      expect(openStream.mock.calls.filter(([file]) => file === parentPath)).toHaveLength(1);
      const cards = result.messages!.flatMap(message => message.toolCalls ?? []).filter(tool => tool.subagent);
      expect(cards).toHaveLength(mode === 'normal' ? 2 : 1);
      const owner = result.messages!.find(message => message.toolCalls?.some(tool => tool.id === 'followup'));
      expect(owner?.timestamp).toBe(mode === 'normal' ? testDate({ seconds: 6 }).getTime() : undefined);
      const tools = result.messages!.flatMap(message => message.toolCalls ?? []);
      expect(tools.filter(tool => tool.id === 'idle-message')).toHaveLength(mode === 'normal' ? 1 : 0);
      expect(tools.find(tool => tool.id === 'idle-message')?.subagent).toBeUndefined();
      expect(tools.find(tool => tool.id === 'earlier-idle-message')?.subagent).toBeUndefined();
      expect(tools.find(tool => tool.id === 'same-turn-message')?.subagent).toBeUndefined();
      expect(tools.find(tool => tool.id === 'running-message')?.subagent).toBeUndefined();
      expect(tools.find(tool => tool.id === 'followup-running-message')?.subagent).toBeUndefined();
      const laterCards = mode === 'normal' ? [{ id: 'followup', status: 'completed', startedAt: testDate({ seconds: 6 }).getTime(), completedAt: testDate({ seconds: 9 }).getTime(), prompt: events === 'native only' ? '' : 'Run date', result: 'Future answer.', toolCalls: [{ id: 'date-call' }] }] : [];
      expect(cards.slice(1).map(tool => tool.subagent)).toMatchObject(laterCards);
      expect(cards[0].subagent).toMatchObject({
        status: 'completed', completedAt: testDate({ seconds: 5 }).getTime(), result: 'Ready.', description: 'Bohr (child-model, high)',
        toolCalls: [expect.objectContaining({ id: 'clock-call', status: 'completed', result: expect.stringContaining('Clock result') })],
      });
    } finally { openStream.mockRestore(); }
  });

  it('hydrates history by resolving the transcript path from thread id', async () => {
    const threadId = 'thread-123';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Summarize this file.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Here is the summary.' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-1',
      providerId: 'codex',
      title: 'Codex Transcript',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sessionId: threadId,
      providerState: { threadId },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    conversation.messages = [{ id: 'local', role: 'assistant', content: 'Local placeholder', timestamp: testDate().getTime() }];
    const before = structuredClone(conversation);
    const first = await service.hydrateConversationHistory(conversation, null);
    expect(conversation).toEqual(before);
    expect(await service.hydrateConversationHistory(conversation, null)).toEqual(first);
    Object.assign(conversation, first);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: 'Summarize this file.',
    });
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Here is the summary.',
    });
    expect((conversation.providerState as Record<string, unknown>).sessionFilePath).toBe(transcriptPath);
  });

  it('recovers the last Codex model from turn context without catalog validation', async () => {
    const transcriptPath = path.join(tempHome, 'historical-model.jsonl');
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      ].join('\n'),
      'utf8',
    );
    const conversation: Conversation = {
      id: 'historical-model',
      providerId: 'codex',
      title: 'Historical model',
      createdAt: 1,
      lastActivityAt: 2,
      sessionId: 'thread-1',
      providerState: { sessionFilePath: transcriptPath, threadId: 'thread-1' },
      messages: [],
    };

    await expect(new CodexConversationHistoryService()
      .recoverConversationModelSelection(conversation, null))
      .resolves.toBe('openai-codex/gpt-5.5');
  });

  it('stops model recovery at a checkpoint without reading the remaining transcript', async () => {
    const transcriptPath = path.join(tempHome, 'large-model.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', turn_id: 'checkpoint' } })
      + '\n' + (JSON.stringify({ type: 'irrelevant', payload: 'x'.repeat(1024) }) + '\n').repeat(2048));
    const streams: fsType.ReadStream[] = [];
    const create = fs.createReadStream;
    const spy = jest.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
      const stream = create(...args); streams.push(stream); return stream;
    });
    try {
      const result = await new CodexConversationHistoryService().recoverConversationModelSelection({
        sessionId: 'thread', resumeAtMessageId: 'checkpoint', providerState: { sessionFilePath: transcriptPath, threadId: 'thread' }, messages: [],
      }, null);
      expect(result).toBe('openai-codex/gpt-5.5');
      expect(streams).toHaveLength(1);
      expect(streams[0].bytesRead).toBeLessThan(256 * 1024);
      expect(streams[0].destroyed).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('does not recover a Codex model past a missing rewind checkpoint', async () => {
    const transcriptPath = path.join(tempHome, 'stale-checkpoint-model.jsonl');
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: 'turn_context',
          payload: { model: 'gpt-5.4-mini', turn_id: 'turn-1' },
        }),
        JSON.stringify({
          type: 'turn_context',
          payload: { model: 'gpt-5.5', turn_id: 'turn-2' },
        }),
      ].join('\n'),
      'utf8',
    );
    const conversation: Conversation = {
      id: 'stale-checkpoint-model',
      providerId: 'codex',
      title: 'Stale checkpoint model',
      createdAt: 1,
      lastActivityAt: 2,
      sessionId: 'thread-stale-checkpoint',
      resumeAtMessageId: 'missing-turn',
      providerState: {
        sessionFilePath: transcriptPath,
        threadId: 'thread-stale-checkpoint',
      },
      messages: [],
    };

    await expect(new CodexConversationHistoryService()
      .recoverConversationModelSelection(conversation, null))
      .resolves.toBeNull();
  });

  it('does not recover an established fork model past a missing source checkpoint', async () => {
    const sourcePath = path.join(tempHome, 'fork-source-model.jsonl');
    const forkPath = path.join(tempHome, 'established-fork-model.jsonl');
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        type: 'turn_context',
        payload: { model: 'gpt-5.4-mini', turn_id: 'source-turn-1' },
      }),
      'utf8',
    );
    fs.writeFileSync(
      forkPath,
      JSON.stringify({
        type: 'turn_context',
        payload: { model: 'gpt-5.5', turn_id: 'fork-turn-1' },
      }),
      'utf8',
    );
    const conversation: Conversation = {
      id: 'established-fork-stale-source-checkpoint',
      providerId: 'codex',
      title: 'Established fork stale source checkpoint',
      createdAt: 1,
      lastActivityAt: 2,
      sessionId: 'fork-thread',
      providerState: {
        threadId: 'fork-thread',
        sessionFilePath: forkPath,
        forkSource: {
          sessionId: 'source-thread',
          resumeAt: 'missing-source-turn',
        },
        forkSourceSessionFilePath: sourcePath,
      },
      messages: [],
    };

    await expect(new CodexConversationHistoryService()
      .recoverConversationModelSelection(conversation, null))
      .resolves.toBeNull();
  });

  it('recovers a model after Codex moves the transcript into archived_sessions', async () => {
    const threadId = 'thread-archived-model';
    const codexDir = path.join(tempHome, '.codex');
    const sessionsDir = path.join(codexDir, 'sessions');
    const archivedDir = path.join(codexDir, 'archived_sessions');
    const stalePath = path.join(sessionsDir, `rollout-stale-${threadId}.jsonl`);
    const archivedPath = path.join(
      archivedDir,
      `rollout-2026-08-05T00-00-00-${threadId}.jsonl`,
    );
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(
      archivedPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      'utf8',
    );
    const conversation: Conversation = {
      id: 'archived-model',
      providerId: 'codex',
      title: 'Archived model',
      createdAt: 1,
      lastActivityAt: 2,
      sessionId: threadId,
      providerState: {
        sessionFilePath: stalePath,
        threadId,
        transcriptRootPath: sessionsDir,
      },
      messages: [],
    };

    await expect(new CodexConversationHistoryService()
      .recoverConversationModelSelection(conversation, null))
      .resolves.toBe('openai-codex/gpt-5.5');
  });

  it('recovers an archived model from legacy metadata containing only a thread id', async () => {
    const threadId = 'thread-archived-legacy-model';
    const archivedDir = path.join(tempHome, '.codex', 'archived_sessions');
    const archivedPath = path.join(
      archivedDir,
      `rollout-2026-08-05T00-00-00-${threadId}.jsonl`,
    );
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(
      archivedPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      'utf8',
    );
    const conversation: Conversation = {
      id: 'archived-legacy-model',
      providerId: 'codex',
      title: 'Archived legacy model',
      createdAt: 1,
      lastActivityAt: 2,
      sessionId: threadId,
      providerState: { threadId },
      messages: [],
    };

    await expect(new CodexConversationHistoryService()
      .recoverConversationModelSelection(conversation, null))
      .resolves.toBe('openai-codex/gpt-5.5');
  });

  it('marks native context established after recovering a non-empty owned transcript', async () => {
    const threadId = 'thread-crash-recovery';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Committed before crash.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Native response.' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );
    const conversation: Conversation = {
      id: 'conv-crash-recovery',
      providerId: 'codex',
      title: 'Crash recovery',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sessionId: threadId,
      providerState: {
        threadId,
        sessionFilePath: transcriptPath,
        nativeConversationContextEstablished: false,
        futureProviderState: { token: 'preserve' },
      },
      messages: [],
    };

    Object.assign(conversation, await new CodexConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
    ));

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.providerState).toEqual(expect.objectContaining({
      nativeConversationContextEstablished: true,
      futureProviderState: { token: 'preserve' },
    }));
  });

  it('rehydrates the same conversation object after its messages are cleared', async () => {
    const threadId = 'thread-456';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'First prompt' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'First answer' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-2',
      providerId: 'codex',
      title: 'Reloaded Codex Transcript',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sessionId: threadId,
      providerState: { threadId, sessionFilePath: transcriptPath },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    Object.assign(conversation, await service.hydrateConversationHistory(conversation, null));
    expect(conversation.messages).toHaveLength(2);

    conversation.messages = [];
    Object.assign(conversation, await service.hydrateConversationHistory(conversation, null));

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'First answer',
    });
  });

  it('hydrates by searching transcriptRootPath when sessionFilePath is missing', async () => {
    const threadId = 'thread-rooted';
    const sessionsDir = path.join(tempHome, 'custom-codex-root', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Recovered from transcript root.' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-rooted',
      providerId: 'codex',
      title: 'Transcript Root',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sessionId: threadId,
      providerState: {
        threadId,
        transcriptRootPath: path.join(tempHome, 'custom-codex-root', 'sessions'),
      },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    Object.assign(conversation, await service.hydrateConversationHistory(conversation, null));

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Recovered from transcript root.',
    });
    expect((conversation.providerState as Record<string, unknown>).sessionFilePath).toBe(transcriptPath);
  });

  it('backfills transcriptRootPath from sessionFilePath when only the session path is known', async () => {
    const threadId = 'thread-backfill-root';
    const sessionsDir = path.join(tempHome, 'custom-codex-root', 'sessions', '2026', '03', '28');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-28T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-28T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Recovered from session path.' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-backfill-root',
      providerId: 'codex',
      title: 'Backfill Transcript Root',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sessionId: threadId,
      providerState: {
        threadId,
        sessionFilePath: transcriptPath,
      },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    Object.assign(conversation, await service.hydrateConversationHistory(conversation, null));

    expect(conversation.messages).toHaveLength(1);
    expect((conversation.providerState as Record<string, unknown>).transcriptRootPath).toBe(
      path.join(tempHome, 'custom-codex-root', 'sessions'),
    );
  });

  it('does not open an out-of-root metadata path and re-resolves by thread id', async () => {
    const threadId = 'thread-untrusted-path';
    const trustedDir = path.join(tempHome, '.codex', 'sessions', '2026', '07', '11');
    const outsideDir = path.join(tempHome, 'synced-other-device');
    fs.mkdirSync(trustedDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const trustedPath = path.join(trustedDir, `rollout-${threadId}.jsonl`);
    const outsidePath = path.join(outsideDir, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(trustedPath, JSON.stringify({
      timestamp: '2026-07-11T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Trusted transcript.' }],
      },
    }));
    fs.writeFileSync(outsidePath, JSON.stringify({
      timestamp: '2026-07-11T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Untrusted transcript.' }],
      },
    }));
    const conversation: Conversation = {
      id: 'conv-untrusted-path',
      providerId: 'codex',
      title: 'Synced metadata path',
      createdAt: 1,
      lastActivityAt: 1,
      sessionId: threadId,
      providerState: { threadId, sessionFilePath: outsidePath },
      messages: [],
    };

    Object.assign(conversation, await new CodexConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: tempHome } },
    ));

    expect(conversation.messages.map(message => message.content)).toEqual(['Trusted transcript.']);
    expect((conversation.providerState as Record<string, unknown>).sessionFilePath).toBe(trustedPath);
  });

  it('accepts a metadata path under the explicitly configured Codex home', async () => {
    const configuredHome = path.join(tempHome, 'configured-codex-home');
    const transcriptPath = path.join(configuredHome, 'sessions', 'session.jsonl');
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, JSON.stringify({
      timestamp: '2026-07-11T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Configured transcript.' }],
      },
    }));
    const conversation: Conversation = {
      id: 'conv-configured-path',
      providerId: 'codex',
      title: 'Configured path',
      createdAt: 1,
      lastActivityAt: 1,
      sessionId: 'configured-thread',
      providerState: { threadId: 'configured-thread', sessionFilePath: transcriptPath },
      messages: [],
    };

    Object.assign(conversation, await new CodexConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { CODEX_HOME: configuredHome, HOME: tempHome } },
    ));

    expect(conversation.messages.map(message => message.content)).toEqual(['Configured transcript.']);
  });

  describe('buildForkProviderState', () => {
    let transcriptPath: string;
    let transcript: string;

    beforeEach(() => {
      const sessionsDir = path.join(tempHome, '.codex', 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      transcriptPath = path.join(sessionsDir, 'rollout-source-thread-id.jsonl');
      transcript = [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-2' } },
        { type: 'response_item', payload: {
          type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }],
        } },
        { type: 'response_item', payload: {
          type: 'message', role: 'assistant', id: 'msg_item',
          content: [{ type: 'output_text', text: 'Hi' }],
        } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-2' } },
      ].map(record => JSON.stringify(record)).join('\n');
      fs.writeFileSync(transcriptPath, transcript);
    });

    it('validates the native checkpoint and preserves source context for hydration', async () => {
      const service = new CodexConversationHistoryService();
      const state = await service.buildForkProviderState('source-thread-id', 'turn-uuid-2', {
        sessionFilePath: transcriptPath, workspaceDependencyToolVersion: 1,
      });
      expect(state).toMatchObject({ workspaceDependencyToolVersion: 1 });
      const fork: Conversation = {
        id: 'fork', providerId: 'codex', title: 'Fork', createdAt: 1, lastActivityAt: 1,
        sessionId: null, messages: [], providerState: state,
      };
      Object.assign(fork, await service.hydrateConversationHistory(fork, null));
      expect(fork.messages.map(message => message.content)).toEqual(['Hello', 'Hi']);
      expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(transcript);
    });

    it.each(['msg_item', 'missing-turn'])('rejects unavailable checkpoint %s during fork creation', async checkpoint => {
      const service = new CodexConversationHistoryService();
      await expect(service.buildForkProviderState(
        'source-thread-id', checkpoint, { sessionFilePath: transcriptPath },
      )).rejects.toThrow('Fork checkpoint not found');
    });

    it('rejects an unavailable source during fork creation', async () => {
      fs.unlinkSync(transcriptPath);
      const service = new CodexConversationHistoryService();
      await expect(service.buildForkProviderState(
        'source-thread-id', 'turn-uuid-2', { sessionFilePath: transcriptPath },
      )).rejects.toThrow('Fork checkpoint not found');
    });

    it('surfaces a source read failure instead of a missing checkpoint', async () => {
      // A directory opens like a file but fails to read, standing in for oversized or unreadable transcripts.
      fs.unlinkSync(transcriptPath);
      fs.mkdirSync(transcriptPath);
      const service = new CodexConversationHistoryService();
      await expect(service.buildForkProviderState(
        'source-thread-id', 'turn-uuid-2', { sessionFilePath: transcriptPath },
      )).rejects.toMatchObject({ code: 'EISDIR' });
    });

    it('finds an archived source when its saved path has moved', async () => {
      const archive = path.join(tempHome, '.codex', 'archived_sessions');
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(transcriptPath, path.join(archive, path.basename(transcriptPath)));
      const service = new CodexConversationHistoryService();
      const state = await service.buildForkProviderState(
        'source-thread-id', 'turn-uuid-2', { sessionFilePath: transcriptPath },
      );
      const fork: Conversation = {
        id: 'fork', providerId: 'codex', title: 'Fork', createdAt: 1, lastActivityAt: 1,
        sessionId: null, messages: [], providerState: state,
      };
      Object.assign(fork, await service.hydrateConversationHistory(fork, null));
      expect(fork.messages.map(message => message.content)).toEqual(['Hello', 'Hi']);
    });
  });

  describe('isPendingForkConversation', () => {
    it('returns true when forkSource exists, no threadId, no sessionId', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-fork',
        providerId: 'codex',
        title: 'Pending Fork',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: 'source', resumeAt: 'turn-1' } },
        messages: [],
      };

      expect(service.isPendingForkConversation(conversation)).toBe(true);
    });

    it('returns false when threadId exists (established fork)', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-fork-est',
        providerId: 'codex',
        title: 'Established Fork',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: {
          threadId: 'fork-thread-1',
          forkSource: { sessionId: 'source', resumeAt: 'turn-1' },
        },
        messages: [],
      };

      expect(service.isPendingForkConversation(conversation)).toBe(false);
    });

    it('returns false when no forkSource', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-normal',
        providerId: 'codex',
        title: 'Normal',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: 'thread-1',
        providerState: { threadId: 'thread-1' },
        messages: [],
      };

      expect(service.isPendingForkConversation(conversation)).toBe(false);
    });
  });

  describe('resolveSessionIdForConversation', () => {
    it('falls back to forkSource.sessionId', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-fork-resolve',
        providerId: 'codex',
        title: 'Fork Resolve',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: 'source-thread', resumeAt: 'turn-1' } },
        messages: [],
      };

      expect(service.resolveSessionIdForConversation(conversation)).toBe('source-thread');
    });

    it('prefers threadId over forkSource.sessionId', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-fork-pref',
        providerId: 'codex',
        title: 'Fork Pref',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: {
          threadId: 'my-thread',
          forkSource: { sessionId: 'source-thread', resumeAt: 'turn-1' },
        },
        messages: [],
      };

      expect(service.resolveSessionIdForConversation(conversation)).toBe('my-thread');
    });
  });

  describe('resolveMissingConversationSession', () => {
    it('resets only the exact stale live thread identity and preserves replay evidence', async () => {
      const conversation: Conversation = {
        id: 'conv-missing-thread',
        providerId: 'codex',
        title: 'Missing thread',
        createdAt: 1,
        lastActivityAt: 1,
        sessionId: 'thread-missing',
        resumeAtMessageId: 'fork-checkpoint',
        providerState: {
          threadId: 'thread-missing',
          nativeConversationContextEstablished: true,
          pendingForkTarget: {
            threadId: 'thread-missing',
            sessionFilePath: '/codex/sessions/thread-missing.jsonl',
          },
          sessionFilePath: '/codex/sessions/thread-missing.jsonl',
          transcriptRootPath: '/codex/sessions',
          forkSource: {
            sessionId: 'thread-source',
            resumeAt: 'fork-checkpoint',
          },
          forkSourceSessionFilePath: '/codex/sessions/thread-source.jsonl',
          forkSourceTranscriptRootPath: '/codex/sessions',
          workspaceDependencyToolVersion: 1,
          futureProviderState: { token: 'keep-me' },
        },
        messages: [],
      };

      const update1 = await new CodexConversationHistoryService().resolveMissingConversationSession(
        conversation,
        null,
        'thread-missing',
      );
      expect(update1.outcome).toBe('reset');
      Object.assign(conversation, update1.changes);

      expect(conversation.sessionId).toBeNull();
      expect(conversation.resumeAtMessageId).toBe('fork-checkpoint');
      expect(conversation.providerState).toEqual({
        nativeConversationContextEstablished: false,
        previousSegments: [{
          threadId: 'thread-missing',
          sessionFilePath: '/codex/sessions/thread-missing.jsonl',
          transcriptRootPath: '/codex/sessions',
          forkSource: {
            sessionId: 'thread-source',
            resumeAt: 'fork-checkpoint',
          },
          forkSourceSessionFilePath: '/codex/sessions/thread-source.jsonl',
          forkSourceTranscriptRootPath: '/codex/sessions',
        }],
        futureProviderState: { token: 'keep-me' },
      });
    });

    it.each([
      ['another reported thread', 'thread-newer'],
      ['no reported thread', undefined],
    ])('preserves current state for %s', async (_case, missingSessionId) => {
      const providerState = {
        threadId: 'thread-current',
        nativeConversationContextEstablished: true,
        sessionFilePath: '/codex/sessions/thread-current.jsonl',
        futureProviderState: { token: 'keep-me' },
      };
      const conversation: Conversation = {
        id: 'conv-current-thread',
        providerId: 'codex',
        title: 'Current thread',
        createdAt: 1,
        lastActivityAt: 1,
        sessionId: 'thread-current',
        providerState,
        messages: [],
      };

      const update2 = await new CodexConversationHistoryService().resolveMissingConversationSession(
        conversation,
        null,
        missingSessionId,
      );
      expect(update2.outcome).toBe('preserve');
      Object.assign(conversation, update2.changes);

      expect(conversation.sessionId).toBe('thread-current');
      expect(conversation.providerState).toBe(providerState);
    });
  });

  describe('runtime-input invalidation', () => {
    type Turn = [turnId: string, question: string, answer: string];
    let sessionsDir: string;

    function writeRollout(threadId: string, turns: Turn[], firstPrompt?: string): string {
      const filePath = path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${threadId}.jsonl`);
      let seconds = 0;
      const record = (type: string, payload: Record<string, unknown>) => JSON.stringify({
        timestamp: testDate({ seconds: seconds++ }).toISOString(), type, payload,
      });
      fs.writeFileSync(filePath, [
        record('session_meta', { id: threadId }),
        ...turns.flatMap(([turnId, question, answer], index) => [
          record('event_msg', { type: 'task_started', turn_id: turnId }),
          record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: index === 0 && firstPrompt ? firstPrompt : question }] }),
          record('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }),
          record('event_msg', { type: 'task_complete', turn_id: turnId }),
        ]),
      ].join('\n'));
      return filePath;
    }

    function codexConversation(sessionId: string | null, providerState: Record<string, unknown>): Conversation {
      return {
        id: 'conv-invalidated', providerId: 'codex', title: 'Invalidated',
        createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
        sessionId, providerState, messages: [],
      };
    }

    async function hydrate(conversation: Conversation): Promise<ChatMessage[]> {
      const update = await new CodexConversationHistoryService()
        .hydrateConversationHistory({ ...conversation, messages: [] }, null);
      return update.messages ?? [];
    }

    const visible = (messages: ChatMessage[]) => messages.map(message => [message.role, message.content]);

    beforeEach(() => {
      sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });
    });

    it.each(['normal', 'pending fork', 'established fork'])(
      'keeps %s history readable but not resumable after invalidation', async mode => {
        const sourcePath = writeRollout('source', [['s1', 'SrcQ1', 'SrcA1'], ['s2', 'SrcQ2', 'SrcA2'], ['s3', 'SrcQ3', 'SrcA3']]);
        const forkPath = writeRollout('fork', [['s1', 'SrcQ1', 'SrcA1'], ['s2', 'SrcQ2', 'SrcA2'], ['f1', 'ForkQ1', 'ForkA1']]);
        const forkState = { forkSource: { sessionId: 'source', resumeAt: 's2' }, forkSourceSessionFilePath: sourcePath };
        const conversation = mode === 'normal'
          ? codexConversation('source', { threadId: 'source', sessionFilePath: sourcePath, nativeConversationContextEstablished: true, sessionToolVersion: 3 })
          : mode === 'pending fork'
            ? codexConversation(null, forkState)
            : codexConversation('fork', { ...forkState, threadId: 'fork', sessionFilePath: forkPath, workspaceDependencyToolVersion: 1 });
        const service = new CodexConversationHistoryService();
        const before = visible(await hydrate(conversation));
        expect(before.length).toBeGreaterThan(0);

        expect(codexSettingsReconciler.invalidateConversationSessions([conversation])).toEqual([conversation]);

        expect(conversation.sessionId).toBeNull();
        expect(conversation.providerState).toMatchObject({ nativeConversationContextEstablished: false });
        for (const key of ['threadId', 'sessionFilePath', 'forkSource', 'pendingForkTarget', 'sessionToolVersion', 'workspaceDependencyToolVersion']) {
          expect(conversation.providerState).not.toHaveProperty(key);
        }
        expect(service.resolveSessionIdForConversation(conversation)).toBeNull();
        expect(service.isPendingForkConversation(conversation)).toBe(false);
        expect(service.hasConversationModelRecoverySource(conversation)).toBe(false);
        expect(await service.recoverConversationModelSelection(conversation, null)).toBeNull();
        expect(codexSettingsReconciler.invalidateConversationSessions([conversation])).toEqual([]);

        const persisted = codexConversation(null, service.buildPersistedProviderState(conversation)!);
        expect(visible(await hydrate(persisted))).toEqual(before);
      },
    );

    it('keeps a fork source prefix readable after resetting a missing fork child', async () => {
      const sourcePath = writeRollout('source', [['s1', 'SrcQ1', 'SrcA1'], ['s2', 'SrcQ2', 'SrcA2'], ['s3', 'SrcQ3', 'SrcA3']]);
      const conversation = codexConversation('fork', {
        forkSource: { sessionId: 'source', resumeAt: 's2' },
        forkSourceSessionFilePath: sourcePath,
        threadId: 'fork',
        sessionFilePath: path.join(sessionsDir, 'rollout-2026-03-27T00-00-00-fork.jsonl'),
      });
      const sourcePrefix = [['user', 'SrcQ1'], ['assistant', 'SrcA1'], ['user', 'SrcQ2'], ['assistant', 'SrcA2']];
      expect(visible(await hydrate(conversation))).toEqual(sourcePrefix);

      const reset = await new CodexConversationHistoryService()
        .resolveMissingConversationSession({ ...conversation, messages: [] }, null, 'fork');
      expect(reset.outcome).toBe('reset');
      Object.assign(conversation, reset.changes);

      expect(visible(await hydrate(conversation))).toEqual(sourcePrefix);
    });

    it('hydrates earlier segments before a replacement thread that replayed them', async () => {
      const firstPath = writeRollout('thread-first', [['t1', 'FirstQ', 'FirstA']]);
      const conversation = codexConversation('thread-first', {
        threadId: 'thread-first', sessionFilePath: firstPath, nativeConversationContextEstablished: true,
      });
      codexSettingsReconciler.invalidateConversationSessions([conversation]);

      const replay = encodeRecoveryPrompt('User: FirstQ\n\nAssistant: FirstA', 'SecondQ');
      const secondPath = writeRollout('thread-second', [['t2', 'SecondQ', 'SecondA']], replay);
      // The replacement thread's execution snapshot overlays its binding on the stored state.
      conversation.sessionId = 'thread-second';
      conversation.providerState = {
        ...conversation.providerState,
        threadId: 'thread-second', sessionFilePath: secondPath, nativeConversationContextEstablished: true,
      };
      const expected = [['user', 'FirstQ'], ['assistant', 'FirstA'], ['user', 'SecondQ'], ['assistant', 'SecondA']];
      const messages = await hydrate(conversation);
      expect(visible(messages)).toEqual(expected);
      expect(new Set(messages.map(message => message.id)).size).toBe(messages.length);

      // A second invalidation keeps both segments in order.
      codexSettingsReconciler.invalidateConversationSessions([conversation]);
      expect(getCodexState(conversation.providerState).previousSegments).toHaveLength(2);
      expect(visible(await hydrate(conversation))).toEqual(expected);
    });

    it('reads an invalidated segment whose rollout was archived after its path was saved', async () => {
      const activePath = writeRollout('thread-archived', [['a1', 'ArchivedQ', 'ArchivedA']]);
      const archivedDir = path.join(tempHome, '.codex', 'archived_sessions');
      fs.mkdirSync(archivedDir, { recursive: true });
      fs.renameSync(activePath, path.join(archivedDir, path.basename(activePath)));
      const conversation = codexConversation('thread-archived', {
        threadId: 'thread-archived', sessionFilePath: activePath,
        transcriptRootPath: path.join(tempHome, '.codex', 'sessions'),
      });
      codexSettingsReconciler.invalidateConversationSessions([conversation]);

      expect(visible(await hydrate(conversation))).toEqual([['user', 'ArchivedQ'], ['assistant', 'ArchivedA']]);
    });

    it('offers fork and rewind checkpoints only on the live thread', async () => {
      const oldPath = writeRollout('thread-earlier', [['old-turn', 'OldQ', 'OldA']]);
      const conversation = codexConversation('thread-earlier', { threadId: 'thread-earlier', sessionFilePath: oldPath });
      codexSettingsReconciler.invalidateConversationSessions([conversation]);
      const livePath = writeRollout('thread-live', [['live-turn', 'LiveQ', 'LiveA']]);
      conversation.providerState = { ...conversation.providerState, threadId: 'thread-live', sessionFilePath: livePath };

      const messages = await hydrate(conversation);

      expect(messages.map(message => [message.content, message.userMessageId, message.assistantMessageId])).toEqual([
        ['OldQ', undefined, undefined],
        ['OldA', undefined, undefined],
        ['LiveQ', 'live-turn', undefined],
        ['LiveA', undefined, 'live-turn'],
      ]);
    });

    it('resolves the live thread before spending lookup time on earlier segments', async () => {
      const findSessionFile = CodexHistoryStore.findCodexSessionFileAsync;
      const conversation = codexConversation('thread-lost', { threadId: 'thread-lost' });
      codexSettingsReconciler.invalidateConversationSessions([conversation]);
      writeRollout('thread-found', [['found-turn', 'FoundQ', 'FoundA']]);
      // Located by thread id alone, so the live thread needs lookup time too.
      conversation.providerState = { ...conversation.providerState, threadId: 'thread-found' };
      const realNow = Date.now.bind(Date);
      let elapsed = 0;
      const now = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + elapsed);
      const lookup = jest.spyOn(CodexHistoryStore, 'findCodexSessionFileAsync')
        .mockImplementation(async (threadId, root, timeoutMs) => {
          if (threadId !== 'thread-lost') return findSessionFile(threadId, root, timeoutMs);
          // An unavailable earlier segment exhausts whatever budget its search is given.
          elapsed += timeoutMs ?? 0;
          return null;
        });
      try {
        expect(visible(await hydrate(conversation))).toEqual([['user', 'FoundQ'], ['assistant', 'FoundA']]);
      } finally {
        lookup.mockRestore();
        now.mockRestore();
      }
    });

    it('does not render an earlier segment that is still the live thread', async () => {
      const threadPath = writeRollout('thread-restored', [['r1', 'RestoredQ', 'RestoredA']]);
      const conversation = codexConversation('thread-restored', { threadId: 'thread-restored', sessionFilePath: threadPath });
      codexSettingsReconciler.invalidateConversationSessions([conversation]);
      // Any path that rebinds the invalidated thread must not show its turns twice.
      conversation.sessionId = 'thread-restored';
      conversation.providerState = { ...conversation.providerState, threadId: 'thread-restored', sessionFilePath: threadPath };

      expect(visible(await hydrate(conversation))).toEqual([['user', 'RestoredQ'], ['assistant', 'RestoredA']]);
    });

    it('forks the live thread without dropping or reviving earlier segments', async () => {
      const firstPath = writeRollout('thread-old', [['old-1', 'OldQ', 'OldA']]);
      const conversation = codexConversation('thread-old', { threadId: 'thread-old', sessionFilePath: firstPath });
      codexSettingsReconciler.invalidateConversationSessions([conversation]);
      const currentPath = writeRollout('thread-new', [['new-1', 'NewQ1', 'NewA1'], ['new-2', 'NewQ2', 'NewA2']]);
      const sourceState = { ...conversation.providerState, threadId: 'thread-new', sessionFilePath: currentPath };
      const service = new CodexConversationHistoryService();

      await expect(service.buildForkProviderState('thread-new', 'old-1', sourceState))
        .rejects.toThrow('Fork checkpoint not found');
      const forkState = await service.buildForkProviderState('thread-new', 'new-1', sourceState);
      expect(forkState).toMatchObject({
        forkSource: { sessionId: 'thread-new', resumeAt: 'new-1' },
        previousSegments: getCodexState(conversation.providerState).previousSegments,
      });
      const fork = codexConversation(null, forkState);
      expect(service.resolveSessionIdForConversation(fork)).toBe('thread-new');
      expect(visible(await hydrate(fork))).toEqual([
        ['user', 'OldQ'], ['assistant', 'OldA'], ['user', 'NewQ1'], ['assistant', 'NewA1'],
      ]);
    });
  });

  describe('pending-fork hydration', () => {
    it('hydrates from source transcript truncated at resumeAt', async () => {
      const sourceThreadId = 'source-thread-pf';
      const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const transcriptPath = path.join(
        sessionsDir,
        `rollout-2026-03-27T00-00-00-${sourceThreadId}.jsonl`,
      );

      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:06.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-3' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:06.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 3' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:07.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 3' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:08.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-3' } }),
        ].join('\n'),
        'utf-8',
      );

      const conversation: Conversation = {
        id: 'conv-pf',
        providerId: 'codex',
        title: 'Pending Fork',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: sourceThreadId, resumeAt: 'turn-uuid-2' } },
        messages: [],
      };

      const service = new CodexConversationHistoryService();
      Object.assign(conversation, await service.hydrateConversationHistory(conversation, null));

      // Should only have messages from turn 1 and turn 2 (truncated at resumeAt)
      expect(conversation.messages).toHaveLength(4);
      expect(conversation.messages[0].content).toBe('Turn 1');
      expect(conversation.messages[1].content).toBe('Reply 1');
      expect(conversation.messages[2].content).toBe('Turn 2');
      expect(conversation.messages[3].content).toBe('Reply 2');
    });

    it('does not widen pending-fork history when resumeAt is missing', async () => {
      const sourceThreadId = 'source-thread-pf-missing';
      const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${sourceThreadId}.jsonl`),
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-2' } }),
        ].join('\n'),
        'utf-8',
      );

      const conversation: Conversation = {
        id: 'conv-pf-missing',
        providerId: 'codex',
        title: 'Pending Fork Missing Checkpoint',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: sourceThreadId, resumeAt: 'turn-uuid-missing' } },
        messages: [],
      };

      const service = new CodexConversationHistoryService();
      Object.assign(conversation, await service.hydrateConversationHistory(conversation, null));

      expect(conversation.messages).toEqual([]);
    });

    it('keeps in-memory messages on pending fork', async () => {
      const conversation: Conversation = {
        id: 'conv-pf-mem',
        providerId: 'codex',
        title: 'Pending Fork In Memory',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: 'nonexistent', resumeAt: 'turn-1' } },
        messages: [
          { id: 'msg-1', role: 'user', content: 'Cloned message', timestamp: Date.now() },
        ],
      };

      const service = new CodexConversationHistoryService();
      Object.assign(conversation, await service.hydrateConversationHistory(conversation, null));

      expect(conversation.messages).toHaveLength(1);
      expect(conversation.messages[0].content).toBe('Cloned message');
    });
  });

  describe('established-fork hydration', () => {
    it('hydrates as source prefix through resumeAt plus fork-only turns', async () => {
      const sourceThreadId = 'source-thread-ef';
      const forkThreadId = 'fork-thread-ef';
      const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });

      // Source transcript: 3 turns
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${sourceThreadId}.jsonl`),
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:06.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-3' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:06.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ3' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:07.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA3' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:08.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-3' } }),
        ].join('\n'),
        'utf-8',
      );

      // Fork transcript: copied turns 1-3 + new fork turn
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${forkThreadId}.jsonl`),
        [
          // Copied source turns (have same turn IDs)
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-2' } }),
          // New fork-only turn
          JSON.stringify({ timestamp: '2026-03-27T01:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'fork-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ForkQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ForkA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fork-turn-1' } }),
        ].join('\n'),
        'utf-8',
      );

      const conversation: Conversation = {
        id: 'conv-ef',
        providerId: 'codex',
        title: 'Established Fork',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: {
          threadId: forkThreadId,
          sessionFilePath: path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${forkThreadId}.jsonl`),
          forkSource: { sessionId: sourceThreadId, resumeAt: 'src-turn-2' },
        },
        messages: [],
      };

      const service = new CodexConversationHistoryService();
      const parse = jest.spyOn(JSON, 'parse');
      let sourceRecordReads: number;
      try {
        Object.assign(conversation, await service.hydrateConversationHistory(conversation, null));
        sourceRecordReads = parse.mock.calls.filter(([line]) => typeof line === 'string' && line.includes('SrcQ3')).length;
      } finally { parse.mockRestore(); }
      expect(sourceRecordReads).toBe(1);

      // Expected: source prefix (turns 1+2) + fork-only turn
      // = SrcQ1, SrcA1, SrcQ2, SrcA2, ForkQ1, ForkA1
      expect(conversation.messages).toHaveLength(6);
      expect(conversation.messages[0].content).toBe('SrcQ1');
      expect(conversation.messages[1].content).toBe('SrcA1');
      expect(conversation.messages[2].content).toBe('SrcQ2');
      expect(conversation.messages[3].content).toBe('SrcA2');
      expect(conversation.messages[4].content).toBe('ForkQ1');
      expect(conversation.messages[5].content).toBe('ForkA1');
    });

    it('does not widen established-fork history when resumeAt is missing', async () => {
      const sourceThreadId = 'source-thread-ef-missing';
      const forkThreadId = 'fork-thread-ef-missing';
      const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${sourceThreadId}.jsonl`),
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-2' } }),
        ].join('\n'),
        'utf-8',
      );

      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${forkThreadId}.jsonl`),
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'fork-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ForkQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ForkA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fork-turn-1' } }),
        ].join('\n'),
        'utf-8',
      );

      const conversation: Conversation = {
        id: 'conv-ef-missing',
        providerId: 'codex',
        title: 'Established Fork Missing Checkpoint',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: {
          threadId: forkThreadId,
          sessionFilePath: path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${forkThreadId}.jsonl`),
          forkSource: { sessionId: sourceThreadId, resumeAt: 'src-turn-missing' },
        },
        messages: [],
      };

      const service = new CodexConversationHistoryService();
      Object.assign(conversation, await service.hydrateConversationHistory(conversation, null));

      expect(conversation.messages).toEqual([]);
    });
  });

  it.each(['normal', 'pending fork', 'established fork'])(
    'rejects %s hydration when a transcript exists but cannot be read', async mode => {
      const sessions = path.join(tempHome, '.codex', 'sessions');
      // A directory opens like a file but fails to read, standing in for oversized or unreadable transcripts.
      const unreadable = path.join(sessions, 'rollout-unreadable.jsonl');
      fs.mkdirSync(unreadable, { recursive: true });
      const readable = path.join(sessions, 'rollout-fork.jsonl');
      fs.writeFileSync(readable, [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] } },
      ].map((record, seconds) => JSON.stringify({ timestamp: testDate({ seconds }).toISOString(), ...record })).join('\n'));
      const forkSource = { sessionId: 'source', resumeAt: 'turn' };
      const providerState = mode === 'normal'
        ? { threadId: 'thread', sessionFilePath: unreadable }
        : mode === 'pending fork'
          ? { forkSource, forkSourceSessionFilePath: unreadable }
          : { threadId: 'fork', sessionFilePath: readable, forkSource, forkSourceSessionFilePath: unreadable };
      const conversation: Conversation = {
        id: 'unreadable', providerId: 'codex', title: 'Unreadable',
        createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
        sessionId: mode === 'pending fork' ? null : providerState.threadId ?? null,
        providerState, messages: [],
      };

      await expect(new CodexConversationHistoryService().hydrateConversationHistory(conversation, null))
        .rejects.toMatchObject({ code: 'EISDIR' });
    },
  );

  it('retries hydration after an empty transcript parse', async () => {
    const threadId = 'thread-789';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(transcriptPath, '', 'utf-8');

    const conversation: Conversation = {
      id: 'conv-3',
      providerId: 'codex',
      title: 'Eventually Written Transcript',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sessionId: threadId,
      providerState: { threadId, sessionFilePath: transcriptPath },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    Object.assign(conversation, await service.hydrateConversationHistory(conversation, null));
    expect(conversation.messages).toEqual([]);

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Second prompt' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Second answer' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    Object.assign(conversation, await service.hydrateConversationHistory(conversation, null));

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: 'Second prompt',
    });
  });
});


test('missing-session recovery returns an update without mutating its input', async () => {
  const conversation = {
    id: 'immutable-history', providerId: 'codex' as const, title: 'History',
    createdAt: testDate().getTime(), lastActivityAt: testDate({ seconds: 1 }).getTime(), sessionId: 'missing-thread',
    providerState: { threadId: 'missing-thread' }, messages: [],
  };
  const before = structuredClone(conversation);
  const result = await new CodexConversationHistoryService()
    .resolveMissingConversationSession(conversation, null, 'missing-thread');
  expect(conversation).toEqual(before);
  expect(result).toMatchObject({ outcome: 'reset', changes: { sessionId: null } });
});
