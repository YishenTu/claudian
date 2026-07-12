import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import type { ProviderConversationSessionAvailability } from '../../../core/providers/types';
import type { SDKNativeMessage, SDKSessionReadResult } from './sdkHistoryTypes';

export interface SDKSessionLocation {
  availability: ProviderConversationSessionAvailability;
  sessionPath?: string;
}

/**
 * Encodes a vault path for the SDK project directory name.
 * The SDK replaces ALL non-alphanumeric characters with `-`.
 * This handles Unicode characters and special chars.
 */
export function encodeVaultPathForSDK(vaultPath: string): string {
  const absolutePath = path.resolve(vaultPath);
  return absolutePath.replace(/[^a-zA-Z0-9]/g, '-');
}

export function getSDKProjectsPath(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Validates an identifier for safe use in filesystem paths (no traversal, bounded length). */
export function isPathSafeId(value: string): boolean {
  if (!value || value.length === 0 || value.length > 128) {
    return false;
  }
  if (value.includes('..') || value.includes('/') || value.includes('\\')) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

export function isValidSessionId(sessionId: string): boolean {
  return isPathSafeId(sessionId);
}

export function getSDKSessionPath(vaultPath: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }

  const projectsPath = getSDKProjectsPath();
  const encodedVault = encodeVaultPathForSDK(vaultPath);
  return path.join(projectsPath, encodedVault, `${sessionId}.jsonl`);
}

export function sdkSessionExists(vaultPath: string, sessionId: string): boolean {
  try {
    const sessionPath = getSDKSessionPath(vaultPath, sessionId);
    return existsSync(sessionPath);
  } catch {
    return false;
  }
}

/**
 * `size:mtimeMs` signature of a session transcript file, or null when it
 * cannot be read. Cheap change detection for transcripts that another
 * process may append to.
 */
export async function getSDKSessionSignature(
  vaultPath: string,
  sessionId: string,
  sessionPathOverride?: string,
): Promise<string | null> {
  try {
    const sessionPath = sessionPathOverride ?? getSDKSessionPath(vaultPath, sessionId);
    const stats = await fs.stat(sessionPath);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

function hasFileSystemErrorCode(error: unknown, code: string): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && error.code === code;
}

export async function locateSDKSessions(
  vaultPath: string,
  sessionIds: string[],
): Promise<Map<string, SDKSessionLocation>> {
  const locations = new Map<string, SDKSessionLocation>();
  const currentPaths = new Map<string, string>();
  const unresolvedIds = new Set<string>();

  await Promise.all([...new Set(sessionIds)].map(async (sessionId) => {
    let sessionPath: string;
    try {
      sessionPath = getSDKSessionPath(vaultPath, sessionId);
    } catch {
      locations.set(sessionId, { availability: 'unknown' });
      return;
    }

    currentPaths.set(sessionId, sessionPath);
    try {
      await fs.access(sessionPath);
      locations.set(sessionId, { availability: 'available', sessionPath });
    } catch (error) {
      if (hasFileSystemErrorCode(error, 'ENOENT')) {
        unresolvedIds.add(sessionId);
      } else {
        locations.set(sessionId, { availability: 'unknown' });
      }
    }
  }));

  if (unresolvedIds.size === 0) {
    return locations;
  }

  const targetIdsByFileName = new Map(
    [...unresolvedIds].map(sessionId => [`${sessionId}.jsonl`, sessionId]),
  );
  const pendingDirectories = [getSDKProjectsPath()];
  let rootExists = true;
  let scanComplete = true;

  while (pendingDirectories.length > 0 && unresolvedIds.size > 0) {
    const directory = pendingDirectories.shift()!;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === getSDKProjectsPath() && hasFileSystemErrorCode(error, 'ENOENT')) {
        rootExists = false;
      } else if (!hasFileSystemErrorCode(error, 'ENOENT')) {
        scanComplete = false;
      }
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile()) {
        const sessionId = targetIdsByFileName.get(entry.name);
        if (sessionId && unresolvedIds.has(sessionId)) {
          const availability = entryPath === currentPaths.get(sessionId)
            ? 'available'
            : 'relocated';
          locations.set(sessionId, { availability, sessionPath: entryPath });
          unresolvedIds.delete(sessionId);
        }
      } else if (entry.isDirectory() && entry.name !== 'subagents') {
        pendingDirectories.push(entryPath);
      } else if (!entry.isDirectory()) {
        // Do not follow symlinks or special files during a global history scan.
        // Their contents remain unverified, so absence cannot be definitive.
        scanComplete = false;
      }
    }
  }

  for (const sessionId of unresolvedIds) {
    locations.set(sessionId, {
      availability: rootExists && scanComplete ? 'missing' : 'unknown',
    });
  }

  return locations;
}

export async function locateSDKSession(
  vaultPath: string,
  sessionId: string,
): Promise<SDKSessionLocation> {
  return (await locateSDKSessions(vaultPath, [sessionId])).get(sessionId)
    ?? { availability: 'unknown' };
}

export async function getSDKSessionAvailability(
  vaultPath: string,
  sessionId: string,
): Promise<ProviderConversationSessionAvailability> {
  return (await locateSDKSession(vaultPath, sessionId)).availability;
}

export async function deleteSDKSession(vaultPath: string, sessionId: string): Promise<void> {
  try {
    const sessionPath = getSDKSessionPath(vaultPath, sessionId);
    if (!existsSync(sessionPath)) {
      return;
    }

    await fs.unlink(sessionPath);
  } catch {
    // Best-effort deletion
  }
}

export async function readSDKSession(
  vaultPath: string,
  sessionId: string,
): Promise<SDKSessionReadResult> {
  try {
    const sessionPath = getSDKSessionPath(vaultPath, sessionId);
    if (!existsSync(sessionPath)) {
      return { messages: [], skippedLines: 0 };
    }
    return readSDKSessionFile(sessionPath);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { messages: [], skippedLines: 0, error: errorMsg };
  }
}

export async function readSDKSessionFile(sessionPath: string): Promise<SDKSessionReadResult> {
  try {
    const content = await fs.readFile(sessionPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const messages: SDKNativeMessage[] = [];
    let skippedLines = 0;

    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as SDKNativeMessage);
      } catch {
        skippedLines++;
      }
    }

    return { messages, skippedLines };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { messages: [], skippedLines: 0, error: errorMsg };
  }
}
