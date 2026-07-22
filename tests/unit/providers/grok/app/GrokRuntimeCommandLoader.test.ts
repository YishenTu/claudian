import type { ChatRuntime } from '@/core/runtime/ChatRuntime';
import type { SlashCommand } from '@/core/types';
import { GrokRuntimeCommandLoader } from '@/providers/grok/app/GrokRuntimeCommandLoader';

type TestGrokRuntime = ChatRuntime & {
  discoverSupportedCommands(timeoutMs?: number): Promise<SlashCommand[]>;
  getReadySupportedCommandsSnapshot(): SlashCommand[] | null;
};

function createContext(runtime: ChatRuntime | null = null): any {
  return {
    allowSessionCreation: true,
    conversation: null,
    externalContextPaths: ['/private/external/context'],
    plugin: {
      settings: {
        providerConfigs: {
          grok: {
            enabled: true,
            environmentVariables: 'XAI_API_KEY=secret-sentinel',
          },
        },
      },
    },
    runtime,
  };
}

function createConversation(): any {
  return {
    id: 'conversation-1',
    messages: [{ content: 'Hello', id: 'message-1', role: 'user' }],
    providerId: 'grok',
    providerState: {},
    sessionId: 'saved-session',
  };
}

function createRuntime(overrides: Partial<TestGrokRuntime> = {}): TestGrokRuntime {
  return {
    cleanup: jest.fn(),
    discoverSupportedCommands: jest.fn().mockResolvedValue([]),
    ensureReady: jest.fn().mockResolvedValue(true),
    providerId: 'grok',
    getReadySupportedCommandsSnapshot: jest.fn().mockReturnValue([]),
    getSupportedCommands: jest.fn().mockResolvedValue([]),
    isReady: jest.fn().mockReturnValue(true),
    syncConversationState: jest.fn(),
    ...overrides,
  } as unknown as TestGrokRuntime;
}

