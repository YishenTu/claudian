const mockTransportInstances: MockPiRpcTransport[] = [];
const mockSubprocessInstances: MockPiSubprocess[] = [];

class MockPiSubprocess {
  readonly stdin = {};
  readonly stdout = {};
  private alive = true;

  constructor(readonly launchSpec: unknown) {
    mockSubprocessInstances.push(this);
  }

  start = jest.fn();
  isAlive = jest.fn(() => this.alive);
  getStderrSnapshot = jest.fn(() => '');
  onClose = jest.fn(() => jest.fn());
  shutdown = jest.fn(async () => {
    this.alive = false;
  });
}

class MockPiRpcTransport {
  isClosed = false;
  readonly eventHandlers: Array<(event: Record<string, unknown>) => void> = [];
  readonly closeHandlers: Array<(error?: Error) => void> = [];
  readonly request = jest.fn(async (type: string) => {
    if (type === 'prompt') {
      return { accepted: true };
    }
    if (type === 'get_state') {
      return {};
    }
    if (type === 'get_session_stats') {
      return {};
    }
    return {};
  });
  readonly send = jest.fn();
  readonly dispose = jest.fn(() => {
    this.isClosed = true;
  });

  constructor(_streams: unknown) {
    mockTransportInstances.push(this);
  }

  start = jest.fn();

  onEvent(handler: (event: Record<string, unknown>) => void): () => void {
    this.eventHandlers.push(handler);
    return jest.fn();
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandlers.push(handler);
    return jest.fn();
  }

  triggerClose(error?: Error): void {
    this.isClosed = true;
    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}

jest.mock('@/providers/pi/runtime/PiSubprocess', () => ({
  PiSubprocess: MockPiSubprocess,
}));

jest.mock('@/providers/pi/runtime/PiRpcTransport', () => ({
  PiRpcTransport: MockPiRpcTransport,
}));

import '@/providers';

import type { ChatMessage, Conversation } from '@/core/types';
import { PiChatRuntime } from '@/providers/pi/runtime/PiChatRuntime';

function createPlugin(): any {
  return {
    app: {
      vault: {
        adapter: {
          basePath: '/tmp/pi-vault',
        },
      },
    },
    getResolvedProviderCliPath: jest.fn(() => 'pi'),
    settings: {
      mediaFolder: 'media',
      providerConfigs: {
        pi: {
          enabled: true,
        },
      },
      systemPrompt: '',
      userName: '',
    },
  };
}

function createTurn(runtime: PiChatRuntime) {
  return runtime.prepareTurn({
    enabledMcpServers: new Set(),
    text: 'Hello Pi',
  } as any);
}

async function flushPromises(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

describe('PiChatRuntime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransportInstances.length = 0;
    mockSubprocessInstances.length = 0;
  });

  it('uses command-boundary, case-insensitive compact detection', () => {
    const runtime = new PiChatRuntime(createPlugin());

    expect(runtime.prepareTurn({ text: '/Compact extra instructions' }).isCompact).toBe(true);
    expect(runtime.prepareTurn({ text: '/compactfoo' }).isCompact).toBe(false);
    expect(runtime.prepareTurn({ text: ' /compact' }).isCompact).toBe(false);
  });

