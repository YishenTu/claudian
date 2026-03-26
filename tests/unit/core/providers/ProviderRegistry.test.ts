import { ProviderRegistry } from '@/core/providers';

describe('ProviderRegistry', () => {
  it('creates a runtime with the default provider id', () => {
    const runtime = ProviderRegistry.createChatRuntime({
      plugin: {} as any,
      mcpManager: {} as any,
    });

    expect(runtime.providerId).toBe('claude');
  });

  it('returns capabilities for the default provider', () => {
    const caps = ProviderRegistry.getCapabilities();
    expect(caps.providerId).toBe('claude');
    expect(caps).toHaveProperty('supportsPlanMode');
    expect(caps).toHaveProperty('supportsFork');
  });

  it('returns boundary services for the default provider', () => {
    const cliResolver = ProviderRegistry.createCliResolver();
    expect(cliResolver).toHaveProperty('resolve');
    expect(cliResolver).toHaveProperty('reset');

    const historyService = ProviderRegistry.getConversationHistoryService();
    expect(historyService).toHaveProperty('hydrateConversationHistory');

    const taskInterpreter = ProviderRegistry.getTaskResultInterpreter();
    expect(taskInterpreter).toHaveProperty('resolveTerminalStatus');
  });

  it('returns a settings reconciler for the default provider', () => {
    const reconciler = ProviderRegistry.getSettingsReconciler();
    expect(reconciler).toHaveProperty('reconcileModelWithEnvironment');
    expect(reconciler).toHaveProperty('normalizeModelVariantSettings');
  });

  it('returns a chat UI config for the default provider', () => {
    const uiConfig = ProviderRegistry.getChatUIConfig();
    expect(uiConfig).toHaveProperty('getModelOptions');
    expect(uiConfig).toHaveProperty('getCustomModelIds');
  });

  it('throws when the provider is not registered', () => {
    expect(() => ProviderRegistry.createChatRuntime({
      providerId: 'codex',
      plugin: {} as any,
      mcpManager: {} as any,
    })).toThrow('Provider "codex" is not registered.');
  });

  it('lists registered provider ids', () => {
    const ids = ProviderRegistry.getRegisteredProviderIds();
    expect(ids).toContain('claude');
  });
});
