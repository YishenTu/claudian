import { ProviderRegistry } from '@/core/providers/ProviderRegistry';

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

  it('throws when an unknown provider is requested', () => {
    expect(() => ProviderRegistry.getCapabilities(
      'nonexistent' as any,
    )).toThrow('Provider "nonexistent" is not registered.');
  });

  it('creates a Codex runtime', () => {
    const runtime = ProviderRegistry.createChatRuntime({
      providerId: 'codex',
      plugin: {} as any,
      mcpManager: {} as any,
    });
    expect(runtime.providerId).toBe('codex');
  });

  it('returns Codex capabilities', () => {
    const caps = ProviderRegistry.getCapabilities('codex');
    expect(caps.providerId).toBe('codex');
    expect(caps.supportsPlanMode).toBe(false);
    expect(caps.supportsFork).toBe(false);
    expect(caps.supportsRewind).toBe(false);
    expect(caps.reasoningControl).toBe('effort');
  });

  it('lists registered provider ids', () => {
    const ids = ProviderRegistry.getRegisteredProviderIds();
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
  });

  describe('command catalogs', () => {
    it('returns null when no catalog is assigned', () => {
      expect(typeof ProviderRegistry.getCommandCatalog).toBe('function');
    });

    it('returns the assigned catalog for a provider', () => {
      const mockCatalog = {
        listDropdownEntries: jest.fn(),
        listVaultEntries: jest.fn(),
        saveVaultEntry: jest.fn(),
        deleteVaultEntry: jest.fn(),
        setRuntimeCommands: jest.fn(),
        getDropdownConfig: jest.fn(),
        refresh: jest.fn(),
      };

      ProviderRegistry.setCommandCatalog('claude', mockCatalog as any);
      expect(ProviderRegistry.getCommandCatalog('claude')).toBe(mockCatalog);

      // Cleanup
      ProviderRegistry.setCommandCatalog('claude', undefined);
    });

    it('shared code accesses catalogs through registry, not provider-specific imports', () => {
      const mockCatalog = {
        listDropdownEntries: jest.fn(),
        listVaultEntries: jest.fn(),
        saveVaultEntry: jest.fn(),
        deleteVaultEntry: jest.fn(),
        setRuntimeCommands: jest.fn(),
        getDropdownConfig: jest.fn(),
        refresh: jest.fn(),
      };
      ProviderRegistry.setCommandCatalog('claude', mockCatalog as any);

      const catalog = ProviderRegistry.getCommandCatalog('claude');
      expect(catalog).toBe(mockCatalog);
      expect(typeof catalog!.listDropdownEntries).toBe('function');
      expect(typeof catalog!.getDropdownConfig).toBe('function');

      ProviderRegistry.setCommandCatalog('claude', undefined);
    });
  });
});
