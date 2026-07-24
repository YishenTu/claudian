const mockCreatedRuntimes: Array<{
  cleanup: jest.Mock;
  discoverSupportedCommands: jest.Mock;
  ensureReady: jest.Mock;
  providerId: string;
  syncConversationState: jest.Mock;
}> = [];

jest.mock('@/providers/pi/runtime/PiChatRuntime', () => ({
  PiChatRuntime: jest.fn().mockImplementation(() => {
    const runtime = {
      cleanup: jest.fn(),
      discoverSupportedCommands: jest.fn().mockResolvedValue([
        {
          content: '',
          id: 'pi:skill:skill:shared-review',
          kind: 'skill',
          name: 'skill:shared-review',
          source: 'sdk',
        },
      ]),
      ensureReady: jest.fn().mockResolvedValue(true),
      providerId: 'pi',
      syncConversationState: jest.fn(),
    };
    mockCreatedRuntimes.push(runtime);
    return runtime;
  }),
}));

import type { Conversation } from '@/core/types';
import { PiRuntimeCommandLoader } from '@/providers/pi/app/PiRuntimeCommandLoader';
import { PiChatRuntime } from '@/providers/pi/runtime/PiChatRuntime';

function createConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    createdAt: 1,
    id: 'conversation-1',
    messages: [],
    providerId: 'pi',
    sessionId: null,
    title: 'Conversation',
    updatedAt: 1,
    ...overrides,
  };
}

