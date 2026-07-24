import { OpencodeRuntimeCommandLoader } from '@/providers/opencode/app/OpencodeRuntimeCommandLoader';
import { OpencodeChatRuntime } from '@/providers/opencode/runtime/OpencodeChatRuntime';

function createMockPlugin(): any {
  return {
    settings: {
      providerConfigs: {
        opencode: {
          enabled: true,
        },
      },
    },
  };
}

describe('OpencodeRuntimeCommandLoader', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds a deterministic fingerprint without settings or environment text', () => {
    const loader = new OpencodeRuntimeCommandLoader();
    const settings = {
      providerConfigs: {
        opencode: {
          cliPath: '/private/provider/bin/opencode',
          enabled: true,
          environmentVariables: 'SECRET_SENTINEL=do-not-retain',
        },
      },
    };

    const fingerprint = loader.getCacheFingerprint(settings);

    expect(fingerprint).toBe('opencode:commands:v1:enabled');
    expect(fingerprint).not.toContain('SECRET_SENTINEL');
    expect(fingerprint).not.toContain('/private/provider');
  });

  it('uses an isolated in-memory session for blank-tab command warmup', async () => {
    const commands = [{ id: 'acp:review', name: 'review', content: '' }];
    const syncSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'syncConversationState').mockImplementation(() => {});
    const ensureReadySpy = jest.spyOn(OpencodeChatRuntime.prototype, 'ensureReady').mockResolvedValue(true);
    const discoverSupportedCommandsSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'discoverSupportedCommands').mockResolvedValue(commands);
    const cleanupSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'cleanup').mockImplementation(() => {});
    const loader = new OpencodeRuntimeCommandLoader();

    await expect(loader.loadCommands({
      allowSessionCreation: true,
      conversation: null,
      externalContextPaths: [],
      plugin: createMockPlugin(),
      runtime: null,
    })).resolves.toEqual({ items: commands, status: 'ready' });

    expect(syncSpy).toHaveBeenCalledWith({
      providerState: { databasePath: ':memory:' },
      sessionId: null,
    });
    expect(ensureReadySpy).toHaveBeenCalledWith({ allowSessionCreation: true });
    expect(discoverSupportedCommandsSpy).toHaveBeenCalledWith(5_000);
    expect(discoverSupportedCommandsSpy.mock.invocationCallOrder[0])
      .toBeLessThan(ensureReadySpy.mock.invocationCallOrder[0]);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps blank tabs cold unless warmup is explicitly requested', async () => {
    const ensureReadySpy = jest.spyOn(OpencodeChatRuntime.prototype, 'ensureReady');
    const loader = new OpencodeRuntimeCommandLoader();

    await expect(loader.loadCommands({
      conversation: null,
      externalContextPaths: [],
      plugin: createMockPlugin(),
      runtime: null,
    })).resolves.toEqual({
      message: 'OpenCode command discovery is unavailable for this tab state.',
      retryable: true,
      status: 'error',
    });

    expect(ensureReadySpy).not.toHaveBeenCalled();
  });

  it('warms pre-session conversations that already have messages', async () => {
    const commands = [{ id: 'acp:review', name: 'review', content: '' }];
    const syncSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'syncConversationState').mockImplementation(() => {});
    const ensureReadySpy = jest.spyOn(OpencodeChatRuntime.prototype, 'ensureReady').mockResolvedValue(true);
    const discoverSupportedCommandsSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'discoverSupportedCommands').mockResolvedValue(commands);
    const loader = new OpencodeRuntimeCommandLoader();

    await expect(loader.loadCommands({
      conversation: {
        id: 'conv-opencode',
        messages: [{ id: 'm1' }],
        providerState: {},
        sessionId: null,
      } as any,
      externalContextPaths: [],
      plugin: createMockPlugin(),
      runtime: null,
    })).resolves.toEqual({ items: commands, status: 'ready' });

    expect(syncSpy).toHaveBeenCalledWith({
      providerState: { databasePath: ':memory:' },
      sessionId: null,
    });
    expect(ensureReadySpy).toHaveBeenCalledWith({ allowSessionCreation: true });
    expect(discoverSupportedCommandsSpy).toHaveBeenCalledWith(5_000);
  });

  it('does not create a pre-session command warmup session on the bound tab runtime', async () => {
    const commands = [{ id: 'acp:review', name: 'review', content: '' }];
    const syncSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'syncConversationState').mockImplementation(() => {});
    const ensureReadySpy = jest.spyOn(OpencodeChatRuntime.prototype, 'ensureReady').mockResolvedValue(true);
    const discoverSupportedCommandsSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'discoverSupportedCommands').mockResolvedValue(commands);
    const cleanupSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'cleanup').mockImplementation(() => {});
    const boundRuntime = {
      providerId: 'opencode',
      cleanup: jest.fn(),
      ensureReady: jest.fn(),
      discoverSupportedCommands: jest.fn(),
      syncConversationState: jest.fn(),
    };
    const loader = new OpencodeRuntimeCommandLoader();

    await expect(loader.loadCommands({
      conversation: {
        id: 'conv-opencode',
        messages: [{ id: 'm1' }],
        providerState: {},
        sessionId: null,
      } as any,
      externalContextPaths: [],
      plugin: createMockPlugin(),
      runtime: boundRuntime as any,
    })).resolves.toEqual({ items: commands, status: 'ready' });

    expect(boundRuntime.syncConversationState).not.toHaveBeenCalled();
    expect(boundRuntime.ensureReady).not.toHaveBeenCalled();
    expect(boundRuntime.discoverSupportedCommands).not.toHaveBeenCalled();
    expect(syncSpy).toHaveBeenCalledWith({
      providerState: { databasePath: ':memory:' },
      sessionId: null,
    });
    expect(ensureReadySpy).toHaveBeenCalledWith({ allowSessionCreation: true });
    expect(discoverSupportedCommandsSpy).toHaveBeenCalledWith(5_000);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('distinguishes advertised empty commands from timeout or process failure', async () => {
    const loader = new OpencodeRuntimeCommandLoader();
    jest.spyOn(OpencodeChatRuntime.prototype, 'syncConversationState').mockImplementation(() => {});
    jest.spyOn(OpencodeChatRuntime.prototype, 'ensureReady').mockResolvedValue(true);
    const discoverSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'discoverSupportedCommands')
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('SECRET_SENTINEL process exited'));
    const cleanupSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'cleanup').mockImplementation(() => {});
    const context = {
      allowSessionCreation: true,
      conversation: null,
      externalContextPaths: [],
      plugin: createMockPlugin(),
      runtime: null,
    };

    await expect(loader.loadCommands(context)).resolves.toEqual({ status: 'empty' });
    const failure = await loader.loadCommands(context);

    expect(discoverSpy).toHaveBeenCalledTimes(2);
    expect(failure).toEqual({
      message: 'Could not load OpenCode commands.',
      retryable: true,
      status: 'error',
    });
    expect(JSON.stringify(failure)).not.toContain('SECRET_SENTINEL');
    expect(cleanupSpy).toHaveBeenCalledTimes(2);
  });

  it('cleans up the isolated process when runtime readiness fails', async () => {
    jest.spyOn(OpencodeChatRuntime.prototype, 'syncConversationState').mockImplementation(() => {});
    jest.spyOn(OpencodeChatRuntime.prototype, 'discoverSupportedCommands')
      .mockReturnValue(new Promise(() => {}));
    jest.spyOn(OpencodeChatRuntime.prototype, 'ensureReady').mockResolvedValue(false);
    const cleanupSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'cleanup').mockImplementation(() => {});

    await expect(new OpencodeRuntimeCommandLoader().loadCommands({
      allowSessionCreation: true,
      conversation: null,
      externalContextPaths: [],
      plugin: createMockPlugin(),
      runtime: null,
    })).resolves.toEqual({
      message: 'Could not load OpenCode commands.',
      retryable: true,
      status: 'error',
    });

    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('cleans up the isolated process when discovery is aborted', async () => {
    const abortController = new AbortController();
    jest.spyOn(OpencodeChatRuntime.prototype, 'syncConversationState').mockImplementation(() => {});
    jest.spyOn(OpencodeChatRuntime.prototype, 'ensureReady').mockResolvedValue(true);
    jest.spyOn(OpencodeChatRuntime.prototype, 'discoverSupportedCommands')
      .mockImplementation((_timeoutMs, signal) => (
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })
      ));
    const cleanupSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'cleanup')
      .mockImplementation(() => {});

    const discovery = new OpencodeRuntimeCommandLoader().loadCommands({
      allowSessionCreation: true,
      conversation: null,
      externalContextPaths: [],
      plugin: createMockPlugin(),
      runtime: null,
      signal: abortController.signal,
    });
    abortController.abort();

    await expect(discovery).resolves.toEqual({
      message: 'Could not load OpenCode commands.',
      retryable: true,
      status: 'error',
    });
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});
