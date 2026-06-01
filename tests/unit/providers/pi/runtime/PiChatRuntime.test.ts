import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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

  it('yields error and done without spawning when Pi is disabled', async () => {
    const plugin = createPlugin();
    plugin.settings.providerConfigs.pi.enabled = false;
    const runtime = new PiChatRuntime(plugin);

    const chunks: unknown[] = [];
    for await (const chunk of runtime.query(createTurn(runtime))) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'error', content: 'Failed to start Pi. Check the CLI path and login state.' },
      { type: 'done' },
    ]);
    expect(mockSubprocessInstances).toHaveLength(0);
  });

  it('sends native compact requests and yields a context boundary', async () => {
    const runtime = new PiChatRuntime(createPlugin());
    const chunks: unknown[] = [];

    for await (const chunk of runtime.query(runtime.prepareTurn({
      text: '/compact keep decisions',
    }))) {
      chunks.push(chunk);
    }

    expect(mockTransportInstances[0].request).toHaveBeenCalledWith('compact', {
      customInstructions: 'keep decisions',
    });
    expect(chunks).toEqual([
      { type: 'context_compacted' },
      { type: 'done' },
    ]);
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

  it('emits terminal Pi stop-reason errors before completing the turn', async () => {
    const runtime = new PiChatRuntime(createPlugin());
    const iterator = runtime.query(createTurn(runtime));

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'user_message_start', content: 'Hello Pi' },
    });

    mockTransportInstances[0].eventHandlers[0]({
      errorMessage: 'Invalid image',
      stopReason: 'error',
      type: 'message_end',
    });

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'error', content: 'Invalid image' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'done' },
    });
  });

  it('maps steer images and filters empty image data', async () => {
    const runtime = new PiChatRuntime(createPlugin());
    const iterator = runtime.query(createTurn(runtime));

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'user_message_start', content: 'Hello Pi' },
    });

    await expect(runtime.steer(runtime.prepareTurn({
      images: [
        {
          data: 'base64-image',
          id: 'image-1',
          mediaType: 'image/png',
          name: 'image.png',
          size: 12,
          source: 'paste',
        },
        {
          data: '',
          id: 'image-2',
          mediaType: 'image/jpeg',
          name: 'empty.jpg',
          size: 0,
          source: 'paste',
        },
      ],
      text: 'Follow up with image',
    } as any))).resolves.toBe(true);

    expect(mockTransportInstances[0].request).toHaveBeenCalledWith('steer', {
      images: [{ data: 'base64-image', mimeType: 'image/png', type: 'image' }],
      message: 'Follow up with image',
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'user_message_start', content: 'Follow up with image' },
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

  it('does not restart after a live Pi runtime reports a newly created session id', async () => {
    const runtime = new PiChatRuntime(createPlugin());

    const runQuery = async (): Promise<void> => {
      const chunks: unknown[] = [];
      const promise = (async () => {
        for await (const chunk of runtime.query(createTurn(runtime))) {
          chunks.push(chunk);
        }
      })();
      await flushPromises();
      (mockTransportInstances[0].request as jest.Mock).mockImplementation(async (type: string) => {
        if (type === 'get_state') {
          return { sessionId: 'live-session' };
        }
        if (type === 'get_session_stats') {
          return {};
        }
        return {};
      });
      mockTransportInstances[0].eventHandlers[0]({ type: 'agent_end' });
      await promise;
      expect(chunks[chunks.length - 1]).toEqual({ type: 'done' });
    };

    await runQuery();
    await runQuery();

    expect(mockSubprocessInstances).toHaveLength(1);
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

  it('switches warm runtimes by absolute session file without restarting Pi', async () => {
    const runtime = new PiChatRuntime(createPlugin());

    runtime.syncConversationState({
      providerState: { sessionFile: '/tmp/pi-session-a.jsonl' },
      sessionId: null,
    });
    await runtime.ensureReady();

    runtime.syncConversationState({
      providerState: { sessionFile: '/tmp/pi-session-b.jsonl' },
      sessionId: null,
    });
    await runtime.ensureReady();

    expect(mockSubprocessInstances).toHaveLength(1);
    expect(mockTransportInstances[0].request).toHaveBeenCalledWith('switch_session', {
      sessionPath: '/tmp/pi-session-b.jsonl',
    });
  });

  it('restarts instead of calling switch_session for bare saved session ids', async () => {
    const runtime = new PiChatRuntime(createPlugin());

    runtime.syncConversationState({
      providerState: {},
      sessionId: 'session-a',
    });
    await runtime.ensureReady();

    runtime.syncConversationState({
      providerState: {},
      sessionId: 'session-b',
    });
    await runtime.ensureReady();

    expect(mockSubprocessInstances).toHaveLength(2);
    expect(mockTransportInstances[0].request).not.toHaveBeenCalledWith(
      'switch_session',
      expect.anything(),
    );
  });

  it('restarts when a previously bound Pi session target is cleared', async () => {
    const runtime = new PiChatRuntime(createPlugin());

    runtime.syncConversationState({
      providerState: { sessionFile: '/tmp/pi-session-a.jsonl' },
      sessionId: null,
    });
    await runtime.ensureReady();

    runtime.syncConversationState(null);
    await runtime.ensureReady();

    expect(mockSubprocessInstances).toHaveLength(2);
  });

  it('materializes pending Pi forks into a new one-to-one session file before startup', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-runtime-fork-'));
    const sourceFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sourceFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'source-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/pi-vault' }),
      JSON.stringify({ id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ id: 'u2', parentId: 'a1', type: 'message', message: { role: 'user', content: 'Do not copy' } }),
    ].join('\n'));
    const runtime = new PiChatRuntime(createPlugin());

    runtime.syncConversationState({
      providerState: {
        forkSource: { sessionId: 'source-session', resumeAt: 'a1' },
        forkSourceSessionFile: sourceFile,
      },
      sessionId: null,
    });
    await runtime.ensureReady();

    const launchSpec = mockSubprocessInstances[0].launchSpec as { args: string[] };
    const sessionArgIndex = launchSpec.args.indexOf('--session');
    expect(sessionArgIndex).toBeGreaterThanOrEqual(0);
    const forkedSessionFile = launchSpec.args[sessionArgIndex + 1];
    expect(forkedSessionFile).toMatch(new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*\\.jsonl$`));
    const forkedLines = (await fs.readFile(forkedSessionFile, 'utf-8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(forkedLines.map(line => line.id)).toEqual([
      expect.any(String),
      'u1',
      'a1',
    ]);
    expect(forkedLines[0]).toMatchObject({
      cwd: '/tmp/pi-vault',
      parentSession: sourceFile,
      type: 'session',
      version: 3,
    });
    expect(runtime.buildSessionUpdates({
      conversation: null,
      sessionInvalidated: false,
    }).updates.providerState).toMatchObject({
      leafEntryId: 'a1',
      parentSession: sourceFile,
      sessionFile: forkedSessionFile,
      sessionId: forkedLines[0].id,
    });
  });

  it('does not materialize pending Pi forks when session creation is disallowed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-runtime-fork-warmup-'));
    const sourceFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sourceFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'source-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/pi-vault' }),
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
    ].join('\n'));
    const runtime = new PiChatRuntime(createPlugin());
    const forkSource = { sessionId: 'source-session', resumeAt: 'a1' };

    runtime.syncConversationState({
      providerState: {
        forkSource,
        forkSourceSessionFile: sourceFile,
      },
      sessionId: null,
    });
    await runtime.ensureReady({ allowSessionCreation: false });

    const launchSpec = mockSubprocessInstances[0].launchSpec as { args: string[] };
    expect(launchSpec.args).toContain('--no-session');
    expect(launchSpec.args).not.toContain('--session');
    expect((await fs.readdir(dir)).sort()).toEqual(['source.jsonl']);
    expect(runtime.buildSessionUpdates({
      conversation: null,
      sessionInvalidated: false,
    }).updates.providerState).toEqual({
      forkSource,
      forkSourceSessionFile: sourceFile,
    });
  });

  it('resolves fork source sessions from pending Pi fork metadata', () => {
    const runtime = new PiChatRuntime(createPlugin());
    const conversation = {
      createdAt: 1,
      id: 'conversation-1',
      messages: [],
      providerId: 'pi',
      providerState: {
        forkSource: { sessionId: 'source-session', resumeAt: 'a1' },
      },
      sessionId: null,
      title: 'Pi',
      updatedAt: 1,
    } satisfies Conversation;

    expect(runtime.resolveSessionIdForFork(conversation)).toBe('source-session');
  });

  it('resolves file-only Pi sessions as fork sources', () => {
    const runtime = new PiChatRuntime(createPlugin());
    const conversation = {
      createdAt: 1,
      id: 'conversation-1',
      messages: [],
      providerId: 'pi',
      providerState: {
        sessionFile: '/tmp/pi-session.jsonl',
      },
      sessionId: null,
      title: 'Pi',
      updatedAt: 1,
    } satisfies Conversation;

    expect(runtime.resolveSessionIdForFork(conversation)).toBe('/tmp/pi-session.jsonl');

    runtime.syncConversationState(conversation);

    expect(runtime.resolveSessionIdForFork(null)).toBe('/tmp/pi-session.jsonl');
  });

  it('records live Pi message ids from the appended session path after a turn', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-runtime-metadata-'));
    const sessionFile = path.join(dir, 'session.jsonl');
    await fs.writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'session-1' }),
      JSON.stringify({ id: 'u0', parentId: null, type: 'message', message: { role: 'user', content: 'Before' } }),
      JSON.stringify({ id: 'a0', parentId: 'u0', type: 'message', message: { role: 'assistant', content: 'Ready' } }),
    ].join('\n'));
    const runtime = new PiChatRuntime(createPlugin());
    runtime.syncConversationState({
      providerState: { sessionFile, sessionId: 'session-1' },
      sessionId: 'session-1',
    });

    const iterator = runtime.query(createTurn(runtime));
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'user_message_start', content: 'Hello Pi' },
    });
    expect(mockTransportInstances[0].request).toHaveBeenCalledWith('prompt', {
      message: 'Hello Pi',
    });

    await fs.writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'session-1' }),
      JSON.stringify({ id: 'u0', parentId: null, type: 'message', message: { role: 'user', content: 'Before' } }),
      JSON.stringify({ id: 'a0', parentId: 'u0', type: 'message', message: { role: 'assistant', content: 'Ready' } }),
      JSON.stringify({ id: 'u1', parentId: 'a0', type: 'message', message: { role: 'user', content: 'Hello Pi' } }),
      JSON.stringify({ id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'Hello' } }),
    ].join('\n'));
    mockTransportInstances[0].eventHandlers[0]({ type: 'agent_end' });

    const chunks: unknown[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      chunks.push(next.value);
    }
    expect(chunks[chunks.length - 1]).toEqual({ type: 'done' });
    expect(runtime.consumeTurnMetadata()).toMatchObject({
      assistantMessageId: 'a1',
      userMessageId: 'u1',
      wasSent: true,
    });
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