describe('GrokRuntimeCommandLoader', () => {
  it('loads exact protocol commands for a blank tab without creating a session', async () => {
    const commands = [{
      content: '',
      description: 'Run a shared skill',
      id: 'acp:repo:shared-review',
      name: 'repo:shared-review',
      source: 'sdk' as const,
    }];
    const isolatedRuntime = createRuntime({
      discoverSupportedCommands: jest.fn().mockResolvedValue(commands),
    } as Partial<ChatRuntime>);
    const createRuntimeForDiscovery = jest.fn().mockReturnValue(isolatedRuntime);
    const loader = new GrokRuntimeCommandLoader(createRuntimeForDiscovery);
    const context = createContext();

    await expect(loader.loadCommands(context)).resolves.toEqual({
      items: commands,
      status: 'ready',
    });
    expect(createRuntimeForDiscovery).toHaveBeenCalledWith(context.plugin);
    expect((isolatedRuntime as any).discoverSupportedCommands).toHaveBeenCalledTimes(1);
    expect(isolatedRuntime.ensureReady).not.toHaveBeenCalled();
    expect(isolatedRuntime.getSupportedCommands).not.toHaveBeenCalled();
    expect(isolatedRuntime.cleanup).toHaveBeenCalledTimes(1);
  });

  it('uses pre-session discovery on a matching runtime that has no ready snapshot', async () => {
    const runtime = createRuntime({
      discoverSupportedCommands: jest.fn().mockResolvedValue([
        { content: '', id: 'acp:review', name: 'review', source: 'sdk' },
      ]),
      getReadySupportedCommandsSnapshot: jest.fn().mockReturnValue(null),
    } as Partial<ChatRuntime>);

    await expect(new GrokRuntimeCommandLoader().loadCommands(createContext(runtime)))
      .resolves.toEqual({
        items: [{ content: '', id: 'acp:review', name: 'review', source: 'sdk' }],
        status: 'ready',
      });
    expect((runtime as any).discoverSupportedCommands).toHaveBeenCalledTimes(1);
    expect(runtime.getSupportedCommands).not.toHaveBeenCalled();
  });

  it('loads exact protocol commands for a restored session without reloading that session', async () => {
    const commands = [
      {
        content: '',
        description: 'Run a shared skill',
        id: 'acp:skill:nanobanana',
        name: 'skill:nanobanana',
        source: 'sdk' as const,
      },
    ];
    const isolatedRuntime = createRuntime({
      discoverSupportedCommands: jest.fn().mockResolvedValue(commands),
      cleanup: jest.fn(),
    });
    const createRuntimeForDiscovery = jest.fn().mockReturnValue(isolatedRuntime);
    const context = createContext();
    context.conversation = createConversation();

    await expect(
      new GrokRuntimeCommandLoader(createRuntimeForDiscovery).loadCommands(context),
    ).resolves.toEqual({ items: commands, status: 'ready' });

    expect(createRuntimeForDiscovery).toHaveBeenCalledWith(context.plugin);
    expect((isolatedRuntime as any).discoverSupportedCommands).toHaveBeenCalledTimes(1);
    expect(isolatedRuntime.syncConversationState).not.toHaveBeenCalled();
    expect(isolatedRuntime.ensureReady).not.toHaveBeenCalled();
    expect(isolatedRuntime.getSupportedCommands).not.toHaveBeenCalled();
    expect(isolatedRuntime.cleanup).toHaveBeenCalledTimes(1);
  });

  it('discovers commands for a conversation without a native session', async () => {
    const isolatedRuntime = createRuntime();
    const createRuntimeForDiscovery = jest.fn().mockReturnValue(isolatedRuntime);
    const context = createContext();
    context.conversation = { ...createConversation(), sessionId: null };

    await expect(
      new GrokRuntimeCommandLoader(createRuntimeForDiscovery).loadCommands(context),
    ).resolves.toEqual({ status: 'empty' });
    expect(createRuntimeForDiscovery).toHaveBeenCalledTimes(1);
    expect((isolatedRuntime as any).discoverSupportedCommands).toHaveBeenCalledTimes(1);
  });

  it('returns exact protocol commands from an already-ready matching runtime', async () => {
    const commands = [
      {
        argumentHint: '[focus]',
        content: '',
        description: 'Review changes',
        id: 'acp:local:review',
        name: 'local:review',
        source: 'sdk' as const,
      },
    ];
    const runtime = createRuntime({
      getReadySupportedCommandsSnapshot: jest.fn().mockReturnValue(commands),
    } as Partial<ChatRuntime>);

    await expect(new GrokRuntimeCommandLoader().loadCommands(createContext(runtime)))
      .resolves.toEqual({ status: 'ready', items: commands });
    expect((runtime as any).getReadySupportedCommandsSnapshot).toHaveBeenCalledTimes(1);
    expect(runtime.getSupportedCommands).not.toHaveBeenCalled();
  });

  it('distinguishes an authoritative empty ready-runtime snapshot', async () => {
    const runtime = createRuntime();

    await expect(new GrokRuntimeCommandLoader().loadCommands(createContext(runtime)))
      .resolves.toEqual({ status: 'empty' });
  });

  it('rejects a ready runtime owned by another provider without querying it', async () => {
    const runtime = createRuntime({ providerId: 'opencode' });
    const isolatedRuntime = createRuntime();
    const createRuntimeForDiscovery = jest.fn().mockReturnValue(isolatedRuntime);

    await expect(new GrokRuntimeCommandLoader(createRuntimeForDiscovery)
      .loadCommands(createContext(runtime)))
      .resolves.toEqual({ status: 'empty' });
    expect(createRuntimeForDiscovery).toHaveBeenCalledTimes(1);
    expect(runtime.getSupportedCommands).not.toHaveBeenCalled();
  });

  it('returns a sanitized retryable error when a ready runtime snapshot fails', async () => {
    const runtime = createRuntime({
      getReadySupportedCommandsSnapshot: jest.fn().mockImplementation(() => {
        throw new Error('XAI_API_KEY=secret-sentinel');
      }),
      getSupportedCommands: jest.fn().mockRejectedValue(
        new Error('XAI_API_KEY=secret-sentinel'),
      ),
    } as Partial<ChatRuntime>);

    const result = await new GrokRuntimeCommandLoader().loadCommands(createContext(runtime));

    expect(result).toEqual({
      message: 'Could not read Grok skills and commands from the active conversation.',
      retryable: true,
      status: 'error',
    });
    expect(JSON.stringify(result)).not.toContain('secret-sentinel');
  });

  it('uses only allowlisted non-secret state in its cache fingerprint', () => {
    const loader = new GrokRuntimeCommandLoader();
    const first = createContext().plugin.settings as Record<string, unknown>;
    const second = createContext().plugin.settings as Record<string, unknown>;
    (second.providerConfigs as any).grok.environmentVariables =
      'XAI_API_KEY=different-secret-sentinel';
    (second.providerConfigs as any).grok.runtimeAuthToken = 'raw-auth-sentinel';

    const firstFingerprint = loader.getCacheFingerprint(first);
    const secondFingerprint = loader.getCacheFingerprint(second);

    expect(firstFingerprint).toBe(secondFingerprint);
    expect(firstFingerprint).toBe('grok:commands:v2:enabled:auto-cli');
    expect(firstFingerprint).not.toContain('secret-sentinel');
    expect(firstFingerprint).not.toContain('raw-auth-sentinel');
  });

  it('reports availability from the provider enablement flag only', () => {
    const loader = new GrokRuntimeCommandLoader();
    const enabled = createContext().plugin.settings as Record<string, unknown>;
    const disabled = createContext().plugin.settings as Record<string, unknown>;
    (disabled.providerConfigs as any).grok.enabled = false;

    expect(loader.isAvailable(enabled)).toBe(true);
    expect(loader.isAvailable(disabled)).toBe(false);
    expect(loader.getCacheFingerprint(disabled)).toBe(
      'grok:commands:v2:disabled:auto-cli',
    );
  });

  it('represents configured CLI selection without retaining its path', () => {
    const loader = new GrokRuntimeCommandLoader();
    const first = createContext().plugin.settings as Record<string, unknown>;
    const second = createContext().plugin.settings as Record<string, unknown>;
    (first.providerConfigs as any).grok.cliPath = '/private/secret-sentinel/grok';
    (second.providerConfigs as any).grok.cliPath = '/different/raw-path-sentinel/grok';

    const firstFingerprint = loader.getCacheFingerprint(first);
    const secondFingerprint = loader.getCacheFingerprint(second);

    expect(firstFingerprint).toBe(secondFingerprint);
    expect(firstFingerprint).toBe('grok:commands:v2:enabled:configured-cli');
    expect(firstFingerprint).not.toContain('/private');
    expect(firstFingerprint).not.toContain('secret-sentinel');
    expect(firstFingerprint).not.toContain('raw-path-sentinel');
  });
});
