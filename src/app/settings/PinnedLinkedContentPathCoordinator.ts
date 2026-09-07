import { normalizeLinkedContentPath } from '../../core/path/LinkedContentPath';
import type { ClaudianSettings } from '../../core/types';
import type { SettingsCoordinator } from './SettingsCoordinator';

export class PinnedLinkedContentPathCoordinator {
  constructor(
    private readonly settingsCoordinator: SettingsCoordinator<ClaudianSettings>,
  ) {}

  async setPinned(contentPath: string, isPinned: boolean): Promise<boolean> {
    const normalizedPath = normalizeLinkedContentPath(contentPath);
    if (normalizedPath === null) return false;

    let changed = false;
    await this.settingsCoordinator.mutateConditionally((settings) => {
      const pinnedPaths = new Set(settings.pinnedLinkedContentPaths ?? []);
      if (isPinned) {
        if (pinnedPaths.has(normalizedPath)) return false;
        pinnedPaths.add(normalizedPath);
      } else if (!pinnedPaths.delete(normalizedPath)) {
        return false;
      }

      settings.pinnedLinkedContentPaths = [...pinnedPaths];
      changed = true;
      return true;
    });
    return changed;
  }

  async rewritePaths(
    oldPath: string,
    newPath: string,
    includeDescendants: boolean,
  ): Promise<boolean> {
    const normalizedOldPath = normalizeLinkedContentPath(oldPath);
    const normalizedNewPath = normalizeLinkedContentPath(newPath);
    if (
      normalizedOldPath === null
      || normalizedNewPath === null
      || normalizedOldPath === normalizedNewPath
    ) {
      return false;
    }

    let changed = false;
    await this.settingsCoordinator.mutateConditionally((settings) => {
      const oldPrefix = `${normalizedOldPath.replace(/\/$/, '')}/`;
      const newPrefix = `${normalizedNewPath.replace(/\/$/, '')}/`;
      const currentPaths = settings.pinnedLinkedContentPaths ?? [];
      const rewrittenPaths = currentPaths.map((path) => {
        if (path === normalizedOldPath) return normalizedNewPath;
        if (includeDescendants && path.startsWith(oldPrefix)) {
          return `${newPrefix}${path.slice(oldPrefix.length)}`;
        }
        return path;
      });
      const deduplicatedPaths = [...new Set(rewrittenPaths)];
      changed = deduplicatedPaths.length !== currentPaths.length
        || deduplicatedPaths.some((path, index) => path !== currentPaths[index]);
      if (!changed) return false;

      settings.pinnedLinkedContentPaths = deduplicatedPaths;
      return true;
    });
    return changed;
  }

  async removePaths(
    deletedPath: string,
    includeDescendants: boolean,
  ): Promise<boolean> {
    const normalizedDeletedPath = normalizeLinkedContentPath(deletedPath);
    if (normalizedDeletedPath === null) return false;

    let changed = false;
    await this.settingsCoordinator.mutateConditionally((settings) => {
      const deletedPrefix = `${normalizedDeletedPath.replace(/\/$/, '')}/`;
      const currentPaths = settings.pinnedLinkedContentPaths ?? [];
      const retainedPaths = currentPaths.filter(path => (
        path !== normalizedDeletedPath
        && !(includeDescendants && path.startsWith(deletedPrefix))
      ));
      changed = retainedPaths.length !== currentPaths.length;
      if (!changed) return false;

      settings.pinnedLinkedContentPaths = retainedPaths;
      return true;
    });
    return changed;
  }
}
