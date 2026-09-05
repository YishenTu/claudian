import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { syncComposerDropdownForProvider } from '@/features/chat/tabs/TabProviderState';

jest.mock('@/core/providers/ProviderWorkspaceRegistry', () => ({
  ProviderWorkspaceRegistry: {
    getCommandCatalog: jest.fn(),
  },
}));

describe('TabProviderState provider command discovery', () => {
  it('requests provider built-ins from the Main Chat fallback catalog', async () => {
    const listDropdownEntries = jest.fn().mockResolvedValue([]);
    (ProviderWorkspaceRegistry.getCommandCatalog as jest.Mock).mockReturnValue({
      getDropdownConfig: jest.fn().mockReturnValue({
        builtInPrefix: '/',
        commandPrefix: '/',
        providerId: 'codex',
        skillPrefix: '$',
        triggerChars: ['/', '$'],
      }),
      listDropdownEntries,
    });
    let discovery: { load(): Promise<unknown> } | undefined;
    const composerDropdown = {
      clearProviderCatalog: jest.fn(),
      setHiddenCommands: jest.fn(),
      setProviderCatalog: jest.fn((_config, nextDiscovery) => {
        discovery = nextDiscovery;
      }),
      setProviderId: jest.fn(),
    };
    const tab = {
      conversationId: null,
      draftModel: null,
      lifecycleState: 'cold',
      providerCatalogResolver: () => null,
      providerId: 'codex',
      ui: { composerDropdown },
    } as any;
    const plugin = {
      getConversationSync: jest.fn().mockReturnValue(null),
      settings: { hiddenProviderCommands: {} },
    } as any;

    syncComposerDropdownForProvider(tab, plugin);
    await discovery?.load();

    expect(listDropdownEntries).toHaveBeenCalledWith(expect.objectContaining({
      includeBuiltIns: true,
    }));
  });
});
