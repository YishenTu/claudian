import type { SlashCommand } from '@/core/types';
import { KimiRuntimeCommandLoader } from '@/providers/kimi/app/KimiRuntimeCommandLoader';
import { KimiChatRuntime } from '@/providers/kimi/runtime/KimiChatRuntime';

jest.mock('@/providers/kimi/runtime/KimiChatRuntime');

const MockKimiChatRuntime = KimiChatRuntime as jest.MockedClass<typeof KimiChatRuntime>;

type FakeRuntime = {
  cleanup: jest.Mock;
  discoverSupportedCommands: jest.Mock;
  ensureReady: jest.Mock;
  providerId: string;
  syncConversationState: jest.Mock;
};

function createFakeRuntime(overrides: Partial<FakeRuntime> = {}): FakeRuntime {
  return {
    cleanup: jest.fn(),
    discoverSupportedCommands: jest.fn().mockResolvedValue([]),
    ensureReady: jest.fn().mockResolvedValue(true),
    providerId: 'kimi',
    syncConversationState: jest.fn(),
    ...overrides,
  };
}

function createContext(overrides: Record<string, unknown> = {}): any {
  return {
    allowSessionCreation: true,
    conversation: null,
    plugin: {
      settings: {
        providerConfigs: { kimi: { enabled: true } },
      },
    },
    runtime: null,
    ...overrides,
  };
}

function createConversation(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'conversation-1',
    messages: [],
    providerId: 'kimi',
    providerState: {},
    sessionId: 'session-saved',
    ...overrides,
  };
}

const COMMANDS: SlashCommand[] = [{
  content: '',
  description: 'Review changes',
  id: 'acp:review',
  name: 'review',
  source: 'sdk',
}];

