import type { RewindFilesResult } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';

import type { ChatRewindMode, ChatRewindResult } from '../../../core/execution';

interface BackupEntry {
  originalPath: string;
  /** Absent when the path did not exist before the rewind. */
  backupPath?: string;
}

export interface ClaudeRewindBackup {
  restore: () => Promise<void>;
  cleanup: () => Promise<void>;
}

export interface ExecuteClaudeRewindDeps {
  executionTarget?: ExecutionTarget;
  assistantMessageId: string | undefined;
  mode: ChatRewindMode;
  rewindFiles: (userMessageId: string, dryRun?: boolean) => Promise<RewindFilesResult>;
  closePersistentQuery: () => void;
  vaultPath: string | null;
}

function resolveRewindFilePath(filePath: string, vaultPath: string | null, target?: ExecutionTarget): string {
  if (target?.method === 'wsl') {
    const mapper = createExecutionPathMapper(target);
    const cwd = vaultPath && mapper.toTargetPath(vaultPath);
    if (!path.posix.isAbsolute(filePath) && !cwd) throw new Error('Unable to resolve Claude rewind working directory');
    const hostPath = mapper.toHostPath(path.posix.resolve(cwd || '/', filePath));
    if (!hostPath) throw new Error('Unable to map Claude rewind path to the host');
    return hostPath;
  }
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  if (vaultPath) {
    return path.join(vaultPath, filePath);
  }
  return filePath;
}

/**
 * SDK file checkpointing performs the rewind, but a rewind that throws or declines
 * after partial writes leaves no SDK-side undo; this snapshot restores the pre-rewind state.
 */
export async function createClaudeRewindBackup(
  filesChanged: string[] | undefined,
  vaultPath: string | null,
): Promise<ClaudeRewindBackup | null> {
  if (!filesChanged || filesChanged.length === 0) {
    return null;
  }

  const backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-rewind-'));
  const entries: BackupEntry[] = [];
  let restoreFailed = false;
  const backupPathForIndex = (index: number) => path.join(backupRoot, String(index));

  for (let i = 0; i < filesChanged.length; i++) {
    const originalPath = resolveRewindFilePath(filesChanged[i], vaultPath);
    const backupPath = backupPathForIndex(i);
    try {
      // The SDK reports tracked regular files; copying follows links so restore writes back through them.
      await fs.copyFile(originalPath, backupPath);
      entries.push({ originalPath, backupPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A dangling link cannot be copied; leave it alone instead of deleting it on restore.
        if (!(await fs.lstat(originalPath).then(() => true, () => false))) entries.push({ originalPath });
        continue;
      }

      await fs.rm(backupRoot, { recursive: true, force: true });
      throw error;
    }
  }

  const restore = async () => {
    const errors: string[] = [];

    for (const entry of entries) {
      try {
        if (!entry.backupPath) {
          await fs.rm(entry.originalPath, { force: true });
          continue;
        }

        await fs.mkdir(path.dirname(entry.originalPath), { recursive: true });
        await fs.copyFile(entry.backupPath, entry.originalPath);
      } catch {
        errors.push(entry.backupPath
          ? `Recovery copy: ${entry.backupPath} -> ${entry.originalPath}`
          : `Restore prior absence by removing: ${entry.originalPath}`);
      }
    }

    restoreFailed = errors.length > 0;
    if (restoreFailed) {
      throw new Error(`Failed to restore ${errors.length} file(s) after rewind failure.\n${errors.join('\n')}\nBackup retained at: ${backupRoot}`);
    }
  };

  const cleanup = async () => {
    if (!restoreFailed) await fs.rm(backupRoot, { recursive: true, force: true });
  };

  return { restore, cleanup };
}

export async function executeClaudeRewind(
  userMessageId: string,
  deps: ExecuteClaudeRewindDeps,
): Promise<ChatRewindResult> {
  if (deps.mode === 'conversation') {
    if (deps.assistantMessageId) deps.closePersistentQuery();
    return { canRewind: true, filesChanged: [] };
  }

  const preview = await deps.rewindFiles(userMessageId, true);
  if (!preview.canRewind) {
    return preview;
  }

  const filesChanged = preview.filesChanged?.map(file => resolveRewindFilePath(file, deps.vaultPath, deps.executionTarget));
  const backup = await createClaudeRewindBackup(filesChanged, null);

  try {
    const result = await deps.rewindFiles(userMessageId);
    if (!result.canRewind) {
      await backup?.restore();
      deps.closePersistentQuery();
      return result;
    }

    if (deps.assistantMessageId) deps.closePersistentQuery();
    return {
      ...result,
      filesChanged,
      insertions: preview.insertions,
      deletions: preview.deletions,
    };
  } catch (error) {
    try {
      await backup?.restore();
    } catch (rollbackError) {
      deps.closePersistentQuery();
      throw new Error(
        `Rewind failed and files could not be fully restored: ${rollbackError instanceof Error ? rollbackError.message : 'Unknown error'}`,
        { cause: rollbackError },
      );
    }

    deps.closePersistentQuery();
    throw new Error(
      `Rewind failed but files were restored: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { cause: error },
    );
  } finally {
    await backup?.cleanup();
  }
}
