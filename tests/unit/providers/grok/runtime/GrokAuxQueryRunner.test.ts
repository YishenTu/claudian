import type { ProviderHost } from '@/core/providers/ProviderHost';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  AcpSubprocess,
} from '@/providers/acp';
import { GrokAuxiliaryLifecycleCoordinator } from '@/providers/grok/auxiliary/GrokAuxiliaryLifecycleCoordinator';
import { GrokAuxQueryRunner } from '@/providers/grok/runtime/GrokAuxQueryRunner';
import { getHostnameKey } from '@/utils/env';

jest.mock('@/providers/acp', () => {
  const actual = jest.requireActual('@/providers/acp');
  return {
    ...actual,
    AcpClientConnection: jest.fn(),
    AcpJsonRpcTransport: jest.fn(),
    AcpSubprocess: jest.fn(),
  };
});

const MockAcpClientConnection = AcpClientConnection as jest.MockedClass<typeof AcpClientConnection>;
const MockAcpJsonRpcTransport = AcpJsonRpcTransport as jest.MockedClass<typeof AcpJsonRpcTransport>;
const MockAcpSubprocess = AcpSubprocess as jest.MockedClass<typeof AcpSubprocess>;

function makeHost(): ProviderHost {
  return {
    app: {
      vault: {
        adapter: { basePath: '/tmp/grok-aux-vault' },
      },
    },
    getResolvedProviderCliPath: jest.fn(async () => '/opt/grok/bin/grok'),
    manifest: { version: '2.0.39-test' },
    settings: {
      providerConfigs: {
        grok: {
          enabled: true,
          environmentVariables: 'GROK_PROFILE=test',
        },
      },
    },
  } as unknown as ProviderHost;
}

