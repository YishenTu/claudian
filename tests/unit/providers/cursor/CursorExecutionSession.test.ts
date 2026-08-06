import { CursorExecutionSession } from '@/providers/cursor/execution/CursorExecutionSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('CursorExecutionSession', () => {
  it('configures the ACP model and mode before streaming a turn', async () => {
    const prompt = deferred<{
      userMessageId: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    }>();
    let kernelOptions: any;
    const kernel = {
      cancel: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      dispose: jest.fn().mockResolvedValue(undefined),
      openSession: jest.fn().mockResolvedValue({ sessionId: 'cursor-session' }),
      prompt: jest.fn().mockReturnValue(prompt.promise),
      setConfigOption: jest.fn().mockResolvedValue(undefined),
      setMode: jest.fn().mockResolvedValue(undefined),
      setModel: jest.fn().mockResolvedValue(undefined),
    };
    const session = new CursorExecutionSession({ settings: {} } as never, {
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

    const run = session.execute({
      configuration: {
        model: 'cursor:claude-4-sonnet',
        permissionMode: 'plan',
        systemInstructions: { kind: 'provider-default' },
      },
      input: [{ text: 'Plan this change', type: 'text' }],
      signal: new AbortController().signal,
      toolPolicy: { kind: 'provider-default' },
    } as never);
    const events: unknown[] = [];
    const collecting = (async () => {
      for await (const event of run.events) events.push(event);
    })();
    await flush();

    expect(kernel.setModel).toHaveBeenCalledWith({
      modelId: 'claude-4-sonnet',
      sessionId: 'cursor-session',
    });
    expect(kernel.setMode).toHaveBeenCalledWith({
      modeId: 'plan',
      sessionId: 'cursor-session',
    });
    await kernelOptions.onNotification({
      sessionId: 'cursor-session',
      update: {
        content: { text: 'Proposed plan', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      },
    });
    prompt.resolve({
      usage: {
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
      },
      userMessageId: 'user-message',
    });
    await collecting;

    expect(events).toContainEqual(expect.objectContaining({
      text: 'Proposed plan',
      type: 'text_delta',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'usage_updated',
      usage: expect.objectContaining({
        contextTokens: 200,
        inputTokens: 120,
        percentage: 0,
      }),
    }));
    expect(session.getSnapshot()).toMatchObject({
      providerId: 'cursor',
      providerSessionId: 'cursor-session',
      status: 'idle',
    });
  });
});
