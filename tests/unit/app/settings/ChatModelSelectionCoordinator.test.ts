import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';

import { ChatModelSelectionCoordinator } from '@/app/settings/ChatModelSelectionCoordinator';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { ClaudianSettings } from '@/core/types';

function createCoordinator(
  persist: (settings: ClaudianSettings) => Promise<void> = async () => undefined,
  publish?: () => void | Promise<void>,
) {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  const settingsCoordinator = new SettingsCoordinator(settings, persist, publish);
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
    }, () => true)).resolves.toBe(true);
    await expect(coordinator.commitIntent(firstIntent, {
      providerId: 'claude',
      model: 'opus',
    }, () => true)).resolves.toBe(false);

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
    }, () => true);
    const second = coordinator.commitIntent(secondIntent, {
      providerId: 'codex',
      model: 'codex/gpt-5.2',
    }, () => true);

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
    }, () => true)).rejects.toThrow('disk full');
    await expect(coordinator.commitIntent(earlierIntent, {
      providerId: 'claude',
      model: 'opus',
    }, () => true)).resolves.toBe(true);

    expect(settings.lastSelectedChatModel).toEqual({
      providerId: 'claude',
      model: 'opus',
    });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('preserves newer durable intent ordering when settings publication fails', async () => {
    const persisted: string[] = [];
    const publicationError = new Error('listener failed');
    const publish = jest.fn().mockRejectedValueOnce(publicationError);
    const { coordinator, settings } = createCoordinator(async current => {
      persisted.push(current.lastSelectedChatModel?.model ?? 'none');
    }, publish);
    const earlierIntent = coordinator.beginIntent();
    const newerIntent = coordinator.beginIntent();

    const newerCommit = coordinator.commitIntent(newerIntent, {
      providerId: 'codex',
      model: 'codex/gpt-5.2',
    }, () => true);
    const earlierCommit = coordinator.commitIntent(earlierIntent, {
      providerId: 'claude',
      model: 'opus',
    }, () => true);

    await expect(newerCommit).rejects.toMatchObject({
      cause: publicationError,
      committed: true,
      phase: 'post-commit',
    });
    await expect(earlierCommit).resolves.toBe(false);
    expect(settings.lastSelectedChatModel).toEqual({
      providerId: 'codex',
      model: 'codex/gpt-5.2',
    });
    expect(persisted).toEqual(['codex/gpt-5.2']);
  });

  it('drops an intent that loses ownership while waiting to commit', async () => {
    let releaseFirstPersist!: () => void;
    const firstPersist = new Promise<void>(resolve => {
      releaseFirstPersist = resolve;
    });
    let persistCount = 0;
    const { coordinator, settings } = createCoordinator(async () => {
      persistCount += 1;
      if (persistCount === 1) {
        await firstPersist;
      }
    });
    const firstIntent = coordinator.beginIntent();
    const staleIntent = coordinator.beginIntent();
    let staleIntentIsValid = true;

    const firstCommit = coordinator.commitIntent(firstIntent, {
      providerId: 'claude',
      model: 'opus',
    }, () => true);
    const staleCommit = coordinator.commitIntent(staleIntent, {
      providerId: 'codex',
      model: 'codex/gpt-5.2',
    }, () => staleIntentIsValid);

    await Promise.resolve();
    staleIntentIsValid = false;
    releaseFirstPersist();

    await expect(Promise.all([firstCommit, staleCommit])).resolves.toEqual([true, false]);
    expect(settings.lastSelectedChatModel).toEqual({
      providerId: 'claude',
      model: 'opus',
    });
    expect(persistCount).toBe(1);

    staleIntentIsValid = true;
    await expect(coordinator.commitIntent(staleIntent, {
      providerId: 'codex',
      model: 'codex/gpt-5.2',
    }, () => staleIntentIsValid)).resolves.toBe(true);
    expect(settings.lastSelectedChatModel?.model).toBe('codex/gpt-5.2');
    expect(persistCount).toBe(2);
  });
});