describe('KimiRuntimeCommandLoader', () => {
  let isolatedRuntime: FakeRuntime;

  beforeEach(() => {
    jest.clearAllMocks();
    isolatedRuntime = createFakeRuntime({
      discoverSupportedCommands: jest.fn().mockResolvedValue(COMMANDS),
    });
    MockKimiChatRuntime.mockImplementation(() => isolatedRuntime as unknown as KimiChatRuntime);
  });

  it('warms a blank tab on an isolated runtime and cleans it up', async () => {
    const loader = new KimiRuntimeCommandLoader();
    const context = createContext();

    await expect(loader.loadCommands(context)).resolves.toEqual({
      items: COMMANDS,
      status: 'ready',
    });

    expect(MockKimiChatRuntime).toHaveBeenCalledWith(context.plugin);
    expect(isolatedRuntime.syncConversationState).toHaveBeenCalledWith(null);
    expect(isolatedRuntime.ensureReady).toHaveBeenCalledWith({ allowSessionCreation: true });
    expect(isolatedRuntime.discoverSupportedCommands).toHaveBeenCalledWith(5_000);
    expect(isolatedRuntime.cleanup).toHaveBeenCalledTimes(1);
  });

  it('reports a retryable error when the tab state cannot warm a session', async () => {
    const loader = new KimiRuntimeCommandLoader();

    await expect(loader.loadCommands(createContext({ allowSessionCreation: false })))
      .resolves.toEqual({
        message: 'Kimi command discovery is unavailable for this tab state.',
        retryable: true,
        status: 'error',
      });
    expect(MockKimiChatRuntime).not.toHaveBeenCalled();
  });

  it('warms a pre-session conversation with messages on an isolated runtime', async () => {
    const boundRuntime = createFakeRuntime();
    const conversation = createConversation({
      messages: [{ content: 'Hello', id: 'message-1', role: 'user' }],
      sessionId: null,
    });
    const loader = new KimiRuntimeCommandLoader();

    await expect(loader.loadCommands(createContext({
      conversation,
      runtime: boundRuntime,
    }))).resolves.toEqual({ items: COMMANDS, status: 'ready' });

    expect(MockKimiChatRuntime).toHaveBeenCalledTimes(1);
    expect(isolatedRuntime.syncConversationState).toHaveBeenCalledWith(null);
    expect(isolatedRuntime.ensureReady).toHaveBeenCalledWith({ allowSessionCreation: true });
    expect(isolatedRuntime.cleanup).toHaveBeenCalledTimes(1);
    expect(boundRuntime.syncConversationState).not.toHaveBeenCalled();
    expect(boundRuntime.ensureReady).not.toHaveBeenCalled();
    expect(boundRuntime.cleanup).not.toHaveBeenCalled();
  });

  it('reuses the bound kimi runtime for a session-bound conversation', async () => {
    const boundRuntime = createFakeRuntime({
      discoverSupportedCommands: jest.fn().mockResolvedValue(COMMANDS),
    });
    const conversation = createConversation();
    const loader = new KimiRuntimeCommandLoader();

    await expect(loader.loadCommands(createContext({
      conversation,
      runtime: boundRuntime,
    }))).resolves.toEqual({ items: COMMANDS, status: 'ready' });

    expect(MockKimiChatRuntime).not.toHaveBeenCalled();
    expect(boundRuntime.syncConversationState).toHaveBeenCalledWith(conversation);
    expect(boundRuntime.ensureReady).toHaveBeenCalledWith({ allowSessionCreation: false });
    expect(boundRuntime.cleanup).not.toHaveBeenCalled();
  });

  it('warms a session-bound conversation on an isolated runtime when none is bound', async () => {
    const conversation = createConversation();
    const loader = new KimiRuntimeCommandLoader();

    await expect(loader.loadCommands(createContext({ conversation })))
      .resolves.toEqual({ items: COMMANDS, status: 'ready' });

    expect(MockKimiChatRuntime).toHaveBeenCalledTimes(1);
    expect(isolatedRuntime.syncConversationState).toHaveBeenCalledWith(conversation);
    expect(isolatedRuntime.ensureReady).toHaveBeenCalledWith({ allowSessionCreation: false });
    expect(isolatedRuntime.cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects a bound runtime owned by another provider without querying it', async () => {
    const foreignRuntime = createFakeRuntime({ providerId: 'opencode' });
    const conversation = createConversation();
    const loader = new KimiRuntimeCommandLoader();

    await expect(loader.loadCommands(createContext({
      conversation,
      runtime: foreignRuntime,
    }))).resolves.toEqual({ items: COMMANDS, status: 'ready' });

    expect(foreignRuntime.syncConversationState).not.toHaveBeenCalled();
    expect(MockKimiChatRuntime).toHaveBeenCalledTimes(1);
    expect(isolatedRuntime.cleanup).toHaveBeenCalledTimes(1);
  });

  it('returns a sanitized retryable error when readiness fails', async () => {
    isolatedRuntime.ensureReady.mockResolvedValue(false);
    const loader = new KimiRuntimeCommandLoader();

    await expect(loader.loadCommands(createContext())).resolves.toEqual({
      message: 'Could not load Kimi commands.',
      retryable: true,
      status: 'error',
    });
    expect(isolatedRuntime.cleanup).toHaveBeenCalledTimes(1);
  });

  it('returns an empty result when the runtime advertises no commands', async () => {
    isolatedRuntime.discoverSupportedCommands.mockResolvedValue([]);
    const loader = new KimiRuntimeCommandLoader();

    await expect(loader.loadCommands(createContext())).resolves.toEqual({ status: 'empty' });
  });

  it('cleans up the isolated runtime when discovery is aborted', async () => {
    const abortController = new AbortController();
    isolatedRuntime.discoverSupportedCommands.mockImplementation(
      (_timeoutMs: number, signal?: AbortSignal) => new Promise<SlashCommand[]>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    );
    isolatedRuntime.ensureReady.mockImplementation(async () => {
      await new Promise(resolve => setImmediate(resolve));
      return true;
    });
    const context = createContext({ signal: abortController.signal });
    const loader = new KimiRuntimeCommandLoader();

    const discovery = loader.loadCommands(context);
    abortController.abort();

    await expect(discovery).resolves.toEqual({
      message: 'Could not load Kimi commands.',
      retryable: true,
      status: 'error',
    });
    expect(isolatedRuntime.cleanup).toHaveBeenCalledTimes(1);
  });

  it('fingerprints only the enablement flag and reports availability from it', () => {
    const loader = new KimiRuntimeCommandLoader();
    const enabled = createContext().plugin.settings as Record<string, unknown>;
    const disabled = createContext().plugin.settings as Record<string, unknown>;
    (disabled.providerConfigs as Record<string, Record<string, unknown>>).kimi.enabled = false;
    (disabled.providerConfigs as Record<string, Record<string, unknown>>).kimi
      .environmentVariables = 'KIMI_API_KEY=secret-sentinel';

    expect(loader.isAvailable(enabled)).toBe(true);
    expect(loader.isAvailable(disabled)).toBe(false);
    expect(loader.getCacheFingerprint(enabled)).toBe('kimi:commands:v1:enabled');
    expect(loader.getCacheFingerprint(disabled)).toBe('kimi:commands:v1:disabled');
    expect(loader.getCacheFingerprint(disabled)).not.toContain('secret-sentinel');
  });
});
