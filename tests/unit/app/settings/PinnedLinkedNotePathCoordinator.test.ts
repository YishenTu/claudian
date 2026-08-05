import { PinnedLinkedNotePathCoordinator } from '@/app/settings/PinnedLinkedNotePathCoordinator';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { ClaudianSettings } from '@/core/types';

function createFixture(initialPaths: string[] = []) {
  const settings = {
    pinnedLinkedNotePaths: [...initialPaths],
  } as ClaudianSettings;
  const persist = jest.fn().mockResolvedValue(undefined);
  const coordinator = new SettingsCoordinator(settings, persist);
  return {
    paths: new PinnedLinkedNotePathCoordinator(coordinator),
    persist,
    settings,
  };
}

describe('PinnedLinkedNotePathCoordinator', () => {
  it('adds and removes pinned paths without duplicate writes', async () => {
    const { paths, persist, settings } = createFixture(['Notes/Plan.md']);

    await expect(paths.setPinned('Notes/Plan.md', true)).resolves.toBe(false);
    await expect(paths.setPinned('Notes/Other.md', true)).resolves.toBe(true);
    await expect(paths.setPinned('Notes/Plan.md', false)).resolves.toBe(true);

    expect(settings.pinnedLinkedNotePaths).toEqual(['Notes/Other.md']);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('rewrites folder descendants and deduplicates renamed paths', async () => {
    const { paths, settings } = createFixture([
      'Notes/Standalone.md',
      'Projects/Old/Plan.md',
      'Projects/New/Plan.md',
    ]);

    await expect(paths.rewritePaths('Projects/Old', 'Projects/New', true))
      .resolves.toBe(true);

    expect(settings.pinnedLinkedNotePaths).toEqual([
      'Notes/Standalone.md',
      'Projects/New/Plan.md',
    ]);
  });

  it('removes a deleted folder and all pinned descendants', async () => {
    const { paths, settings } = createFixture([
      'Projects/Archive',
      'Projects/Archive/One.md',
      'Projects/Other.md',
    ]);

    await expect(paths.removePaths('Projects/Archive', true)).resolves.toBe(true);

    expect(settings.pinnedLinkedNotePaths).toEqual(['Projects/Other.md']);
  });
});
