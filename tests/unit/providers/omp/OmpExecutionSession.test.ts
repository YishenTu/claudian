import { OmpExecutionSession } from '@/providers/omp/execution/OmpExecutionSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('OmpExecutionSession', () => {
  it('routes second-turn ACP notifications to the active run', async () => {
    const firstPrompt = deferred<{ userMessageId: string }>();
    const secondPrompt = deferred<{ userMessageId: string }>();
    let kernelOptions: any;
    const kernel = {
      cancel: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      dispose: jest.fn().mockResolvedValue(undefined),
      openSession: jest.fn().mockResolvedValue({ configOptions: [], sessionId: 'omp-session' }),
      prompt: jest.fn()
        .mockReturnValueOnce(firstPrompt.promise)
        .mockReturnValueOnce(secondPrompt.promise),
      setConfigOption: jest.fn().mockResolvedValue(undefined),
      setModel: jest.fn().mockResolvedValue(undefined),
    };
    const session = new OmpExecutionSession({ settings: {} } as never, {
      interactionPort: {} as never,
      lifecycle: 'persistent',
      nativePersistence: 'provider-default',
      vaultWorkingDirectory: '/vault',
    }, {
      createKernel: options => {
        kernelOptions = options;
        return kernel;
      },
    });
    const request = {
      configuration: { systemInstructions: { kind: 'provider-default' } },
      input: [{ text: 'Hello', type: 'text' }],
      signal: new AbortController().signal,
      toolPolicy: { kind: 'provider-default' },
    } as never;

    const first = session.execute(request);
    const firstEvents: unknown[] = [];
    const collectFirst = (async () => {
      for await (const event of first.events) firstEvents.push(event);
    })();
    await flush();
    await kernelOptions.onNotification({
      sessionId: 'omp-session',
      update: { sessionUpdate: 'usage_update', size: 200_000, used: 30_000 },
    });
    firstPrompt.resolve({ userMessageId: 'first' });
    await collectFirst;
    expect(firstEvents).toContainEqual(expect.objectContaining({
      type: 'usage_updated',
      usage: expect.objectContaining({ percentage: 0 }),
    }));

    const second = session.execute(request);
    const events: unknown[] = [];
    const collecting = (async () => {
      for await (const event of second.events) events.push(event);
    })();
    await flush();
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'usage_updated',
      usage: expect.objectContaining({ percentage: 0 }),
    }));
    await kernelOptions.onNotification({
      sessionId: 'omp-session',
      update: {
        content: { text: 'Second reply', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      },
    });
    await kernelOptions.onNotification({
      sessionId: 'omp-session',
      update: { sessionUpdate: 'usage_update', size: 200_000, used: 42_000 },
    });
    secondPrompt.resolve({ userMessageId: 'second' });
    await collecting;

    expect(events).toContainEqual(expect.objectContaining({
      text: 'Second reply',
      type: 'text_delta',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'usage_updated',
      usage: expect.objectContaining({ contextTokens: 42_000, percentage: 21 }),
    }));
  });
});
