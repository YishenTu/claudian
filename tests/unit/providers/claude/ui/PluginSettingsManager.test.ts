import { Notice } from 'obsidian';

import { NotifiedMutationError } from '@/core/storage/NotifiedMutationError';
import { PluginSettingsManager } from '@/providers/claude/ui/PluginSettingsManager';

describe('PluginSettingsManager persistence failure', () => {
  it('does not toggle a second time or duplicate a storage-owned Notice', async () => {
    const togglePlugin = jest.fn().mockRejectedValue(
      new NotifiedMutationError(
        'Failed to update .claude/settings.json because it contains invalid JSON.',
      ),
    );
    const manager = Object.create(PluginSettingsManager.prototype) as PluginSettingsManager;
    Object.assign(manager, {
      pluginManager: {
        getPlugins: jest.fn().mockReturnValue([{ id: 'alpha', enabled: true }]),
        togglePlugin,
      },
      agentManager: { loadAgents: jest.fn() },
      restartTabs: jest.fn(),
      render: jest.fn(),
    });

    await (manager as unknown as { togglePlugin: (id: string) => Promise<void> })
      .togglePlugin('alpha');

    expect(togglePlugin).toHaveBeenCalledTimes(1);
    expect(Notice).not.toHaveBeenCalled();
  });

  it('rolls back a persisted toggle when dependent agent loading fails', async () => {
    const togglePlugin = jest.fn().mockResolvedValue(undefined);
    const manager = Object.create(PluginSettingsManager.prototype) as PluginSettingsManager;
    Object.assign(manager, {
      pluginManager: {
        getPlugins: jest.fn().mockReturnValue([{ id: 'alpha', enabled: true }]),
        togglePlugin,
      },
      agentManager: { loadAgents: jest.fn().mockRejectedValue(new Error('agent load failed')) },
      restartTabs: jest.fn(),
      render: jest.fn(),
    });

    await (manager as unknown as { togglePlugin: (id: string) => Promise<void> })
      .togglePlugin('alpha');

    expect(togglePlugin).toHaveBeenCalledTimes(2);
    expect(Notice).toHaveBeenCalledWith('Failed to toggle plugin: agent load failed');
  });
});
