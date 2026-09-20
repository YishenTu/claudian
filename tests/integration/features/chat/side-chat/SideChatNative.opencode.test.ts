import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';

import { createForkTestEnvironment } from '../tabs/ProviderForkTestHarness';
import { captureSideSource, collectNotices } from './SideChatNativeTracer';

it('refuses an OpenCode side chat through the capability path without starting native execution', async () => {
  const env = await createForkTestEnvironment();
  const notices = collectNotices();
  try {
    const backend = new OpencodeExecutionBackend(env.host, {
      createKernel: () => { throw new Error('Unsupported side chat started native execution'); },
    });
    const source = await env.open(backend);
    const assistant = {
      assistantMessageId: 'native-reply', content: 'Existing reply',
      id: 'reply', role: 'assistant' as const, timestamp: 2,
    };
    await env.repository.update(source.conversation.id, {
      messages: [
        { content: 'Existing question', id: 'question', role: 'user', timestamp: 1 },
        assistant,
      ],
      sessionId: 'opencode-source',
    });

    expect(ProviderRegistry.getCapabilities('opencode').supportsFork).toBe(false);
    expect(await captureSideSource(env, source, assistant)).toBeNull();
    expect(notices.messages.some(message => /not supported/i.test(message))).toBe(true);
    expect(env.repository.list().map(conversation => conversation.id)).toEqual([source.conversation.id]);
  } finally {
    await env.dispose();
  }
});
