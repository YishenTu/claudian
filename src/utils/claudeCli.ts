/**
 * Claudian - Claude CLI resolver
 *
 * Shared resolver for Claude CLI path detection across services.
 */

import * as fs from 'fs';

import { getCliPlatformKey, type PlatformCliPaths } from '../core/types/settings';
import { parseEnvironmentVariables } from './env';
import { expandHomePath, findClaudeCLIPath } from './path';

export class ClaudeCliResolver {
  private resolvedPath: string | null = null;
  private lastPlatformPath = '';
  private lastLegacyPath = '';
  private lastEnvText = '';

  /**
   * Resolves CLI path with priority: platform-specific -> legacy -> auto-detect.
   * Legacy fallback is only used when platform paths are not provided.
   * @param platformPaths Platform-specific CLI paths
   * @param legacyPath Legacy claudeCliPath (for backwards compatibility)
   * @param envText Environment variables text
   */
  resolve(
    platformPaths: PlatformCliPaths | undefined,
    legacyPath: string | undefined,
    envText: string
  ): string | null {
    const currentPlatformKey = getCliPlatformKey();
    const platformPath = (platformPaths?.[currentPlatformKey] ?? '').trim();
    const normalizedLegacy = platformPaths ? '' : (legacyPath ?? '').trim();
    const normalizedEnv = envText ?? '';

    // Cache check
    if (
      this.resolvedPath &&
      platformPath === this.lastPlatformPath &&
      normalizedLegacy === this.lastLegacyPath &&
      normalizedEnv === this.lastEnvText
    ) {
      return this.resolvedPath;
    }

    this.lastPlatformPath = platformPath;
    this.lastLegacyPath = normalizedLegacy;
    this.lastEnvText = normalizedEnv;

    // Resolution priority: platform-specific -> legacy -> auto-detect
    this.resolvedPath = resolveClaudeCliPath(platformPath, normalizedLegacy, normalizedEnv);
    return this.resolvedPath;
  }

  reset(): void {
    this.resolvedPath = null;
    this.lastPlatformPath = '';
    this.lastLegacyPath = '';
    this.lastEnvText = '';
  }
}

/**
 * Resolves CLI path with fallback chain.
 * @param platformPath Platform-specific path for current OS
 * @param legacyPath Legacy claudeCliPath (backwards compatibility)
 * @param envText Environment variables text
 */
export function resolveClaudeCliPath(
  platformPath: string | undefined,
  legacyPath: string | undefined,
  envText: string
): string | null {
  // Try platform-specific path first
  const trimmedPlatform = (platformPath ?? '').trim();
  if (trimmedPlatform) {
    const expandedPath = expandHomePath(trimmedPlatform);
    if (fs.existsSync(expandedPath)) {
      try {
        const stat = fs.statSync(expandedPath);
        if (stat.isFile()) {
          return expandedPath;
        }
      } catch {
        // Ignore and fall back to legacy path detection.
      }
    }
  }

  // Fall back to legacy path
  const trimmedLegacy = (legacyPath ?? '').trim();
  if (trimmedLegacy) {
    const expandedPath = expandHomePath(trimmedLegacy);
    if (fs.existsSync(expandedPath)) {
      try {
        const stat = fs.statSync(expandedPath);
        if (stat.isFile()) {
          return expandedPath;
        }
      } catch {
        // Ignore and fall back to auto-detection.
      }
    }
  }

  // Auto-detect
  const customEnv = parseEnvironmentVariables(envText || '');
  return findClaudeCLIPath(customEnv.PATH);
}
