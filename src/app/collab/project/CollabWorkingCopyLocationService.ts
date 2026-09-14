import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { CollabProjectId } from '@claudian-collab/protocol';

import type { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { resolveCollabVaultPath } from '@/app/collab/CollabFilesystemBoundary';
import type { CollabLocalMembershipRecord, CollabWorkingCopyLocationUpdate } from '@/app/collab/CollabLocalProjectRepository';
import { decodeCollabPendingProjectOperation } from '@/app/collab/PendingProjectOperation';
import { isCollabWorkingCopyDirectoryName } from '@/app/collab/project/CollabWorkingCopySlug';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabWorkingCopyRenameHint {
  readonly oldPath: string;
  readonly newPath: string;
}

interface LocationOptions {
  readonly vaultRoot: string;
  readonly transitionProject: (projectId: CollabProjectId, operation: () => Promise<void>) => Promise<void>;
}

function locationError(reason: string): CollabError {
  return new CollabError({ code: 'workspace-boundary-invalid', recoveryActions: ['retry', 'open-diagnostics'], safeContext: { reason } });
}

/** Reconciles observed directory locations; the filesystem rename remains owned by Obsidian. */
export class CollabWorkingCopyLocationService {
  readonly #queue = new SerialTaskQueue();

  constructor(private readonly foundation: Pick<ClaudianCollabService, 'local' | 'requireGitFoundation'>, private readonly options: LocationOptions) {}

  reconcile(hint?: CollabWorkingCopyRenameHint): Promise<readonly CollabProjectId[]> {
    return this.#queue.run(async () => {
      const projects = this.foundation.local.projects;
      const index = await projects.loadIndex();
      const changed: CollabProjectId[] = [];
      let failure: Error | undefined;
      const rememberFailure = (error: unknown) => { failure ??= error instanceof Error ? error : locationError('working-copy-location-reconciliation-failed'); };
      const candidates: CollabProjectId[] = [];
      const parents = hint ? new Set([path.posix.dirname(hint.oldPath), path.posix.dirname(hint.newPath)]) : null;
      for (const entry of index.projects) {
        if ((entry.lifecycle && entry.lifecycle !== 'active') || (parents && !parents.has(path.posix.dirname(entry.workspacePath)))) continue;
        try {
          const membership = await projects.loadMembership(entry.id);
          if (!membership || (membership.lifecycle && membership.lifecycle !== 'active')) continue;
          if (entry.workspacePath === membership.project.workspacePath && await this.#matches(membership.project.workspacePath, membership)) continue;
          candidates.push(entry.id);
        } catch (error) { rememberFailure(error); }
      }
      const held: CollabProjectId[] = [];
      const publishLocations = async () => {
        const updates: Array<CollabWorkingCopyLocationUpdate & { indexPath: string }> = [];
        const currentIndex = await projects.loadIndex();
        for (const projectId of held) {
          try {
            const membership = await projects.loadMembership(projectId);
            const entry = currentIndex.projects.find(project => project.id === projectId);
            if (!membership || !entry || (membership.lifecycle && membership.lifecycle !== 'active')
              || (entry.lifecycle && entry.lifecycle !== 'active')) continue;
            const pending = await projects.loadProjectDocument(projectId, 'pending-operation', decodeCollabPendingProjectOperation);
            if (pending) throw locationError('working-copy-setup-incomplete');
            const location = await this.#findLocation(membership);
            if (!location) {
              if (hint) throw locationError('working-copy-location-not-found');
              continue;
            }
            updates.push({ projectId, memberId: membership.member.id, expectedWorkspacePath: membership.project.workspacePath, workspacePath: location, indexPath: entry.workspacePath });
          } catch (error) { rememberFailure(error); }
        }
        // Only mutually dependent paths need one publication. A blocked group cannot stall unrelated renames.
        const key = (value: string) => value.normalize('NFC').toLocaleLowerCase('en-US');
        const remaining = [...updates];
        while (remaining.length) {
          const group = [remaining.shift()!];
          const paths = new Set<string>();
          for (let cursor = 0; cursor < group.length; cursor++) {
            for (const location of [group[cursor].indexPath, group[cursor].expectedWorkspacePath, group[cursor].workspacePath]) paths.add(key(location));
            for (let candidate = remaining.length - 1; candidate >= 0; candidate--) {
              const update = remaining[candidate];
              if ([update.indexPath, update.expectedWorkspacePath, update.workspacePath].some(location => paths.has(key(location)))) {
                group.push(...remaining.splice(candidate, 1));
              }
            }
          }
          try {
            await projects.updateWorkingCopyLocations(group);
            changed.push(...group.map(update => update.projectId));
          } catch (error) { rememberFailure(error); }
        }
      };
      // Keep all affected scopes until their index publication settles; ordinary writers may span several store calls.
      candidates.sort();
      const enter = async (cursor: number): Promise<void> => {
        if (cursor === candidates.length) { await publishLocations(); return; }
        let entered = false;
        try {
          await this.options.transitionProject(candidates[cursor], async () => {
            entered = true;
            held.push(candidates[cursor]);
            try { await enter(cursor + 1); } finally { held.pop(); }
          });
        } catch (error) {
          rememberFailure(error);
          if (!entered) await enter(cursor + 1);
        }
      };
      await enter(0);
      if (failure) throw failure;
      return changed;
    });
  }

  async #findLocation(membership: CollabLocalMembershipRecord): Promise<string | null> {
    const parent = path.posix.dirname(membership.project.workspacePath);
    const absoluteParent = await resolveCollabVaultPath(this.options.vaultRoot, parent, { mustExist: true });
    const directories = await readdir(absoluteParent, { withFileTypes: true });
    const matches: string[] = [];
    for (const directory of directories) {
      if (!directory.isDirectory() || directory.isSymbolicLink() || !isCollabWorkingCopyDirectoryName(directory.name)) continue;
      const relative = `${parent}/${directory.name}`;
      if (relative.length > 240) continue;
      if (!await this.#matches(relative, membership)) continue;
      matches.push(relative);
    }
    if (matches.length > 1) throw locationError('working-copy-location-ambiguous');
    if (matches.length === 0) return null;
    await this.foundation.local.workspace.resolveManagedProjectPath(matches[0]);
    return matches[0];
  }

  async #matches(relative: string, membership: CollabLocalMembershipRecord): Promise<boolean> {
    try {
      const absolute = await resolveCollabVaultPath(this.options.vaultRoot, relative);
      // Case-insensitive lookup alone cannot prove the spelling Obsidian uses in file events.
      if (!(await readdir(path.dirname(absolute))).includes(path.posix.basename(relative))) return false;
      const gitDirectory = await lstat(path.join(absolute, '.git'));
      if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) return false;
      const git = await this.foundation.requireGitFoundation();
      await git.repositories.assertLocalRepositoryIdentity(absolute, {
        projectId: membership.project.id, memberId: membership.member.id, personalRef: membership.member.personalRef,
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT'
        || (error instanceof CollabError && (error.code === 'repository-invalid' || error.code === 'workspace-boundary-invalid'))) return false;
      throw error;
    }
  }

}
