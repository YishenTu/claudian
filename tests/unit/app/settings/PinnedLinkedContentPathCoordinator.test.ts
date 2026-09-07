import { PinnedLinkedContentPathCoordinator } from '@/app/settings/PinnedLinkedContentPathCoordinator';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { ClaudianSettings } from '@/core/types';

function createFixture(
  initialPaths: string[] = [],
  persist = jest.fn().mockResolvedValue(undefined),
) {
  const settings = {
    pinnedLinkedContentPaths: [...initialPaths],
  } as ClaudianSettings;
  const coordinator = new SettingsCoordinator(settings, persist);
  return {
    paths: new PinnedLinkedContentPathCoordinator(coordinator),
    persist,
    settings,
  };
}

describe('PinnedLinkedContentPathCoordinator', () => {
  it('adds and removes normalized pinned paths without duplicate writes', async () => {
    const { paths, persist, settings } = createFixture(['Notes/Plan.md']);

    await expect(paths.setPinned('./Notes/Plan.md', true)).resolves.toBe(false);
    await expect(paths.setPinned('Notes\\Other.md', true)).resolves.toBe(true);
    await expect(paths.setPinned('Notes/Plan.md', false)).resolves.toBe(true);

    expect(settings.pinnedLinkedContentPaths).toEqual(['Notes/Other.md']);
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

    expect(settings.pinnedLinkedContentPaths).toEqual([
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

    expect(settings.pinnedLinkedContentPaths).toEqual(['Projects/Other.md']);
  });

  it('rolls back a failed write before the next pinned-path mutation', async () => {
    const persist = jest.fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce(undefined);
    const { paths, settings } = createFixture(['Notes/Plan.md'], persist);

    const first = paths.setPinned('Notes/Failed.md', true);
    const second = paths.setPinned('Notes/Next.md', true);

    await expect(first).rejects.toThrow('write failed');
    await expect(second).resolves.toBe(true);
    expect(settings.pinnedLinkedContentPaths).toEqual([
      'Notes/Plan.md',
      'Notes/Next.md',
    ]);
    expect(persist).toHaveBeenCalledTimes(2);
  });
});
