import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

jest.mock('cross-spawn', () => jest.fn());
import { createForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';
import { createNativeRPCProcess, createNativeVersionProcess } from '@test/helpers/providers/NativeRPCTestProcess';
import spawn from 'cross-spawn';

import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';

import { traceSideChild } from './SideChatNativeTracer';

it('forks native disk history and resumes the side child independently after cooling', async () => {
  const env = await createForkTestEnvironment();
  const database = path.join(env.root, 'opencode.db');
  new DatabaseSync(database).close();
  const sessions = new Map<string, string[]>();
  const prompts: Array<{ sessionId: string; context: string[]; text: string }> = [];
  let sessionOrdinal = 0;
  let turnId = 0;
  jest.mocked(spawn).mockImplementation((_command, args, options) => {
    if (args?.includes('--version')) return createNativeVersionProcess('1.18.31');
    // Disk sessions are shared between native processes; memory sessions are not.
    const localSessions = options?.env?.OPENCODE_DB === ':memory:' ? new Map<string, string[]>() : sessions;
    return createNativeRPCProcess((method, params, notify) => {
      if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } } };
      if (method === 'session/new' || method === 'session/fork') {
        const source = method === 'session/fork' ? localSessions.get(params.sessionId) : [];
        if (!source) throw new Error('Source session not found in this database');
        const sessionId = `ses-${++sessionOrdinal}`;
        localSessions.set(sessionId, [...source]);
        return { sessionId };
      }
      if (method === 'session/load') {
        if (!localSessions.has(params.sessionId)) throw new Error('Session not found in this database');
        return {};
      }
      if (method === 'session/set_config_option') return {};
      if (method === 'session/prompt') {
        const messages = localSessions.get(params.sessionId)!;
        const id = ++turnId;
        prompts.push({ sessionId: params.sessionId, context: [...messages], text: params.prompt[0].text });
        messages.push(params.prompt[0].text, `Reply ${id}`);
        notify('session/update', { sessionId: params.sessionId, update: {
          sessionUpdate: 'agent_message_chunk', messageId: `msg-${id}`, content: { type: 'text', text: `Reply ${id}` },
        } });
        return { stopReason: 'end_turn' };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
  });
  env.host.settings.providerConfigs.opencode = {
    enabled: true, visibleModels: ['test/model'], discoveredModels: [{ rawId: 'test/model', label: 'Test' }], environmentVariables: `OPENCODE_DB=${database}`,
  };
  let child: Awaited<ReturnType<typeof traceSideChild>> = null;
  try {
    const backend = new OpencodeExecutionBackend(env.host, { serverService: new OpencodeServerService() });
    const source = await env.open(backend);
    const checkpoint = await env.send(source, 'Remember A');
    child = await traceSideChild(env, source, checkpoint, backend);
    expect(child).not.toBeNull();
    expect((await child!.send('Also remember B')).terminal).toBe('turn_completed');
    expect(prompts.at(-1)).toEqual({ sessionId: 'ses-2', context: ['Remember A', 'Reply 1'], text: 'Also remember B' });
    expect((await child!.send('Use A and B')).terminal).toBe('turn_completed');
    expect(prompts.at(-1)).toEqual({
      sessionId: 'ses-2', context: ['Remember A', 'Reply 1', 'Also remember B', 'Reply 2'], text: 'Use A and B',
    });
    expect(child!.session.canCool()).toBe(true);
    await child!.session.cool();
    expect((await child!.send('Continue the side')).terminal).toBe('turn_completed');
    expect(prompts.at(-1)).toEqual({
      sessionId: 'ses-2', context: ['Remember A', 'Reply 1', 'Also remember B', 'Reply 2', 'Use A and B', 'Reply 3'], text: 'Continue the side',
    });
    expect(sessions.get('ses-1')).toEqual(['Remember A', 'Reply 1']);
    expect(env.repository.list().map(conversation => conversation.id)).toEqual([source.conversation.id]);
    await child!.dispose();
    expect(sessions.has('ses-2')).toBe(true);
    await env.send(source, 'Continue main');
    expect(prompts.at(-1)).toEqual({ sessionId: 'ses-1', context: ['Remember A', 'Reply 1'], text: 'Continue main' });
  } finally {
    await child?.dispose();
    await env.dispose();
    jest.mocked(spawn).mockReset();
  }
});
