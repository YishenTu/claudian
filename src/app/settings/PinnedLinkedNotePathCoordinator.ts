import type { ClaudianSettings } from '../../core/types';
import type { SettingsCoordinator } from './SettingsCoordinator';

export class PinnedLinkedNotePathCoordinator {
  constructor(
    private readonly settingsCoordinator: SettingsCoordinator<ClaudianSettings>,
  ) {}

  async setPinned(notePath: string, isPinned: boolean): Promise<boolean> {
    let changed = false;
    await this.settingsCoordinator.mutateConditionally((settings) => {
      const pinnedPaths = new Set(settings.pinnedLinkedNotePaths ?? []);
      if (isPinned) {
        if (pinnedPaths.has(notePath)) return false;
        pinnedPaths.add(notePath);
      } else if (!pinnedPaths.delete(notePath)) {
        return false;
      }

      settings.pinnedLinkedNotePaths = [...pinnedPaths];
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
    let changed = false;
    await this.settingsCoordinator.mutateConditionally((settings) => {
      const oldPrefix = `${oldPath.replace(/\/$/, '')}/`;
      const newPrefix = `${newPath.replace(/\/$/, '')}/`;
      const currentPaths = settings.pinnedLinkedNotePaths ?? [];
      const rewrittenPaths = currentPaths.map((path) => {
        if (path === oldPath) return newPath;
        if (includeDescendants && path.startsWith(oldPrefix)) {
          return `${newPrefix}${path.slice(oldPrefix.length)}`;
        }
        return path;
      });
      const deduplicatedPaths = [...new Set(rewrittenPaths)];
      changed = deduplicatedPaths.length !== currentPaths.length
        || deduplicatedPaths.some((path, index) => path !== currentPaths[index]);
      if (!changed) return false;

      settings.pinnedLinkedNotePaths = deduplicatedPaths;
      return true;
    });
    return changed;
  }

  async removePaths(
    deletedPath: string,
    includeDescendants: boolean,
  ): Promise<boolean> {
    let changed = false;
    await this.settingsCoordinator.mutateConditionally((settings) => {
      const deletedPrefix = `${deletedPath.replace(/\/$/, '')}/`;
      const currentPaths = settings.pinnedLinkedNotePaths ?? [];
      const retainedPaths = currentPaths.filter(path => (
        path !== deletedPath
        && !(includeDescendants && path.startsWith(deletedPrefix))
      ));
      changed = retainedPaths.length !== currentPaths.length;
      if (!changed) return false;

      settings.pinnedLinkedNotePaths = retainedPaths;
      return true;
    });
    return changed;
  }
}
