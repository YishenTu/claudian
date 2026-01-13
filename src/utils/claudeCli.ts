/**
 * Claudian - Claude CLI resolver
 *
 * Shared resolver for Claude CLI path detection across services.
 */

import * as fs from 'fs';

import {
  getCliPlatformKey,
  getHostnameKey,
  type HostnameCliPaths,
  type PlatformCliPaths,
} from '../core/types/settings';
import { parseEnvironmentVariables } from './env';
import { expandHomePath, findClaudeCLIPath } from './path';

export class ClaudeCliResolver {
  private resolvedPath: string | null = null;
  private lastHostnamePath = '';
  private lastPlatformPath = '';
  private lastLegacyPath = '';
  private lastEnvText = '';

  /**
   * Resolves CLI path with priority: hostname-specific -> platform-specific -> legacy -> auto-detect.
   * @param hostnamePaths Per-device CLI paths keyed by hostname (preferred)
   * @param platformPaths Platform-specific CLI paths (deprecated, kept for migration)
   * @param legacyPath Legacy claudeCliPath (for backwards compatibility)
   * @param envText Environment variables text
   */
  resolve(
    hostnamePaths: HostnameCliPaths | undefined,
    platformPaths: PlatformCliPaths | undefined,
    legacyPath: string | undefined,
    envText: string
  ): string | null {
    const hostnameKey = getHostnameKey();
    const platformKey = getCliPlatformKey();

    const hostnamePath = (hostnamePaths?.[hostnameKey] ?? '').trim();
    const platformPath = (platformPaths?.[platformKey] ?? '').trim();
    const normalizedLegacy = (legacyPath ?? '').trim();
    const normalizedEnv = envText ?? '';

    // Cache check
    if (
      this.resolvedPath &&
      hostnamePath === this.lastHostnamePath &&
      platformPath === this.lastPlatformPath &&
      normalizedLegacy === this.lastLegacyPath &&
      normalizedEnv === this.lastEnvText
    ) {
      return this.resolvedPath;
    }

    this.lastHostnamePath = hostnamePath;
    this.lastPlatformPath = platformPath;
    this.lastLegacyPath = normalizedLegacy;
    this.lastEnvText = normalizedEnv;

    // Resolution priority: hostname-specific -> platform-specific -> legacy -> auto-detect
    this.resolvedPath = resolveClaudeCliPath(hostnamePath, platformPath, normalizedLegacy, normalizedEnv);
    return this.resolvedPath;
  }

  reset(): void {
    this.resolvedPath = null;
    this.lastHostnamePath = '';
    this.lastPlatformPath = '';
    this.lastLegacyPath = '';
    this.lastEnvText = '';
  }
}

/**
 * Resolves CLI path with fallback chain.
 * @param hostnamePath Hostname-specific path for this device (preferred)
 * @param platformPath Platform-specific path for current OS
 * @param legacyPath Legacy claudeCliPath (backwards compatibility)
 * @param envText Environment variables text
 */
export function resolveClaudeCliPath(
  hostnamePath: string | undefined,
  platformPath: string | undefined,
  legacyPath: string | undefined,
  envText: string
): string | null {
  // Try hostname-specific path first (highest priority)
  const trimmedHostname = (hostnamePath ?? '').trim();
  if (trimmedHostname) {
    const expandedPath = expandHomePath(trimmedHostname);
    if (fs.existsSync(expandedPath)) {
      try {
        const stat = fs.statSync(expandedPath);
        if (stat.isFile()) {
          return expandedPath;
        }
      } catch {
        // Ignore and fall back to platform path.
      }
    }
  }

  // Try platform-specific path second
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