function flushPromises(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe('GrokAuxQueryRunner', () => {
  let connection: {
    cancel: jest.Mock;
    dispose: jest.Mock;
    initialize: jest.Mock;
    loadSession: jest.Mock;
    newSession: jest.Mock;
    onSessionNotification: jest.Mock;
    prompt: jest.Mock;
    setModel: jest.Mock;
  };
  let connectionDelegate: Record<string, any>;
  let rawNotificationHandlers: Map<string, Array<(params: unknown) => void | Promise<void>>>;
  let rawTransportUnregisters: jest.Mock[];
  let processes: Array<{
    getStderrSnapshot: jest.Mock;
    isAlive: jest.Mock;
    onClose: jest.Mock;
    shutdown: jest.Mock;
    start: jest.Mock;
    stdin: Record<string, never>;
    stdout: Record<string, never>;
  }>;
  let transport: {
    dispose: jest.Mock;
    flush: jest.Mock;
    isClosed: boolean;
    onNotification: jest.Mock;
    onRequest: jest.Mock;
    signal: AbortSignal;
    start: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    connectionDelegate = {};
    rawNotificationHandlers = new Map();
    rawTransportUnregisters = [];
    processes = [];

    connection = {
      cancel: jest.fn(),
      dispose: jest.fn(),
      initialize: jest.fn(async () => ({})),
      loadSession: jest.fn(async () => ({})),
      newSession: jest.fn(async () => ({ sessionId: 'aux-session-1' })),
      onSessionNotification: jest.fn(() => jest.fn()),
      prompt: jest.fn(async (request) => {
        await connectionDelegate.onSessionNotification?.({
          sessionId: request.sessionId,
          update: {
            content: { text: 'Refined', type: 'text' },
            messageId: 'assistant-1',
            sessionUpdate: 'agent_message_chunk',
          },
        });
        await connectionDelegate.onSessionNotification?.({
          sessionId: request.sessionId,
          update: {
            content: { text: ' answer', type: 'text' },
            messageId: 'assistant-1',
            sessionUpdate: 'agent_message_chunk',
          },
        });
        return { stopReason: 'end_turn' };
      }),
      setModel: jest.fn(async () => ({})),
    };
    transport = {
      dispose: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
      isClosed: false,
      onNotification: jest.fn((method, handler) => {
        const handlers = rawNotificationHandlers.get(method) ?? [];
        handlers.push(handler);
        rawNotificationHandlers.set(method, handlers);
        const unregister = jest.fn();
        rawTransportUnregisters.push(unregister);
        return unregister;
      }),
      onRequest: jest.fn(() => jest.fn()),
      signal: new AbortController().signal,
      start: jest.fn(),
    };

    MockAcpClientConnection.mockImplementation((options: any) => {
      connectionDelegate = options.delegate ?? {};
      return connection as any;
    });
    MockAcpJsonRpcTransport.mockImplementation(() => transport as any);
    MockAcpSubprocess.mockImplementation(() => {
      const process = {
        getStderrSnapshot: jest.fn(() => ''),
        isAlive: jest.fn(() => true),
        onClose: jest.fn(),
        shutdown: jest.fn(async () => {}),
        start: jest.fn(),
        stdin: {},
        stdout: {},
      };
      processes.push(process);
      return process as any;
    });
  });

  it('aborts lifecycle admission without reading settings, spawning, or leaking registration', async () => {
    const host = makeHost();
    const settings = host.settings;
    const settingsRead = jest.fn(() => settings);
    Object.defineProperty(host, 'settings', { configurable: true, get: settingsRead });
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const transition = await lifecycle.beginEnvironmentChange();
    const runner = new GrokAuxQueryRunner(host, { lifecycle });
    const quiesce = jest.spyOn(runner, 'quiesceForEnvironmentChange');
    const abortController = new AbortController();

    const query = runner.query({ abortController, systemPrompt: 'Blocked prompt' }, 'Blocked');
    await flushPromises();
    abortController.abort();

    await expect(query).rejects.toThrow('Cancelled');
    expect(settingsRead).not.toHaveBeenCalled();
    expect(host.getResolvedProviderCliPath).not.toHaveBeenCalled();
    expect(MockAcpSubprocess).not.toHaveBeenCalled();
    expect(connection.newSession).not.toHaveBeenCalled();
    expect(connection.loadSession).not.toHaveBeenCalled();
    await transition.release();

    const nextTransition = await lifecycle.beginEnvironmentChange();
    expect(quiesce).not.toHaveBeenCalled();
    await nextTransition.release();
  });

  it('fails lazy workspace initialization before settings, process, or session access', async () => {
    const host = makeHost();
    const settings = host.settings;
    const settingsRead = jest.fn(() => settings);
    Object.defineProperty(host, 'settings', { configurable: true, get: settingsRead });
    const resolveLifecycle = jest.fn(async () => {
      throw new Error('Grok workspace initialization failed');
    });
    const runner = new GrokAuxQueryRunner(host, { resolveLifecycle });

    await expect(runner.query({ systemPrompt: 'Cold prompt' }, 'Cold')).rejects.toThrow(
      'Grok workspace initialization failed',
    );
    expect(resolveLifecycle).toHaveBeenCalledTimes(1);
    expect(settingsRead).not.toHaveBeenCalled();
    expect(host.getResolvedProviderCliPath).not.toHaveBeenCalled();
    expect(MockAcpSubprocess).not.toHaveBeenCalled();
    expect(connection.newSession).not.toHaveBeenCalled();
    expect(connection.loadSession).not.toHaveBeenCalled();
  });

  it('moves lifecycle ownership to the current workspace after reinitialization', async () => {
    const firstLifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const secondLifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const resolveLifecycle = jest.fn()
      .mockResolvedValueOnce(firstLifecycle)
      .mockResolvedValue(secondLifecycle);
    const runner = new GrokAuxQueryRunner(makeHost(), { resolveLifecycle });
    const quiesce = jest.spyOn(runner, 'quiesceForEnvironmentChange');

    await runner.query({ systemPrompt: 'First workspace' }, 'First');
    await runner.query({ systemPrompt: 'Second workspace' }, 'Second');

    const oldTransition = await firstLifecycle.beginEnvironmentChange();
    expect(quiesce).not.toHaveBeenCalled();
    await oldTransition.release();
    const currentTransition = await secondLifecycle.beginEnvironmentChange();
    expect(quiesce).toHaveBeenCalledTimes(1);
    await currentTransition.release();
  });

  it('starts an independent no-leader process with Safe metadata and aggregates text', async () => {
    const runner = new GrokAuxQueryRunner(makeHost());
    const onTextChunk = jest.fn();

    await expect(runner.query({
      model: 'grok/kimi-coding',
      onTextChunk,
      systemPrompt: 'Auxiliary prompt override',
    }, 'Refine this')).resolves.toBe('Refined answer');

    expect(MockAcpSubprocess).toHaveBeenCalledWith(expect.objectContaining({
      args: ['agent', '--no-leader', 'stdio'],
      command: '/opt/grok/bin/grok',
      cwd: '/tmp/grok-aux-vault',
      env: expect.objectContaining({ GROK_PROFILE: 'test' }),
    }));
    expect(connection.initialize).toHaveBeenCalledTimes(1);
    expect(connection.newSession).toHaveBeenCalledWith({
      _meta: {
        modelId: 'kimi-coding',
        systemPromptOverride: 'Auxiliary prompt override',
        yoloMode: false,
      },
      cwd: '/tmp/grok-aux-vault',
      mcpServers: [],
    });
    expect(connection.prompt).toHaveBeenCalledWith({
      prompt: [{ text: 'Refine this', type: 'text' }],
      sessionId: 'aux-session-1',
    });
    expect(connection.setModel).toHaveBeenCalledWith({
      modelId: 'kimi-coding',
      sessionId: 'aux-session-1',
    });
    expect(onTextChunk).toHaveBeenNthCalledWith(1, 'Refined');
    expect(onTextChunk).toHaveBeenNthCalledWith(2, 'Refined answer');
  });

  it('uses the native default when no auxiliary model is supplied', async () => {
    const runner = new GrokAuxQueryRunner(makeHost());

    await runner.query({
      model: undefined,
      systemPrompt: 'Use native defaults',
    }, 'Generate a title');

    expect(connection.newSession).toHaveBeenCalledWith({
      _meta: {
        systemPromptOverride: 'Use native defaults',
        yoloMode: false,
      },
      cwd: '/tmp/grok-aux-vault',
      mcpServers: [],
    });
    expect(connection.setModel).not.toHaveBeenCalled();
  });

  it('rejects permission requests without delegating to approval UI', async () => {
    const runner = new GrokAuxQueryRunner(makeHost());
    await runner.query({ systemPrompt: 'Safe prompt' }, 'Use a tool');

    await expect(connectionDelegate.requestPermission({
      options: [
        { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
      ],
      sessionId: 'aux-session-1',
      toolCall: { title: 'terminal', toolCallId: 'tool-1' },
    })).resolves.toEqual({
      outcome: { optionId: 'reject', outcome: 'selected' },
    });
  });

  it('ignores extension-only session updates while continuing to aggregate text', async () => {
    connection.prompt.mockImplementation(async (request) => {
      const rawHandler = rawNotificationHandlers.get('_x.ai/session/update')?.[0];
      await rawHandler?.({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: 'turn_completed',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      });
      await rawHandler?.({
        sessionId: request.sessionId,
        update: { sessionUpdate: 'future_grok_extension' },
      });
      await rawHandler?.({
        sessionId: request.sessionId,
        update: {
          content: { text: 'survived', type: 'text' },
          messageId: 'assistant-1',
          sessionUpdate: 'agent_message_chunk',
        },
      });
      return { stopReason: 'end_turn' };
    });
    const runner = new GrokAuxQueryRunner(makeHost());

    await expect(runner.query({ systemPrompt: 'Safe prompt' }, 'Generate')).resolves.toBe(
      'survived',
    );
  });

  it('routes standard ACP notifications through the generation and session filters', async () => {
    const onTextChunk = jest.fn();
    connection.prompt.mockImplementation(async (request) => {
      const textChunk = {
        sessionId: request.sessionId,
        update: {
          content: { text: 'standard', type: 'text' },
          messageId: 'assistant-standard',
          sessionUpdate: 'agent_message_chunk',
        },
      };
      await connectionDelegate.onSessionNotification?.({
        ...textChunk,
        sessionId: 'other-session',
      });
      await connectionDelegate.onSessionNotification?.({
        sessionId: request.sessionId,
        update: { sessionUpdate: 'turn_completed' },
      });
      await connectionDelegate.onSessionNotification?.({
        sessionId: request.sessionId,
        update: { sessionUpdate: 'future_standard_extension' },
      });
      await connectionDelegate.onSessionNotification?.(null);
      await connectionDelegate.onSessionNotification?.(textChunk);
      return { stopReason: 'end_turn' };
    });
    const runner = new GrokAuxQueryRunner(makeHost());

    await expect(runner.query({ onTextChunk, systemPrompt: 'Safe prompt' }, 'Generate')).resolves.toBe(
      'standard',
    );
    expect(onTextChunk).toHaveBeenCalledTimes(1);
    expect(onTextChunk).toHaveBeenCalledWith('standard');
  });

  it('suppresses only adjacent cross-source mirror pairs', async () => {
    connection.prompt.mockImplementation(async (request) => {
      const standard = connectionDelegate.onSessionNotification;
      const alias = rawNotificationHandlers.get('_x.ai/session/update')?.[0];
      const chunk = (text: string) => ({
        sessionId: request.sessionId,
        update: {
          content: { text, type: 'text' },
          messageId: `assistant-${text}`,
          sessionUpdate: 'agent_message_chunk',
        },
      });

      await standard?.(chunk('[A]'));
      await alias?.(chunk('[A]'));
      await standard?.(chunk('[R]'));
      await standard?.(chunk('[R]'));
      await standard?.(chunk('[X]'));
      await alias?.({
        sessionId: request.sessionId,
        update: { sessionUpdate: 'turn_completed' },
      });
      await alias?.(chunk('[X]'));
      await standard?.(chunk('[Y]'));
      await alias?.(chunk('[Y]'));
      await standard?.(chunk('[Y]'));
      return { stopReason: 'end_turn' };
    });
    const runner = new GrokAuxQueryRunner(makeHost());

    await expect(runner.query({ systemPrompt: 'Safe prompt' }, 'Generate')).resolves.toBe(
      '[A][R][R][X][X][Y][Y]',
    );
  });

  it('continues multiple prompts on the same auxiliary session and process', async () => {
    const runner = new GrokAuxQueryRunner(makeHost());

    await runner.query({ systemPrompt: 'Refine prompt' }, 'Initial request');
    await runner.query({ systemPrompt: 'Refine prompt' }, 'Continuation');

    expect(MockAcpSubprocess).toHaveBeenCalledTimes(1);
    expect(connection.newSession).toHaveBeenCalledTimes(1);
    expect(connection.loadSession).not.toHaveBeenCalled();
    expect(connection.prompt).toHaveBeenNthCalledWith(2, {
      prompt: [{ text: 'Continuation', type: 'text' }],
      sessionId: 'aux-session-1',
    });
  });

  it('does not recycle the process for semantically equivalent environment text', async () => {
    const host = makeHost();
    const settings = host.settings as unknown as {
      providerConfigs: { grok: { environmentVariables: string } };
    };
    settings.providerConfigs.grok.environmentVariables = [
      'XAI_REGION=us',
      'GROK_PROFILE=test',
    ].join('\n');
    const runner = new GrokAuxQueryRunner(host);

    await runner.query({ systemPrompt: 'Refine prompt' }, 'Initial request');
    settings.providerConfigs.grok.environmentVariables = [
      'export GROK_PROFILE = "test"',
      'XAI_REGION = us',
    ].join('\n');
    await runner.query({ systemPrompt: 'Refine prompt' }, 'Continuation');

    expect(MockAcpSubprocess).toHaveBeenCalledTimes(1);
    expect(connection.loadSession).not.toHaveBeenCalled();
  });

  it('changes the model in-session when a continuation selects another Grok model', async () => {
    const runner = new GrokAuxQueryRunner(makeHost());

    await runner.query({
      model: 'grok/model-a',
      systemPrompt: 'Refine prompt',
    }, 'Initial request');
    await runner.query({
      model: 'grok/model-b',
      systemPrompt: 'Refine prompt',
    }, 'Continuation');

    expect(connection.setModel).toHaveBeenCalledTimes(2);
    expect(connection.setModel).toHaveBeenNthCalledWith(2, {
      modelId: 'model-b',
      sessionId: 'aux-session-1',
    });
  });

  it('reloads the same binding without a model id when returning to native default', async () => {
    const host = makeHost();
    (host.settings as any).providerConfigs.grok.catalogsByHost = {
      [getHostnameKey()]: {
        defaultModelId: 'cached-native-default',
        fingerprint: 'catalog-fixture',
        models: [{ displayName: 'Cached native default', rawId: 'cached-native-default' }],
        refreshedAt: 1,
      },
    };
    connection.loadSession.mockResolvedValue({
      models: {
        availableModels: [{ modelId: 'native-current', name: 'Native current' }],
        currentModelId: 'native-current',
      },
      sessionId: 'aux-session-1',
    });
    const runner = new GrokAuxQueryRunner(host);

    await runner.query({ model: 'grok/model-a', systemPrompt: 'Refine prompt' }, 'Explicit');
    await runner.query({ model: undefined, systemPrompt: 'Refine prompt' }, 'Native');

    expect(MockAcpSubprocess).toHaveBeenCalledTimes(2);
    expect(connection.newSession).toHaveBeenCalledTimes(1);
    expect(connection.loadSession).toHaveBeenCalledWith({
      _meta: {
        systemPromptOverride: 'Refine prompt',
        yoloMode: false,
      },
      cwd: '/tmp/grok-aux-vault',
      mcpServers: [],
      sessionId: 'aux-session-1',
    });
    expect(connection.setModel).toHaveBeenCalledTimes(1);
    expect(connection.prompt).toHaveBeenLastCalledWith({
      prompt: [{ text: 'Native', type: 'text' }],
      sessionId: 'aux-session-1',
    });
  });

  it('keeps the same binding retryable when the native-default reload fails', async () => {
    connection.loadSession
      .mockRejectedValueOnce(new Error('native reload unavailable'))
      .mockResolvedValueOnce({ sessionId: 'aux-session-1' });
    const runner = new GrokAuxQueryRunner(makeHost());

    await runner.query({ model: 'grok/model-a', systemPrompt: 'Refine prompt' }, 'Explicit');
    await expect(runner.query({ model: undefined, systemPrompt: 'Refine prompt' }, 'Native'))
      .rejects.toThrow('native reload unavailable');
    await expect(runner.query({ model: undefined, systemPrompt: 'Refine prompt' }, 'Retry native'))
      .resolves.toBe('Refined answer');

    expect(MockAcpSubprocess).toHaveBeenCalledTimes(3);
    expect(connection.newSession).toHaveBeenCalledTimes(1);
    expect(connection.loadSession).toHaveBeenCalledTimes(2);
    for (const [request] of connection.loadSession.mock.calls) {
      expect(request).toEqual({
        _meta: {
          systemPromptOverride: 'Refine prompt',
          yoloMode: false,
        },
        cwd: '/tmp/grok-aux-vault',
        mcpServers: [],
        sessionId: 'aux-session-1',
      });
    }
    expect(connection.setModel).toHaveBeenCalledTimes(1);
    expect(connection.prompt).toHaveBeenLastCalledWith({
      prompt: [{ text: 'Retry native', type: 'text' }],
      sessionId: 'aux-session-1',
    });
  });

  it('loads the retained session into a new process after process loss', async () => {
    const runner = new GrokAuxQueryRunner(makeHost());

    await runner.query({
      model: 'grok/custom-model',
      systemPrompt: 'Refine prompt',
    }, 'Initial request');
    processes[0].isAlive.mockReturnValue(false);

    await runner.query({
      model: 'grok/custom-model',
      systemPrompt: 'Refine prompt',
    }, 'Continuation');

    expect(MockAcpSubprocess).toHaveBeenCalledTimes(2);
    expect(connection.newSession).toHaveBeenCalledTimes(1);
    expect(connection.loadSession).toHaveBeenCalledWith({
      _meta: {
        modelId: 'custom-model',
        systemPromptOverride: 'Refine prompt',
        yoloMode: false,
      },
      cwd: '/tmp/grok-aux-vault',
      mcpServers: [],
      sessionId: 'aux-session-1',
    });
    expect(connection.prompt).toHaveBeenLastCalledWith({
      prompt: [{ text: 'Continuation', type: 'text' }],
      sessionId: 'aux-session-1',
    });
  });

  it('cancels an active turn on abort while retaining the resumable session', async () => {
    let resolvePrompt!: () => void;
    connection.prompt.mockImplementation(() => new Promise((resolve) => {
      resolvePrompt = () => resolve({ stopReason: 'cancelled' });
    }));
    connection.cancel.mockImplementation(() => resolvePrompt());
    const abortController = new AbortController();
    const runner = new GrokAuxQueryRunner(makeHost());
    const query = runner.query({
      abortController,
      systemPrompt: 'Refine prompt',
    }, 'Initial request');

    await flushPromises();
    abortController.abort();

    await expect(query).rejects.toThrow('Cancelled');
    expect(connection.cancel).toHaveBeenCalledTimes(1);
    expect(connection.cancel).toHaveBeenCalledWith({ sessionId: 'aux-session-1' });
    expect(transport.flush).toHaveBeenCalledTimes(1);
    expect(processes[0].shutdown).toHaveBeenCalledTimes(1);
  });

  it('recycles after abort and quarantines late raw chunks from the previous connection', async () => {
    const abortController = new AbortController();
    let promptCount = 0;
    let staleStandardHandler: ((notification: any) => void | Promise<void>) | undefined;
    connection.prompt.mockImplementation(async (request) => {
      promptCount += 1;
      if (promptCount === 1) {
        staleStandardHandler = connectionDelegate.onSessionNotification;
        await connectionDelegate.onSessionNotification?.({
          sessionId: request.sessionId,
          update: {
            content: { text: 'old', type: 'text' },
            messageId: 'assistant-old',
            sessionUpdate: 'agent_message_chunk',
          },
        });
        return new Promise(() => {});
      }

      await rawNotificationHandlers.get('_x.ai/session/update')?.[0]?.({
        sessionId: request.sessionId,
        update: {
          content: { text: ' late', type: 'text' },
          messageId: 'assistant-old',
          sessionUpdate: 'agent_message_chunk',
        },
      });
      await staleStandardHandler?.({
        sessionId: request.sessionId,
        update: {
          content: { text: ' stale-standard', type: 'text' },
          messageId: 'assistant-old',
          sessionUpdate: 'agent_message_chunk',
        },
      });
      const currentRawHandlers = rawNotificationHandlers.get('_x.ai/session/update') ?? [];
      await currentRawHandlers.at(-1)?.({
        sessionId: request.sessionId,
        update: {
          content: { text: 'new', type: 'text' },
          messageId: 'assistant-new',
          sessionUpdate: 'agent_message_chunk',
        },
      });
      return { stopReason: 'end_turn' };
    });
    const runner = new GrokAuxQueryRunner(makeHost());
    const firstQuery = runner.query({
      abortController,
      onTextChunk: () => abortController.abort(),
      systemPrompt: 'Refine prompt',
    }, 'First');

    await expect(firstQuery).rejects.toThrow('Cancelled');
    await expect(runner.query({ systemPrompt: 'Refine prompt' }, 'Second')).resolves.toBe('new');

    expect(MockAcpSubprocess).toHaveBeenCalledTimes(2);
    expect(connection.loadSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'aux-session-1',
    }));
    expect(processes[0].shutdown).toHaveBeenCalledTimes(1);
  });

  it('cancels a possibly active native turn when the prompt request times out', async () => {
    connection.prompt.mockRejectedValue(new Error('Request timeout: session/prompt'));
    const runner = new GrokAuxQueryRunner(makeHost());

    await expect(runner.query({ systemPrompt: 'Title prompt' }, 'Generate')).rejects.toThrow(
      'Request timeout: session/prompt',
    );
    expect(connection.cancel).toHaveBeenCalledTimes(1);
    expect(connection.cancel).toHaveBeenCalledWith({ sessionId: 'aux-session-1' });
    expect(transport.flush).toHaveBeenCalledTimes(1);
  });

  it('enforces the auxiliary turn timeout when the native prompt remains pending', async () => {
    connection.prompt.mockImplementation(() => new Promise(() => {}));
    const runner = new GrokAuxQueryRunner(makeHost(), { timeoutMs: 5 });

    await expect(runner.query({ systemPrompt: 'Title prompt' }, 'Generate')).rejects.toThrow(
      'Grok auxiliary query timed out after 5ms.',
    );
    expect(connection.cancel).toHaveBeenCalledTimes(1);
    expect(connection.cancel).toHaveBeenCalledWith({ sessionId: 'aux-session-1' });
    expect(transport.flush).toHaveBeenCalledTimes(1);
    expect(processes[0].shutdown).toHaveBeenCalledTimes(1);
  });

  it('bounds cancel delivery when the transport flush callback never arrives', async () => {
    jest.useFakeTimers();
    try {
      connection.prompt.mockImplementation(() => new Promise(() => {}));
      transport.flush.mockImplementation(() => new Promise(() => {}));
      const runner = new GrokAuxQueryRunner(makeHost(), { timeoutMs: 5 });
      const query = runner.query({ systemPrompt: 'Title prompt' }, 'Generate');
      const result = query.then(
        () => null,
        error => error as Error,
      );

      await jest.advanceTimersByTimeAsync(5);
      expect(connection.cancel).toHaveBeenCalledTimes(1);
      expect(transport.flush).toHaveBeenCalledTimes(1);
      expect(processes[0].shutdown).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(250);
      await expect(result).resolves.toEqual(expect.objectContaining({
        message: 'Grok auxiliary query timed out after 5ms.',
      }));
      expect(processes[0].shutdown).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reset shuts down the owned process, clears the session, and is reusable', async () => {
    const runner = new GrokAuxQueryRunner(makeHost());
    await runner.query({ systemPrompt: 'Title prompt' }, 'First');

    runner.reset();

    expect(connection.dispose).toHaveBeenCalledTimes(1);
    expect(transport.dispose).toHaveBeenCalledTimes(1);
    expect(rawTransportUnregisters.length).toBeGreaterThan(0);
    for (const unregister of rawTransportUnregisters) {
      expect(unregister).toHaveBeenCalledTimes(1);
    }
    expect(processes[0].shutdown).toHaveBeenCalledTimes(1);

    await runner.query({ systemPrompt: 'Title prompt' }, 'Second');

    expect(MockAcpSubprocess).toHaveBeenCalledTimes(2);
    expect(connection.newSession).toHaveBeenCalledTimes(2);
    expect(connection.loadSession).not.toHaveBeenCalled();
  });

  it('gives each runner its own process and cleans up idempotently', async () => {
    const first = new GrokAuxQueryRunner(makeHost());
    const second = new GrokAuxQueryRunner(makeHost());

    await first.query({ systemPrompt: 'First prompt' }, 'First');
    await second.query({ systemPrompt: 'Second prompt' }, 'Second');
    first.reset();
    first.reset();
    second.reset();

    expect(MockAcpSubprocess).toHaveBeenCalledTimes(2);
    expect(processes[0].shutdown).toHaveBeenCalledTimes(1);
    expect(processes[1].shutdown).toHaveBeenCalledTimes(1);
  });

  it('exposes awaited cleanup for provider-owned disposal', async () => {
    const runner = new GrokAuxQueryRunner(makeHost());
    await runner.query({ systemPrompt: 'One-shot prompt' }, 'Generate');

    await runner.cleanup();

    expect(connection.dispose).toHaveBeenCalledTimes(1);
    expect(transport.dispose).toHaveBeenCalledTimes(1);
    expect(processes[0].shutdown).toHaveBeenCalledTimes(1);
  });
});
