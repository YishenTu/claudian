import { nativeDefaults } from '@test/helpers/deepseek/NativeDefaults';
import { NativePeer, rootFollow } from '@test/helpers/deepseek/NativePeer';
import { createForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';
import { testDate } from '@test/helpers/testClock';

import { DeepSeekExecutionBackend } from '@/providers/deepseek/execution/DeepSeekExecutionBackend';

import { traceSideChild } from './SideChatNativeTracer';

it('runs the side child on an ephemeral native fork of the checkpoint that ends with its Host process', async () => {
  const env = await createForkTestEnvironment();
  const model = 'deepseek:native/model';
  (env.host.settings as any).providerConfigs.deepseek = { enabled: true, visibleModels: [model], discoveredModels: [{ encodedId: model, provider: 'native', id: 'model', label: 'Model' }] };
  const time = testDate().getTime();
  const peer = new NativePeer();
  // Each native session keeps its own durable cursor and the user texts its model context holds.
  const cursors = new Map<string, number>();
  const contexts = new Map<string, string[]>();
  const prompts: Array<{ sessionId: string; context: string[]; text: string }> = [];
  const permissions = new Map<string, string>();
  const announce = (sessionId: string): void => {
    peer.send('$events', { type: 'emit', event: 'api-session/added', args: [{ sessionId, agentAvailable: true, running: false }] });
  };
  const emit = (sessionId: string, type: string, data: unknown): void => {
    const seq = cursors.get(sessionId)! + 1;
    cursors.set(sessionId, seq);
    peer.send('session/follow', { type: 'event', event: { type, seq, time, data } }, rootFollow(sessionId));
  };
  const native = nativeDefaults({
    seq: () => 0, roster: () => [...cursors.keys()],
    permission: sessionId => permissions.get(sessionId) ?? 'workspace-write', setPermission: (sessionId, value) => { permissions.set(sessionId, value); },
  });
  peer.onCall = (method, args) => {
    if (method === 'session/create') {
      cursors.set('source', 3); contexts.set('source', []); announce('source');
      return { sessionId: 'source', agentPreset: args.request.agentPreset };
    }
    if (method === 'session/fork') {
      const { sessionId, atSeq } = args.request;
      cursors.set('side', atSeq); contexts.set('side', [...contexts.get(sessionId)!]); announce('side');
      return { sessionId: 'side' };
    }
    if (method === 'session/modelCatalog') return { groups: [{ id: 'native', models: [{ id: 'model' }] }] };
    if (method === 'session/selectModel') return { selected: { provider: 'native', model: 'model' } };
    if (method === 'session/projections') {
      const sessionId = args.request.sessionId as string;
      if (!cursors.has(sessionId)) throw Object.assign(new Error('missing'), { code: 'session/missing' });
      return { asOfSeq: cursors.get(sessionId), values: { agentPreset: 'claudian', permissions: { currentValue: permissions.get(sessionId) ?? 'workspace-write' } } };
    }
    if (method === 'session/prompt') {
      const { sessionId, requestId, content } = args.request;
      const text = content[0].text as string;
      prompts.push({ sessionId, context: [...contexts.get(sessionId)!], text });
      contexts.get(sessionId)!.push(text);
      setTimeout(() => {
        emit(sessionId, 'turn/start', { turn: 1 });
        emit(sessionId, 'user/message', { id: `user-${requestId}`, content: [{ type: 'text', text }], source: { kind: 'user', rpcId: requestId } });
        emit(sessionId, 'assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: `${sessionId} reply` }] } });
        emit(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
      });
      return { accepted: true };
    }
    return native.call(method, args);
  };
  peer.onOpen = (endpoint, args, send) => {
    if (endpoint === 'session/follow') { send({ type: 'snapshot', cursor: cursors.get(args.request.address.sessionId) ?? 0, records: [] }); return; }
    native.open(endpoint, args, send);
  };
  await peer.open();
  const { deepseek, lifecycle } = peer.host();
  let child: Awaited<ReturnType<typeof traceSideChild>> = null;
  try {
    const backend = new DeepSeekExecutionBackend(env.host, () => deepseek);
    const source = await env.open(backend);
    const checkpoint = await env.send(source, 'Remember A');
    const checkpointSeq = cursors.get('source')!;
    child = await traceSideChild(env, source, checkpoint, backend, { model });
    expect(child).not.toBeNull();
    const side = await child!.send('Also remember B');
    expect(side).toMatchObject({ terminal: 'turn_completed', text: 'side reply' });
    expect(prompts.at(-1)).toEqual({ sessionId: 'side', context: ['Remember A'], text: 'Also remember B' });
    // The bundled plugin keeps exactly this fork in Host memory; the side child never names its parent's session.
    expect(lifecycle.ephemeralForks).toEqual([{ parent: 'source', atSeq: checkpointSeq, forksAtOffer: 0, forksAtWithdraw: 1 }]);
    expect(child!.providerSessionId()).toBe('side');
    expect(env.repository.list().map(conversation => conversation.id)).toEqual([source.conversation.id]);
    await env.send(source, 'Continue main');
    expect(prompts.at(-1)).toEqual({ sessionId: 'source', context: ['Remember A'], text: 'Continue main' });

    // The fork existed only in the lost process: the side child ends rather than resuming or re-forking.
    lifecycle.exit();
    await until(() => lifecycle.disposed === 1);
    const ended = await child!.send('Still there?');
    expect(ended).toMatchObject({ terminal: 'execution_error', errorMessage: expect.stringMatching(/temporary DeepSeek session ended when DeepSeek restarted/) });
    expect(peer.calls.filter(call => call.method === 'session/fork')).toHaveLength(1);
    expect(prompts.filter(prompt => prompt.sessionId === 'side')).toHaveLength(1);
  } finally {
    await child?.dispose();
    await env.dispose();
    await deepseek.dispose();
    await peer.close();
  }
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Side chat fixture timed out.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
