import '@/providers';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';

describe('ProviderWorkspaceRegistry', () => {
  afterEach(() => {
    ProviderWorkspaceRegistry.clear();
  });

  it('returns agent mention providers through the workspace registry', () => {
    const claudeProvider = { searchAgents: jest.fn().mockReturnValue([]) };
    const codexProvider = { searchAgents: jest.fn().mockReturnValue([]) };

    ProviderWorkspaceRegistry.setServices('claude', {
      agentMentionProvider: claudeProvider as any,
    });
    ProviderWorkspaceRegistry.setServices('codex', {
      agentMentionProvider: codexProvider as any,
    });

    expect(ProviderWorkspaceRegistry.getAgentMentionProvider('claude')).toBe(claudeProvider);
    expect(ProviderWorkspaceRegistry.getAgentMentionProvider('codex')).toBe(codexProvider);
  });

  it('refreshes agent mention state through the workspace registry', async () => {
    const refreshClaude = jest.fn().mockResolvedValue(undefined);
    const refreshCodex = jest.fn().mockResolvedValue(undefined);

    ProviderWorkspaceRegistry.setServices('claude', {
      refreshAgentMentions: refreshClaude,
    });
    ProviderWorkspaceRegistry.setServices('codex', {
      refreshAgentMentions: refreshCodex,
    });

    await ProviderWorkspaceRegistry.refreshAgentMentions('codex');

    expect(refreshClaude).not.toHaveBeenCalled();
    expect(refreshCodex).toHaveBeenCalled();
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

    ProviderWorkspaceRegistry.setServices('claude', {
      commandCatalog: mockCatalog as any,
    });

    expect(ProviderWorkspaceRegistry.getCommandCatalog('claude')).toBe(mockCatalog);
  });

  it('returns the runtime command loader for a provider', () => {
    const runtimeCommandLoader = {
      isAvailable: jest.fn().mockReturnValue(true),
      loadCommands: jest.fn().mockResolvedValue([]),
    };

    ProviderWorkspaceRegistry.setServices('opencode', {
      runtimeCommandLoader: runtimeCommandLoader as any,
    });

    expect(ProviderWorkspaceRegistry.getRuntimeCommandLoader('opencode')).toBe(runtimeCommandLoader);
  });

  it('returns the tab warmup policy for a provider', () => {
    const tabWarmupPolicy = {
      resolveMode: jest.fn().mockReturnValue('commands'),
    };

    ProviderWorkspaceRegistry.setServices('opencode', {
      tabWarmupPolicy: tabWarmupPolicy as any,
    });

    expect(ProviderWorkspaceRegistry.getTabWarmupPolicy('opencode')).toBe(tabWarmupPolicy);
  });
});
