import { ChatModelSelectionCoordinator } from '@/app/settings/ChatModelSelectionCoordinator';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { ClaudianSettings } from '@/core/types';

function createCoordinator(
  persist: (settings: ClaudianSettings) => Promise<void> = async () => undefined,
) {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  const settingsCoordinator = new SettingsCoordinator(settings, persist);
  return {
    coordinator: new ChatModelSelectionCoordinator(settingsCoordinator),
    settings,
  };
}

describe('ChatModelSelectionCoordinator', () => {
  it('commits only the newest successful intent when completions arrive out of order', async () => {
    const persisted: string[] = [];
    const { coordinator, settings } = createCoordinator(async current => {
      persisted.push(current.lastSelectedChatModel?.model ?? 'none');
    });
    const firstIntent = coordinator.beginIntent();
    const secondIntent = coordinator.beginIntent();

    await expect(coordinator.commitIntent(secondIntent, {
      providerId: 'codex',
      model: 'codex/gpt-5.2',
    })).resolves.toBe(true);
    await expect(coordinator.commitIntent(firstIntent, {
      providerId: 'claude',
      model: 'opus',
    })).resolves.toBe(false);

    expect(settings.lastSelectedChatModel).toEqual({
      providerId: 'codex',
      model: 'codex/gpt-5.2',
    });
    expect(persisted).toEqual(['codex/gpt-5.2']);
  });

  it('serializes invoked commits and lets a later intent replace an earlier durable seed', async () => {
    const persisted: string[] = [];
    const { coordinator, settings } = createCoordinator(async current => {
      persisted.push(current.lastSelectedChatModel?.model ?? 'none');
    });
    const firstIntent = coordinator.beginIntent();
    const secondIntent = coordinator.beginIntent();

    const first = coordinator.commitIntent(firstIntent, {
      providerId: 'claude',
      model: 'opus',
    });
    const second = coordinator.commitIntent(secondIntent, {
      providerId: 'codex',
      model: 'codex/gpt-5.2',
    });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(settings.lastSelectedChatModel).toEqual({
      providerId: 'codex',
      model: 'codex/gpt-5.2',
    });
    expect(persisted).toEqual(['opus', 'codex/gpt-5.2']);
  });

  it('does not advance committed order when a newer intent fails persistence', async () => {
    const persist = jest.fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);
    const { coordinator, settings } = createCoordinator(persist);
    const earlierIntent = coordinator.beginIntent();
    const failedNewerIntent = coordinator.beginIntent();

    await expect(coordinator.commitIntent(failedNewerIntent, {
      providerId: 'codex',
      model: 'codex/gpt-5.2',
    })).rejects.toThrow('disk full');
    await expect(coordinator.commitIntent(earlierIntent, {
      providerId: 'claude',
      model: 'opus',
    })).resolves.toBe(true);

    expect(settings.lastSelectedChatModel).toEqual({
      providerId: 'claude',
      model: 'opus',
    });
    expect(persist).toHaveBeenCalledTimes(2);
  });
});
