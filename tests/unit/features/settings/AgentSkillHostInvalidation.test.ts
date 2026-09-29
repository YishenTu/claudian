import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import ClaudianPlugin from '@/main';
import { BUILT_IN_PROVIDER_MODULES } from '@/providers';

describe('agent skill host invalidation', () => {
  beforeEach(() => {
    for (const provider of BUILT_IN_PROVIDER_MODULES) {
      ProviderWorkspaceRegistry.register(provider.id, provider.workspace);
    }
  });

  afterEach(() => {
    ProviderWorkspaceRegistry.clear();
  });

  it('publishes the new generation synchronously before Codex refresh settles', async () => {
    let finishRefresh!: () => void;
    const refresh = jest.fn().mockReturnValue(new Promise<void>(resolve => {
      finishRefresh = resolve;
    }));
    ProviderWorkspaceRegistry.setServices('codex', {
      onAgentSkillsChanged: refresh,
    });
    const invalidateProviderResources = jest.fn();
    const plugin = {
      agentSkillResourceGeneration: 0,
      getAllViews: jest.fn().mockReturnValue([{ invalidateProviderResources }]),
    };

    const pending = ClaudianPlugin.prototype.notifyAgentSkillsChanged.call(plugin as any);

    expect(plugin.agentSkillResourceGeneration).toBe(1);
    expect(invalidateProviderResources).toHaveBeenCalledWith(
      expect.arrayContaining(['codex', 'grok', 'pi', 'opencode']),
      1,
    );
    expect(invalidateProviderResources.mock.calls[0][0]).not.toContain('claude');
    expect(refresh).toHaveBeenCalledTimes(1);

    finishRefresh();
    await expect(pending).resolves.toBeUndefined();
  });

  it('invalidates registered skill consumers without initializing their workspaces', async () => {
    const initialize = jest.fn();
    const onAgentSkillsChanged = jest.fn();
    ProviderWorkspaceRegistry.register('test-skills', { consumesAgentSkills: true, initialize });
    ProviderWorkspaceRegistry.register('test-lazy', { consumesAgentSkills: true, initialize });
    ProviderWorkspaceRegistry.register('test-unrelated', { initialize });
    ProviderWorkspaceRegistry.setServices('test-skills', { onAgentSkillsChanged });
    const invalidateProviderResources = jest.fn();
    const plugin = {
      agentSkillResourceGeneration: 0,
      getAllViews: () => [{ invalidateProviderResources }],
    };
    await ClaudianPlugin.prototype.notifyAgentSkillsChanged.call(plugin as any);
    const [ids] = invalidateProviderResources.mock.calls[0];
    expect(ids).toContain('test-skills');
    expect(ids).toContain('test-lazy');
    expect(ids).not.toContain('test-unrelated');
    expect(initialize).not.toHaveBeenCalled();
    expect(onAgentSkillsChanged).toHaveBeenCalledTimes(1);
  });

  it('does not touch skill storage until the Skills tab is opened', () => {
    const getAdapter = jest.fn().mockReturnValue({});
    const plugin = {
      storage: { getAdapter },
      notifyAgentSkillsChanged: jest.fn(),
    };

    new ClaudianSettingTab({} as any, plugin as any);

    expect(getAdapter).not.toHaveBeenCalled();
  });
});