  it('yields a terminal error and done when the Pi process closes mid-turn', async () => {
    const runtime = new PiChatRuntime(createPlugin());
    const iterator = runtime.query(createTurn(runtime));

    const firstChunk = iterator.next();
    await flushPromises();

    expect(mockTransportInstances).toHaveLength(1);
    expect(mockTransportInstances[0].request).toHaveBeenCalledWith('prompt', {
      message: 'Hello Pi',
    });

    await expect(firstChunk).resolves.toEqual({
      done: false,
      value: { type: 'user_message_start', content: 'Hello Pi' },
    });

    mockTransportInstances[0].triggerClose(new Error('Pi exited'));

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'error', content: 'Pi exited' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'done' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('aborts and tears down Pi when the stream consumer closes before agent_end', async () => {
    const runtime = new PiChatRuntime(createPlugin());
    const iterator = runtime.query(createTurn(runtime));

    const firstChunk = iterator.next();
    await flushPromises();

    await expect(firstChunk).resolves.toEqual({
      done: false,
      value: { type: 'user_message_start', content: 'Hello Pi' },
    });

    const textChunk = iterator.next();
    mockTransportInstances[0].eventHandlers[0]({
      assistantMessageEvent: { text_delta: 'partial' },
      type: 'message_update',
    });

    await expect(textChunk).resolves.toEqual({
      done: false,
      value: { type: 'text', content: 'partial' },
    });

    await iterator.return(undefined);
    await flushPromises();

    expect(mockTransportInstances[0].send).toHaveBeenCalledWith({ type: 'abort' });
    expect(mockTransportInstances[0].dispose).toHaveBeenCalled();
    expect(mockSubprocessInstances[0].shutdown).toHaveBeenCalled();
  });

  it('cancels pending extension UI dialogs when the Pi process closes', async () => {
    const dialogState: { signal?: AbortSignal } = {};
    const renderer = {
      input: jest.fn((_request: unknown, signal: AbortSignal) => {
        dialogState.signal = signal;
        return new Promise<{ cancelled?: boolean }>((resolve) => {
          signal.addEventListener('abort', () => resolve({ cancelled: true }));
        });
      }),
    };
    const runtime = new PiChatRuntime(createPlugin(), {
      extensionUiRenderer: renderer as any,
    });
    const iterator = runtime.query(createTurn(runtime));

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'user_message_start', content: 'Hello Pi' },
    });

    mockTransportInstances[0].eventHandlers[0]({
      id: 'ui-1',
      method: 'input',
      type: 'extension_ui_request',
    });
    expect(renderer.input).toHaveBeenCalled();

    mockTransportInstances[0].triggerClose(new Error('Pi exited'));
    await flushPromises();

    expect(dialogState.signal?.aborted).toBe(true);
    expect(mockTransportInstances[0].send).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-1',
      type: 'extension_ui_response',
    });

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'error', content: 'Pi exited' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'done' },
    });
  });

  it('emits provider user-message boundaries for accepted prompts and steering turns', async () => {
    const runtime = new PiChatRuntime(createPlugin());
    const iterator = runtime.query(createTurn(runtime));

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'user_message_start', content: 'Hello Pi' },
    });

    const steerAccepted = await runtime.steer(runtime.prepareTurn({
      enabledMcpServers: new Set(),
      text: 'Follow up',
    } as any));

    expect(steerAccepted).toBe(true);
    expect(mockTransportInstances[0].request).toHaveBeenCalledWith('steer', {
      images: [],
      message: 'Follow up',
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'user_message_start', content: 'Follow up' },
    });

    mockTransportInstances[0].eventHandlers[0]({ type: 'agent_end' });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'done' },
    });
  });

  it('does not apply thinking level when only the synthetic Pi fallback model is selected', async () => {
    const runtime = new PiChatRuntime(createPlugin());
    const chunks: unknown[] = [];
    const promise = (async () => {
      for await (const chunk of runtime.query(createTurn(runtime))) {
        chunks.push(chunk);
      }
    })();

    await flushPromises();
    mockTransportInstances[0].eventHandlers[0]({ type: 'agent_end' });
    await promise;

    expect(chunks[chunks.length - 1]).toEqual({ type: 'done' });
    expect(mockTransportInstances[0].request).not.toHaveBeenCalledWith(
      'set_thinking_level',
      expect.anything(),
    );
  });

  it('does not bootstrap local history after readiness refresh finds an existing Pi session', async () => {
    const runtime = new PiChatRuntime(createPlugin());
    (runtime as any).refreshState = jest.fn(async () => {
      (runtime as any).sessionId = 'existing-session';
    });
    const history: ChatMessage[] = [{
      content: 'Older message',
      id: 'm1',
      role: 'user',
      timestamp: 1,
    }];
    const chunks: unknown[] = [];
    const promise = (async () => {
      for await (const chunk of runtime.query(createTurn(runtime), history)) {
        chunks.push(chunk);
      }
    })();

    await flushPromises();

    expect(mockTransportInstances[0].request).toHaveBeenCalledWith('prompt', {
      message: 'Hello Pi',
    });

    mockTransportInstances[0].eventHandlers[0]({ type: 'agent_end' });
    await promise;
    expect(chunks[chunks.length - 1]).toEqual({ type: 'done' });
  });

  it('clamps stale effort selections to the selected Pi model thinking levels', async () => {
    const plugin = createPlugin();
    plugin.settings.providerConfigs.pi = {
      discoveredModels: [
        {
          encodedId: 'pi:openai/gpt-5',
          id: 'gpt-5',
          input: ['text'],
          label: 'GPT-5',
          provider: 'openai',
          reasoning: false,
          thinkingLevels: ['off'],
        },
      ],
      enabled: true,
      visibleModels: ['pi:openai/gpt-5'],
    };
    plugin.settings.savedProviderModel = {
      pi: 'pi:openai/gpt-5',
    };
    plugin.settings.savedProviderEffort = {
      pi: 'high',
    };
    const runtime = new PiChatRuntime(plugin);
    const chunks: unknown[] = [];
    const promise = (async () => {
      for await (const chunk of runtime.query(createTurn(runtime))) {
        chunks.push(chunk);
      }
    })();

    await flushPromises();
    mockTransportInstances[0].eventHandlers[0]({ type: 'agent_end' });
    await promise;

    expect(chunks[chunks.length - 1]).toEqual({ type: 'done' });
    expect(mockTransportInstances[0].request).toHaveBeenCalledWith('set_thinking_level', {
      level: 'off',
    });
  });

  it('applies changed models over RPC without restarting the Pi process', async () => {
    const plugin = createPlugin();
    plugin.settings.providerConfigs.pi = {
      discoveredModels: [
        {
          encodedId: 'pi:anthropic/claude-sonnet-4',
          id: 'claude-sonnet-4',
          input: ['text'],
          label: 'Claude Sonnet 4',
          provider: 'anthropic',
          reasoning: true,
          thinkingLevels: ['off', 'medium', 'high'],
        },
        {
          encodedId: 'pi:openai/gpt-5',
          id: 'gpt-5',
          input: ['text'],
          label: 'GPT-5',
          provider: 'openai',
          reasoning: true,
          thinkingLevels: ['off', 'medium', 'high'],
        },
      ],
      enabled: true,
      visibleModels: ['pi:anthropic/claude-sonnet-4', 'pi:openai/gpt-5'],
    };
    plugin.settings.savedProviderModel = {
      pi: 'pi:anthropic/claude-sonnet-4',
    };
    plugin.settings.savedProviderEffort = {
      pi: 'medium',
    };
    const runtime = new PiChatRuntime(plugin);

    const runQuery = async (): Promise<void> => {
      const chunks: unknown[] = [];
      const promise = (async () => {
        for await (const chunk of runtime.query(createTurn(runtime))) {
          chunks.push(chunk);
        }
      })();
      await flushPromises();
      mockTransportInstances[0].eventHandlers[0]({ type: 'agent_end' });
      await promise;
      expect(chunks[chunks.length - 1]).toEqual({ type: 'done' });
    };

    await runQuery();
    plugin.settings.savedProviderModel.pi = 'pi:openai/gpt-5';
    await runQuery();

    expect(mockSubprocessInstances).toHaveLength(1);
    expect(mockTransportInstances[0].request).toHaveBeenCalledWith('set_model', {
      modelId: 'claude-sonnet-4',
      provider: 'anthropic',
    });
    expect(mockTransportInstances[0].request).toHaveBeenCalledWith('set_model', {
      modelId: 'gpt-5',
      provider: 'openai',
    });
    expect(mockTransportInstances[0].request.mock.calls.filter(([type]) =>
      type === 'set_thinking_level'
    )).toEqual([
      ['set_thinking_level', { level: 'medium' }],
      ['set_thinking_level', { level: 'medium' }],
    ]);
  });

  it('does not persist stale session file state after a reset starts a new Pi session', () => {
    const runtime = new PiChatRuntime(createPlugin());
    const conversation = {
      createdAt: 1,
      id: 'conversation-1',
      messages: [],
      providerId: 'pi',
      providerState: {
        leafEntryId: 'old-leaf',
        sessionFile: '/tmp/old-pi-session.jsonl',
        sessionId: 'old-session',
      },
      sessionId: 'old-session',
      title: 'Pi',
      updatedAt: 1,
    } satisfies Conversation;

    runtime.syncConversationState(conversation);
    runtime.resetSession();
    (runtime as any).sessionId = 'new-session';

    expect(runtime.buildSessionUpdates({
      conversation,
      sessionInvalidated: false,
    }).updates).toEqual({
      providerState: { sessionId: 'new-session' },
      sessionId: 'new-session',
    });
  });
});
