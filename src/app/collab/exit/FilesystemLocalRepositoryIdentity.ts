import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import { collabMemberRef, isCollabMemberId, isCollabProjectId } from '@claudian-collab/protocol';

import type { LocalCleanupGitIdentityPort } from '@/app/collab/exit/LocalProjectCleanupCoordinator';
import type { GitLocalRepositoryIdentity } from '@/app/collab/git/GitRepositoryService';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const MAX_CONFIG_BYTES = 64 * 1024;

function identityError(reason: string): CollabError {
  return new CollabError({
    code: 'repository-invalid',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

/**
 * Verifies the Claudian-owned local Git identity without launching Native Git.
 * This narrow reader exists so a terminal Retired Project can detach its own
 * `.git` directory even after the user's Git installation becomes unavailable.
 */
export class FilesystemLocalRepositoryIdentity implements LocalCleanupGitIdentityPort {
  async assertLocalRepositoryIdentity(
    repositoryPath: string,
    expected: GitLocalRepositoryIdentity,
  ): Promise<void> {
    if (
      !isCollabMemberId(expected.memberId)
      || !isCollabProjectId(expected.projectId)
      || expected.personalRef !== collabMemberRef(expected.memberId)
    ) {
      throw identityError('collab-local-config-id-invalid');
    }
    const gitPath = path.join(repositoryPath, '.git');
    const configPath = path.join(gitPath, 'config');
    const gitStat = await lstat(gitPath).catch(() => null);
    if (!gitStat?.isDirectory() || gitStat.isSymbolicLink()) {
      throw identityError('collab-local-git-directory-invalid');
    }
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    const handle = await open(configPath, fsConstants.O_RDONLY | noFollow).catch(() => null);
    if (handle === null) throw identityError('collab-local-config-invalid');
    let serialized: string;
    try {
      const [before, pathStat, currentGitStat] = await Promise.all([
        handle.stat(),
        lstat(configPath),
        lstat(gitPath),
      ]).catch(() => {
        throw identityError('collab-local-config-invalid');
      });
      if (
        !before.isFile()
        || !pathStat.isFile()
        || pathStat.isSymbolicLink()
        || before.dev !== pathStat.dev
        || before.ino !== pathStat.ino
        || !currentGitStat.isDirectory()
        || currentGitStat.isSymbolicLink()
        || currentGitStat.dev !== gitStat.dev
        || currentGitStat.ino !== gitStat.ino
        || before.size > MAX_CONFIG_BYTES
      ) throw identityError('collab-local-config-invalid');
      const contents = await handle.readFile();
      const after = await handle.stat();
      if (
        contents.byteLength !== before.size
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
      ) throw identityError('collab-local-config-invalid');
      serialized = contents.toString('utf8');
    } finally {
      await handle.close().catch(() => undefined);
    }
    const values = parseClaudianConfig(serialized);
    const required: ReadonlyArray<readonly [string, string]> = [
      ['projectid', expected.projectId],
      ['memberid', expected.memberId],
      ['personalref', expected.personalRef],
    ];
    for (const [key, value] of required) {
      const configured = values.get(key);
      if (!configured || configured.length !== 1 || configured[0] !== value) {
        throw identityError('collab-local-config-mismatch');
      }
    }
  }
}

function parseClaudianConfig(contents: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let inClaudianSection = false;
  for (const sourceLine of contents.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      const match = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]$/.exec(line);
      if (!match) throw identityError('collab-local-config-invalid');
      inClaudianSection = match[1].toLocaleLowerCase('en-US') === 'claudian';
      continue;
    }
    if (!inClaudianSection) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw identityError('collab-local-config-invalid');
    const key = line.slice(0, separator).trim().toLocaleLowerCase('en-US');
    const value = line.slice(separator + 1).trim();
    if (!key || !value || value.startsWith('"') || value.endsWith('"')) {
      throw identityError('collab-local-config-invalid');
    }
    result.set(key, [...result.get(key) ?? [], value]);
  }
  return result;
}
