import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';

import { createForkTestEnvironment } from './ProviderForkTestHarness';

it('refuses an OpenCode fork without creating another conversation or starting native execution', async () => {
  const env = await createForkTestEnvironment();
  try {
    const backend = new OpencodeExecutionBackend(env.host, {
      createKernel: () => { throw new Error('Unsupported fork started native execution'); },
    });
    const source = await env.open(backend);
    const assistant = { id: 'reply', role: 'assistant' as const, content: 'Existing reply', timestamp: 2, assistantMessageId: 'native-reply' };
    await env.repository.update(source.conversation.id, {
      sessionId: 'opencode-source',
      messages: [
        { id: 'question', role: 'user', content: 'Existing question', timestamp: 1 },
        assistant,
      ],
    });
    expect(await env.fork(source, assistant)).toBeUndefined();
    expect(env.repository.list().map(conversation => conversation.id)).toEqual([source.conversation.id]);
    expect(source.conversation.messages).toHaveLength(2);
  } finally {
    await env.dispose();
  }
});
