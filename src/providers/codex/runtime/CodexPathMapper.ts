import * as path from 'path';

import { createWslPathMapper as createSharedWslPathMapper } from '../../../utils/wslPathMapper';
import type { CodexExecutionTarget, CodexPathMapper } from './codexLaunchTypes';

function normalizeWindowsPath(value: string): string {
  if (!value) {
    return '';
  }

  let normalized = value.replace(/\//g, '\\');
  if (normalized.startsWith('\\\\?\\UNC\\')) {
    normalized = `\\\\${normalized.slice('\\\\?\\UNC\\'.length)}`;
  } else if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice('\\\\?\\'.length);
  }

  return path.win32.normalize(normalized);
}

function normalizePosixPath(value: string): string {
  if (!value) {
    return '';
  }

  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

function createIdentityMapper(target: CodexExecutionTarget): CodexPathMapper {
  const toTargetPath = (hostPath: string): string | null => {
    if (!hostPath) {
      return null;
    }

    return target.platformFamily === 'windows'
      ? normalizeWindowsPath(hostPath)
      : normalizePosixPath(hostPath);
  };
  const toHostPath = (targetPath: string): string | null => {
    if (!targetPath) {
      return null;
    }

    return target.platformFamily === 'windows'
      ? normalizeWindowsPath(targetPath)
      : normalizePosixPath(targetPath);
  };

  return {
    target,
    toTargetPath,
    toHostPath,
    mapTargetPathList(hostPaths: string[]): string[] {
      return hostPaths
        .map(toTargetPath)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
    },
    canRepresentHostPath(hostPath: string): boolean {
      return toTargetPath(hostPath) !== null;
    },
  };
}

function createWslPathMapper(target: CodexExecutionTarget): CodexPathMapper {
  const sharedMapper = createSharedWslPathMapper(target.distroName ?? '');
  const toTargetPath = (hostPath: string): string | null => {
    return sharedMapper.toWslPath(hostPath);
  };
  const toHostPath = (targetPath: string): string | null => {
    return sharedMapper.toHostPath(targetPath);
  };

  return {
    target,
    toTargetPath,
    toHostPath,
    mapTargetPathList(hostPaths: string[]): string[] {
      return hostPaths
        .map(toTargetPath)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
    },
    canRepresentHostPath(hostPath: string): boolean {
      return toTargetPath(hostPath) !== null;
    },
  };
}

export function createCodexPathMapper(target: CodexExecutionTarget): CodexPathMapper {
  return target.method === 'wsl'
    ? createWslPathMapper(target)
    : createIdentityMapper(target);
}