describe('PiRuntimeCommandLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatedRuntimes.length = 0;
  });

  it('builds a deterministic fingerprint without settings or environment text', () => {
    const loader = new PiRuntimeCommandLoader();
    const settings = {
      providerConfigs: {
        pi: {
          cliPath: '/private/provider/bin/pi',
          enabled: true,
          environmentVariables: 'SECRET_SENTINEL=do-not-retain',
        },
      },
    };

    const fingerprint = loader.getCacheFingerprint(settings);

    expect(fingerprint).toBe('pi:commands:v1:enabled');
    expect(fingerprint).not.toContain('SECRET_SENTINEL');
    expect(fingerprint).not.toContain('/private/provider');
  });

  it('does not reuse a live runtime for a pre-session conversation when session creation is disallowed', async () => {
    const runtime = {
      cleanup: jest.fn(),
      discoverSupportedCommands: jest.fn(),
      ensureReady: jest.fn(),
      isReady: jest.fn().mockReturnValue(true),
      providerId: 'pi',
      syncConversationState: jest.fn(),
    };
    const conversation = createConversation({
      messages: [{ content: 'Existing imported prompt', id: 'm1', role: 'user', timestamp: 1 }],
      sessionId: null,
    });

    const commands = await new PiRuntimeCommandLoader().loadCommands({
      allowSessionCreation: false,
      conversation,
      externalContextPaths: [],
      plugin: {} as any,
      runtime: runtime as any,
    });

    expect(commands).toEqual({
      message: 'Pi command discovery is unavailable for this tab state.',
      retryable: true,
      status: 'error',
    });
    expect(runtime.ensureReady).not.toHaveBeenCalled();
    expect(runtime.syncConversationState).not.toHaveBeenCalled();
    expect(PiChatRuntime).not.toHaveBeenCalled();
  });

  it('loads commands for conversations with persisted Pi session state', async () => {
    const conversation = createConversation({
      providerState: { sessionFile: '/tmp/pi-session.jsonl' },
      sessionId: null,
    });

    const commands = await new PiRuntimeCommandLoader().loadCommands({
      allowSessionCreation: false,
      conversation,
      externalContextPaths: ['docs'],
      plugin: {} as any,
      runtime: null,
    });

    expect(commands).toEqual({
      items: [expect.objectContaining({
        id: 'pi:skill:skill:shared-review',
        kind: 'skill',
        name: 'skill:shared-review',
      })],
      status: 'ready',
    });
    expect(PiChatRuntime).toHaveBeenCalledTimes(1);
    expect(mockCreatedRuntimes[0].syncConversationState).not.toHaveBeenCalled();
    expect(mockCreatedRuntimes[0].ensureReady).toHaveBeenCalledWith({ allowSessionCreation: false });
    expect(mockCreatedRuntimes[0].cleanup).toHaveBeenCalled();
  });

  it('uses a no-session runtime for blank-tab command warmup', async () => {
    const commands = await new PiRuntimeCommandLoader().loadCommands({
      allowSessionCreation: true,
      conversation: null,
      externalContextPaths: [],
      plugin: {} as any,
      runtime: null,
    });

    expect(commands).toEqual({
      items: [expect.objectContaining({
        kind: 'skill',
        name: 'skill:shared-review',
      })],
      status: 'ready',
    });
    expect(PiChatRuntime).toHaveBeenCalledTimes(1);
    expect(mockCreatedRuntimes[0].syncConversationState).not.toHaveBeenCalled();
    expect(mockCreatedRuntimes[0].ensureReady).toHaveBeenCalledWith({ allowSessionCreation: false });
    expect(mockCreatedRuntimes[0].cleanup).toHaveBeenCalled();
  });

  it('reuses a ready Pi runtime without creating a command-only process', async () => {
    const runtime = {
      cleanup: jest.fn(),
      discoverSupportedCommands: jest.fn().mockResolvedValue([
        { content: '', id: 'pi:runtime:live', name: 'live', source: 'sdk' },
      ]),
      ensureReady: jest.fn().mockResolvedValue(true),
      isReady: jest.fn().mockReturnValue(true),
      providerId: 'pi',
      syncConversationState: jest.fn(),
    };
    const conversation = createConversation({
      providerState: { sessionFile: '/tmp/pi-session.jsonl' },
      sessionId: null,
    });

    const commands = await new PiRuntimeCommandLoader().loadCommands({
      allowSessionCreation: false,
      conversation,
      externalContextPaths: ['docs'],
      plugin: {} as any,
      runtime: runtime as any,
    });

    expect(commands).toEqual({
      items: [{ content: '', id: 'pi:runtime:live', name: 'live', source: 'sdk' }],
      status: 'ready',
    });
    expect(PiChatRuntime).not.toHaveBeenCalled();
    expect(runtime.syncConversationState).toHaveBeenCalledWith(conversation, ['docs']);
    expect(runtime.ensureReady).toHaveBeenCalledWith({ allowSessionCreation: false });
    expect(runtime.cleanup).not.toHaveBeenCalled();
  });

  it('distinguishes an authoritative empty response from transport failure', async () => {
    const loader = new PiRuntimeCommandLoader();
    const emptyRuntime = {
      cleanup: jest.fn(),
      discoverSupportedCommands: jest.fn().mockResolvedValue([]),
      ensureReady: jest.fn().mockResolvedValue(true),
      isReady: jest.fn().mockReturnValue(true),
      providerId: 'pi',
      syncConversationState: jest.fn(),
    };
    const failedRuntime = {
      ...emptyRuntime,
      discoverSupportedCommands: jest.fn().mockRejectedValue(new Error('SECRET_SENTINEL transport failed')),
    };
    const conversation = createConversation({ sessionId: 'session-1' });

    await expect(loader.loadCommands({
      conversation,
      externalContextPaths: [],
      plugin: {} as any,
      runtime: emptyRuntime as any,
    })).resolves.toEqual({ status: 'empty' });
    const failure = await loader.loadCommands({
      conversation,
      externalContextPaths: [],
      plugin: {} as any,
      runtime: failedRuntime as any,
    });
    expect(failure).toEqual({
      message: 'Could not load Pi commands.',
      retryable: true,
      status: 'error',
    });
    expect(JSON.stringify(failure)).not.toContain('SECRET_SENTINEL');
  });

  it('cleans up the isolated process when discovery is aborted', async () => {
    const abortController = new AbortController();
    const conversation = createConversation({ sessionId: 'session-1' });

    const discovery = new PiRuntimeCommandLoader().loadCommands({
      conversation,
      externalContextPaths: [],
      plugin: {} as any,
      runtime: null,
      signal: abortController.signal,
    });
    abortController.abort();

    await expect(discovery).resolves.toEqual({
      message: 'Could not load Pi commands.',
      retryable: true,
      status: 'error',
    });
    expect(mockCreatedRuntimes[0].cleanup).toHaveBeenCalledTimes(1);
  });
});
