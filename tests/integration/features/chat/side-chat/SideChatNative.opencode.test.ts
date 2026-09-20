import * as path from 'node:path';

jest.mock('cross-spawn', () => jest.fn());
import spawn from 'cross-spawn';

import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';

import { createNativeRpcProcess } from '../tabs/NativeRpcTestProcess';
import { createForkTestEnvironment } from '../tabs/ProviderForkTestHarness';
import { capturedImage, traceSideChild } from './SideChatNativeTracer';

it('seeds an in-memory side session once and continues it without changing main history', async () => {
  const env = await createForkTestEnvironment();
  const diskMessages: string[] = [];
  const prompts: Array<{ database: string; sessionId: string; context: string[]; blocks: unknown[] }> = [];
  let processId = 0;
  let turnId = 0;
  // Native 1.18.31 cannot fork a disk session from an in-memory ACP process.
  jest.mocked(spawn).mockImplementation((_command, _args, options) => {
    const database = options?.env?.OPENCODE_DB ?? 'default';
    const messages = database === ':memory:' ? [] : diskMessages;
    const sessionId = `ses-${++processId}`;
    return createNativeRpcProcess((method, params, notify) => {
      if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } } };
      if (method === 'session/new') return { sessionId };
      if (method === 'session/load') {
        if (params.sessionId !== sessionId) throw new Error('Session not found in this database');
        return {};
      }
      if (method === 'session/fork') {
        diskMessages.push('Persistent fork created');
        throw new Error('Side chat must not create a persistent native fork');
      }
      if (method === 'session/set_config_option') return {};
      if (method === 'session/prompt') {
        const id = ++turnId;
        prompts.push({ database, sessionId, context: [...messages], blocks: params.prompt });
        messages.push(params.prompt[0].text, `Reply ${id}`);
        notify('session/update', { sessionId, update: {
          sessionUpdate: 'agent_message_chunk', messageId: `msg-${id}`, content: { type: 'text', text: `Reply ${id}` },
        } });
        return { stopReason: 'end_turn' };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
  });
  env.host.settings.providerConfigs.opencode = {
    enabled: true, visibleModels: ['test/model'],
    environmentVariables: `OPENCODE_DB=${path.join(env.root, 'opencode.db')}`,
  };
  let child: Awaited<ReturnType<typeof traceSideChild>> = null;
  try {
    const backend = new OpencodeExecutionBackend(env.host);
    const source = await env.open(backend);
    const checkpoint = await env.send(source, 'Remember A');
    checkpoint.content = 'Reply 1';
    source.conversation.messages[0].images = [capturedImage];
    source.conversation.messages[0].executionInput = {
      schemaVersion: 1, canonicalText: 'Remember A with expanded instructions',
      context: { browserSelection: { source: 'browser', selectedText: 'Captured passage 48271' } },
    };
    checkpoint.toolCalls = [{
      id: 'read-capture', name: 'Read', input: { path: 'transient.txt' },
      status: 'error', result: 'Captured error ' + 'x'.repeat(6000) + ' final diagnostic',
    }];
    const sourceHistory = [...diskMessages];
    const sourceLedger = await env.repository.getConversationInputLedger(source.conversation.id);
    child = await traceSideChild(env, source, checkpoint, backend);
    expect(child).not.toBeNull();
    expect((await child!.send('Also remember B')).terminal).toBe('turn_completed');
    const first = prompts.at(-1)!;
    expect(first).toMatchObject({ database: ':memory:', context: [] });
    const text = (first.blocks[0] as { text: string }).text;
    expect(text).toContain('expanded instructions');
    expect(text).toContain('Captured passage 48271');
    expect(text).toContain('Reply 1');
    expect(text).toContain('x'.repeat(6000) + ' final diagnostic');
    expect(first.blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: capturedImage.data });
    expect(child!.session.canCool()).toBe(false);

    expect((await child!.send('Use A and B')).terminal).toBe('turn_completed');
    expect(prompts.at(-1)).toEqual({
      database: ':memory:', sessionId: first.sessionId,
      context: [text, 'Reply 2'], blocks: [{ type: 'text', text: 'Use A and B' }],
    });
    expect(diskMessages).toEqual(sourceHistory);
    expect(await env.repository.getConversationInputLedger(source.conversation.id)).toEqual(sourceLedger);
    expect(env.repository.list().map(conversation => conversation.id)).toEqual([source.conversation.id]);
    await env.send(source, 'Continue main');
    expect(prompts.at(-1)?.context).toEqual(sourceHistory);
  } finally {
    await child?.dispose();
    await env.dispose();
    jest.mocked(spawn).mockReset();
  }
});
