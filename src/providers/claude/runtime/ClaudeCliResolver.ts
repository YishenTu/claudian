/**
 * Claudian - Claude CLI resolver
 *
 * Shared resolver for Claude CLI path detection across services.
 */

import * as fs from 'fs';

import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { findClaudeCLIPath } from '../cli/findClaudeCLIPath';
import { type HostnameCliPaths } from '../types';

export class ClaudeCliResolver {
  private resolvedPath: string | null = null;
  private lastHostnamePath = '';
  private lastLegacyPath = '';
  private lastEnvText = '';
  // Cache hostname since it doesn't change during a session
  private readonly cachedHostname = getHostnameKey();

  /**
   * Resolves CLI path with priority: hostname-specific -> legacy -> auto-detect.
   * @param hostnamePaths Per-device CLI paths keyed by hostname (preferred)
   * @param legacyPath Legacy claudeCliPath (for backwards compatibility)
   * @param envText Environment variables text
   */
  resolve(
    hostnamePaths: HostnameCliPaths | undefined,
    legacyPath: string | undefined,
    envText: string
  ): string | null {
    const hostnameKey = this.cachedHostname;

    const hostnamePath = (hostnamePaths?.[hostnameKey] ?? '').trim();
    const normalizedLegacy = (legacyPath ?? '').trim();
    const normalizedEnv = envText ?? '';

    if (
      this.resolvedPath &&
      hostnamePath === this.lastHostnamePath &&
      normalizedLegacy === this.lastLegacyPath &&
      normalizedEnv === this.lastEnvText
    ) {
      return this.resolvedPath;
    }

    this.lastHostnamePath = hostnamePath;
    this.lastLegacyPath = normalizedLegacy;
    this.lastEnvText = normalizedEnv;

    this.resolvedPath = resolveClaudeCliPath(hostnamePath, normalizedLegacy, normalizedEnv);
    return this.resolvedPath;
  }

  reset(): void {
    this.resolvedPath = null;
    this.lastHostnamePath = '';
    this.lastLegacyPath = '';
    this.lastEnvText = '';
  }
}

/**
 * Resolves CLI path with fallback chain.
 * @param hostnamePath Hostname-specific path for this device (preferred)
 * @param legacyPath Legacy claudeCliPath (backwards compatibility)
 * @param envText Environment variables text
 */
export function resolveClaudeCliPath(
  hostnamePath: string | undefined,
  legacyPath: string | undefined,
  envText: string
): string | null {
  const trimmedHostname = (hostnamePath ?? '').trim();
  if (trimmedHostname) {
    try {
      const expandedPath = expandHomePath(trimmedHostname);
      if (fs.existsSync(expandedPath)) {
        const stat = fs.statSync(expandedPath);
        if (stat.isFile()) {
          return expandedPath;
        }
      }
    } catch {
      // Fall through to next resolution method
    }
  }

  const trimmedLegacy = (legacyPath ?? '').trim();
  if (trimmedLegacy) {
    try {
      const expandedPath = expandHomePath(trimmedLegacy);
      if (fs.existsSync(expandedPath)) {
        const stat = fs.statSync(expandedPath);
        if (stat.isFile()) {
          return expandedPath;
        }
      }
    } catch {
      // Fall through to auto-detect
    }
  }

  const customEnv = parseEnvironmentVariables(envText || '');
  return findClaudeCLIPath(customEnv.PATH);
}
