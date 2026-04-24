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

  it('uses an isolated in-memory session for blank-tab command warmup', async () => {
    const commands = [{ id: 'acp:review', name: 'review', content: '' }];
    const syncSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'syncConversationState').mockImplementation(() => {});
    const ensureReadySpy = jest.spyOn(OpencodeChatRuntime.prototype, 'ensureReady').mockResolvedValue(true);
    const getSupportedCommandsSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'getSupportedCommands').mockResolvedValue(commands);
    const cleanupSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'cleanup').mockImplementation(() => {});
    const loader = new OpencodeRuntimeCommandLoader();

    await expect(loader.loadCommands({
      allowSessionCreation: true,
      conversation: null,
      externalContextPaths: [],
      plugin: createMockPlugin(),
      runtime: null,
    })).resolves.toEqual(commands);

    expect(syncSpy).toHaveBeenCalledWith({
      providerState: { databasePath: ':memory:' },
      sessionId: null,
    });
    expect(ensureReadySpy).toHaveBeenCalledWith({ allowSessionCreation: true });
    expect(getSupportedCommandsSpy).toHaveBeenCalledTimes(1);
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
    })).resolves.toEqual([]);

    expect(ensureReadySpy).not.toHaveBeenCalled();
  });

  it('warms pre-session conversations that already have messages', async () => {
    const commands = [{ id: 'acp:review', name: 'review', content: '' }];
    const syncSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'syncConversationState').mockImplementation(() => {});
    const ensureReadySpy = jest.spyOn(OpencodeChatRuntime.prototype, 'ensureReady').mockResolvedValue(true);
    const getSupportedCommandsSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'getSupportedCommands').mockResolvedValue(commands);
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
    })).resolves.toEqual(commands);

    expect(syncSpy).toHaveBeenCalledWith({
      id: 'conv-opencode',
      messages: [{ id: 'm1' }],
      providerState: {},
      sessionId: null,
    }, []);
    expect(ensureReadySpy).toHaveBeenCalledWith({ allowSessionCreation: true });
    expect(getSupportedCommandsSpy).toHaveBeenCalledTimes(1);
  });

  it('does not create a pre-session command warmup session on the bound tab runtime', async () => {
    const commands = [{ id: 'acp:review', name: 'review', content: '' }];
    const syncSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'syncConversationState').mockImplementation(() => {});
    const ensureReadySpy = jest.spyOn(OpencodeChatRuntime.prototype, 'ensureReady').mockResolvedValue(true);
    const getSupportedCommandsSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'getSupportedCommands').mockResolvedValue(commands);
    const cleanupSpy = jest.spyOn(OpencodeChatRuntime.prototype, 'cleanup').mockImplementation(() => {});
    const boundRuntime = {
      providerId: 'opencode',
      cleanup: jest.fn(),
      ensureReady: jest.fn(),
      getSupportedCommands: jest.fn(),
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
    })).resolves.toEqual(commands);

    expect(boundRuntime.syncConversationState).not.toHaveBeenCalled();
    expect(boundRuntime.ensureReady).not.toHaveBeenCalled();
    expect(boundRuntime.getSupportedCommands).not.toHaveBeenCalled();
    expect(syncSpy).toHaveBeenCalledWith({
      id: 'conv-opencode',
      messages: [{ id: 'm1' }],
      providerState: {},
      sessionId: null,
    }, []);
    expect(ensureReadySpy).toHaveBeenCalledWith({ allowSessionCreation: true });
    expect(getSupportedCommandsSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});
