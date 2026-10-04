import { AgentSkillResources } from '@/composition/AgentSkillResources';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { BUILT_IN_PROVIDER_MODULES } from '@/providers';

describe('AgentSkillResources', () => {
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
    const resources = new AgentSkillResources(() => [{ invalidateProviderResources }]);

    const pending = resources.notifyChanged();

    expect(resources.getGeneration()).toBe(1);
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
    await new AgentSkillResources(() => [{ invalidateProviderResources }]).notifyChanged();
    const [ids] = invalidateProviderResources.mock.calls[0];
    expect(ids).toContain('test-skills');
    expect(ids).toContain('test-lazy');
    expect(ids).not.toContain('test-unrelated');
    expect(initialize).not.toHaveBeenCalled();
    expect(onAgentSkillsChanged).toHaveBeenCalledTimes(1);
  });
});
